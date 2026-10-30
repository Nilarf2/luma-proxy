using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using YamlDotNet.RepresentationModel;

static class Program {
    public const string Name = "LumaProxyService";
    public static readonly string InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Luma", "Service");
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static int Main(string[] args) {
        try {
            if (args.SequenceEqual(new[] { "--service" })) { ServiceBase.Run(new Broker()); return 0; }
            if (args.Length == 3 && args[0] == "--install") { Install(args[1], int.Parse(args[2])); return 0; }
            if (args.Length == 3 && args[0] == "--uninstall") { Uninstall(args[1], int.Parse(args[2])); return 0; }
            throw new InvalidOperationException("Unsupported helper command");
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    static void RequireAdmin(string sid, int ownerPid) {
        using var id = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator) || !System.Text.RegularExpressions.Regex.IsMatch(sid, @"^S-1-5-21-\d+-\d+-\d+-\d+$") || ownerPid <= 0) throw new UnauthorizedAccessException("Administrator approval and a real desktop owner are required");
        using var owner = Process.GetProcessById(ownerPid); if (!OpenProcessToken(owner.Handle, 8, out var token)) throw new UnauthorizedAccessException("Cannot verify desktop owner");
        using (token) using (var identity = new WindowsIdentity(token.DangerousGetHandle())) if (identity.User?.Value != sid || owner.HasExited) throw new UnauthorizedAccessException("Desktop owner identity mismatch");
    }
    static void NoLinks(string path) {
        for (var p = new DirectoryInfo(path); p != null; p = p.Parent) if (p.Exists && p.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Reparse points are not allowed");
    }
    static void SecureDirectory(string dir, bool allowRead = true) {
        NoLinks(dir); Directory.CreateDirectory(dir); var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
        foreach (var sid in new[] { new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) }) acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        // Read/execute permits the normal desktop account to invoke only the fixed elevated helper.
        if (allowRead) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(dir).SetAccessControl(acl);
    }
    static void Sc(params string[] args) { using var p = Process.Start(new ProcessStartInfo { FileName = Path.Combine(Environment.SystemDirectory, "sc.exe"), UseShellExecute = false, CreateNoWindow = true, ArgumentList = { } }.WithArgs(args))!; p.WaitForExit(); if (p.ExitCode != 0) throw new IOException("Windows service operation failed (" + p.ExitCode + ")"); }
    static ProcessStartInfo WithArgs(this ProcessStartInfo p, string[] args) { foreach (var a in args) p.ArgumentList.Add(a); return p; }
    static void Install(string sid, int ownerPid) {
        RequireAdmin(sid, ownerPid); var source = AppContext.BaseDirectory; NoLinks(source); NoLinks(InstallDir);
        var core = Path.GetFullPath(Path.Combine(source, "..", "core", "mihomo.exe")); NoLinks(Path.GetDirectoryName(core)!); if (File.Exists(core) && File.GetAttributes(core).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Core reparse point rejected");
        if (!File.Exists(core) || !File.Exists(Path.Combine(source, "Luma.Service.exe"))) throw new IOException("Bundled service/core missing");
        if (ServiceController.GetServices().Any(s => s.ServiceName == Name)) throw new IOException("Service already installed; remove it first");
        if (Directory.Exists(InstallDir) && Directory.EnumerateFileSystemEntries(InstallDir).Any()) throw new IOException("Existing service directory requires explicit cleanup by an administrator");
        SecureDirectory(InstallDir); File.Copy(Path.Combine(source, "Luma.Service.exe"), Path.Combine(InstallDir, "Luma.Service.exe"), true); File.Copy(core, Path.Combine(InstallDir, "mihomo.exe"), true);
        File.WriteAllText(Path.Combine(InstallDir, "owner.txt"), sid); SecureDirectory(Path.Combine(InstallDir, "Data"), false);
        Sc("create", Name, "binPath=", "\"" + Path.Combine(InstallDir, "Luma.Service.exe") + "\" --service", "start=", "auto", "obj=", "LocalSystem", "DisplayName=", "Luma Protected Proxy Service");
        try { Sc("start", Name); } catch { try { Sc("delete", Name); } catch {} throw; }
    }
    static void Uninstall(string sid, int ownerPid) {
        RequireAdmin(sid, ownerPid); NoLinks(InstallDir); if (File.ReadAllText(Path.Combine(InstallDir, "owner.txt")).Trim() != sid) throw new UnauthorizedAccessException("Service belongs to another account");
        using (var controller = new ServiceController(Name)) { if (controller.Status != ServiceControllerStatus.Stopped) { controller.Stop(); controller.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20)); } }
        Sc("delete", Name); Exception? failure = null; for (var i = 0; i < 20; i++) { try { Directory.Delete(InstallDir, true); return; } catch (IOException e) { failure = e; Thread.Sleep(250); } } throw new IOException("Service removed but protected files remain; retry cleanup as administrator", failure);
    }
    public static void CheckProtected() { NoLinks(InstallDir); if (!Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar).Equals(InstallDir, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Service must run from protected installation"); }
}

sealed class Broker : ServiceBase {
    CancellationTokenSource? cancel; NamedPipeServerStream? serverPipe; CoreJob? lifetimeJob; Process? core; Process? owner; string sid = "", secret = ""; int controller; readonly List<string> logs = new(); readonly object gate = new(); readonly Dictionary<string, (string Url, string Path)> providers = new(); readonly HttpClient http = new(new HttpClientHandler { UseProxy = false });
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    public Broker() { ServiceName = Program.Name; CanStop = true; AutoLog = true; }
    protected override void OnStart(string[] args) { Program.CheckProtected(); sid = File.ReadAllText(Path.Combine(Program.InstallDir, "owner.txt")).Trim(); _ = new SecurityIdentifier(sid); lifetimeJob = new CoreJob(); lifetimeJob.Assign(Process.GetCurrentProcess().Handle); var acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false); acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite, AccessControlType.Allow)); acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        serverPipe = NamedPipeServerStreamAcl.Create("Luma.Proxy." + sid, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance, 16384, 16384, acl);
        cancel = new(); _ = Serve(serverPipe, cancel.Token); _ = WatchOwner(cancel.Token); }
    protected override void OnStop() { cancel?.Cancel(); serverPipe?.Dispose(); StopCore(); }
    async Task WatchOwner(CancellationToken token) { try { while (!token.IsCancellationRequested) { await Task.Delay(750, token); lock (gate) { if (core != null && (owner == null || owner.HasExited)) StopCore(); } } } catch (OperationCanceledException) {} }
    void StopCore() { lock (gate) { if (core != null) { try { if (!core.HasExited) { core.Kill(true); core.WaitForExit(5000); } } catch {} core.Dispose(); core = null; } owner?.Dispose(); owner = null; } }
    async Task Serve(NamedPipeServerStream pipe, CancellationToken token) {
        while (!token.IsCancellationRequested) {
            try {
                await pipe.WaitForConnectionAsync(token);
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out var clientPid)) throw new UnauthorizedAccessException("Client identity rejected");
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(30));
                var data = new MemoryStream(); var one = new byte[16384]; bool complete = false;
                while (!complete) { var n = await pipe.ReadAsync(one, deadline.Token); if (n == 0) throw new IOException("Incomplete request"); var newline = Array.IndexOf(one, (byte)10, 0, n); data.Write(one, 0, newline < 0 ? n : newline); if (data.Length > 24 * 1024 * 1024) throw new IOException("Request too large"); complete = newline >= 0; }
                var clientSid = ""; pipe.RunAsClient(() => { using var identity = WindowsIdentity.GetCurrent(true); clientSid = identity?.User?.Value ?? ""; }); if (clientSid != sid) throw new UnauthorizedAccessException("Client identity rejected");
                JsonObject result; try { var req = JsonNode.Parse(data.ToArray())?.AsObject() ?? throw new IOException("Invalid request"); result = new() { ["ok"] = true, ["data"] = await Dispatch(req, checked((int)clientPid), deadline.Token) }; } catch (Exception e) { result = new() { ["ok"] = false, ["error"] = e is UnauthorizedAccessException ? "Service request denied" : "Service operation failed: " + e.Message }; }
                var output = Encoding.UTF8.GetBytes(result.ToJsonString() + "\n"); await pipe.WriteAsync(output, deadline.Token);
                // Wait for client close/ack before disconnecting; otherwise Windows may discard unread response bytes.
                await pipe.ReadAsync(new byte[1], deadline.Token);
            } catch (OperationCanceledException) when (token.IsCancellationRequested) { break; } catch { /* A malformed/disconnected client must not stop protection. */ } finally { try { if (pipe.IsConnected) pipe.Disconnect(); } catch {} }
        }
    }
    async Task<JsonNode?> Dispatch(JsonObject req, int clientPid, CancellationToken token) {
        var action = req["action"]?.GetValue<string>();
        if (action == "status") { lock (gate) return JsonSerializer.SerializeToNode(new { installed = true, running = true, coreRunning = core != null && !core.HasExited, pid = core != null && !core.HasExited ? (int?)core.Id : null }, Program.Json); }
        if (action == "logs") { lock (gate) return JsonSerializer.SerializeToNode(logs.ToArray()); }
        if (action == "stop") { EnsureOwner(clientPid); StopCore(); return null; }
        if (action == "start") {
            var supplied = req["ownerPid"]?.GetValue<int>(); if (supplied != clientPid) throw new UnauthorizedAccessException(); EnsureOwner(clientPid);
            using var requestedOwner = Process.GetProcessById(clientPid); var requestedStarted = requestedOwner.StartTime; _ = requestedOwner.Handle;
            var text = req["config"]?.GetValue<string>() ?? throw new IOException("Config missing"); StopCore();
            secret = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)); controller = FreePort(); var dir = Path.Combine(Program.InstallDir, "Data");
            var localProviders = new Dictionary<string, string>(); if (req["providers"] is JsonObject submitted) { if (submitted.Count > 128) throw new IOException("Too many provider assets"); var total = 0; foreach (var entry in submitted) { if (!System.Text.RegularExpressions.Regex.IsMatch(entry.Key, @"^\./providers/[a-f0-9]{64}\.yaml$")) throw new IOException("Invalid provider asset path"); var content = entry.Value?.GetValue<string>() ?? throw new IOException("Invalid provider asset"); total += Encoding.UTF8.GetByteCount(content); if (total > 8 * 1024 * 1024) throw new IOException("Provider assets too large"); var protectedPath = Path.Combine(dir, "cache", Path.GetFileName(entry.Key)); Directory.CreateDirectory(Path.GetDirectoryName(protectedPath)!); File.WriteAllText(protectedPath, ConfigPolicy.LocalProviderContent(content, dir)); localProviders[entry.Key] = protectedPath; } }
            providers.Clear(); var paths = new Dictionary<string, string>(); foreach (var entry in ConfigPolicy.ProxyProviderSources(text)) { var providerPath = Path.Combine(dir, "cache", Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("proxy-providers:" + entry.Key))) + ".yaml"); Directory.CreateDirectory(Path.GetDirectoryName(providerPath)!); providers[entry.Key] = (entry.Value, providerPath); await RefreshProvider(entry.Key, token); paths[entry.Key] = providerPath; }
            var safe = ConfigPolicy.Rewrite(text, dir, controller, secret, paths, localProviders); File.WriteAllText(Path.Combine(dir, "runtime.yaml"), safe);
            var p = new Process { StartInfo = new() { FileName = Path.Combine(Program.InstallDir, "mihomo.exe"), WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } }; foreach (var arg in new[] { "-d", dir, "-f", Path.Combine(dir, "runtime.yaml") }) p.StartInfo.ArgumentList.Add(arg);
            p.StartInfo.Environment.Remove("SAFE_PATHS"); p.OutputDataReceived += Record; p.ErrorDataReceived += Record;
            lock (gate) { if (requestedOwner.HasExited) throw new IOException("Owner exited before core start"); owner = Process.GetProcessById(clientPid); if (owner.StartTime != requestedStarted) { owner.Dispose(); owner = null; throw new UnauthorizedAccessException("Owner identity changed"); } _ = owner.Handle; core = p; try { p.Start(); p.BeginOutputReadLine(); p.BeginErrorReadLine(); } catch { StopCore(); throw; } }
            return new JsonObject { ["pid"] = p.Id };
        }
        if (action == "api") { EnsureOwner(clientPid); if (core == null || core.HasExited) throw new IOException("Core stopped"); var method = req["method"]?.GetValue<string>() ?? "GET"; var endpoint = req["endpoint"]?.GetValue<string>() ?? ""; var body = req["data"]; ApiPolicy.Validate(endpoint, method, body); if (method == "PUT" && endpoint.StartsWith("/providers/proxies/")) { var name = Uri.UnescapeDataString(endpoint["/providers/proxies/".Length..]); if (providers.ContainsKey(name)) await RefreshProvider(name, token); } using var message = new HttpRequestMessage(new HttpMethod(method), "http://127.0.0.1:" + controller + endpoint); message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret); if (body != null) message.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"); using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, token); if (!response.IsSuccessStatusCode) throw new IOException("Core API returned " + (int)response.StatusCode); var output = await BoundedText(response.Content, token); var json = string.IsNullOrWhiteSpace(output) ? null : JsonNode.Parse(output); if (endpoint == "/configs" && json is JsonObject obj) foreach (var key in new[] { "secret", "external-controller", "external-controller-tls", "external-controller-pipe", "external-controller-unix" }) obj.Remove(key); return json; }
        throw new UnauthorizedAccessException("Unsupported service action");
    }
    static async Task<string> BoundedText(HttpContent content, CancellationToken token) {
        if (content.Headers.ContentLength > 8 * 1024 * 1024) throw new IOException("Core response too large"); using var stream = await content.ReadAsStreamAsync(token); using var buffer = new MemoryStream(); var chunk = new byte[16384]; int size;
        while ((size = await stream.ReadAsync(chunk, token)) > 0) { buffer.Write(chunk, 0, size); if (buffer.Length > 8 * 1024 * 1024) throw new IOException("Core response too large"); } return Encoding.UTF8.GetString(buffer.ToArray());
    }
    async Task RefreshProvider(string name, CancellationToken token) {
        var entry = providers[name]; using var response = await http.GetAsync(entry.Url, HttpCompletionOption.ResponseHeadersRead, token); response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > 8 * 1024 * 1024) throw new IOException("Provider too large"); using var stream = await response.Content.ReadAsStreamAsync(token); using var buffer = new MemoryStream(); var chunk = new byte[16384]; int size;
        while ((size = await stream.ReadAsync(chunk, token)) > 0) { buffer.Write(chunk, 0, size); if (buffer.Length > 8 * 1024 * 1024) throw new IOException("Provider too large"); }
        var safe = ConfigPolicy.ProviderContent(Encoding.UTF8.GetString(buffer.ToArray()), Path.Combine(Program.InstallDir, "Data")); var temp = entry.Path + ".tmp"; File.WriteAllText(temp, safe); File.Move(temp, entry.Path, true);
    }
    void EnsureOwner(int pid) { lock (gate) if (owner != null && !owner.HasExited && (owner.Id != pid || Process.GetProcessById(pid).StartTime != owner.StartTime)) throw new UnauthorizedAccessException("Another app owns the core"); }
    void Record(object sender, DataReceivedEventArgs e) { if (e.Data == null) return; var line = System.Text.RegularExpressions.Regex.Replace(e.Data, @"https?://[^\s""']+", "[URL]"); lock (gate) { logs.Add(line[..Math.Min(line.Length, 1200)]); if (logs.Count > 500) logs.RemoveAt(0); } }
    static int FreePort() { var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0); l.Start(); var p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }
}
