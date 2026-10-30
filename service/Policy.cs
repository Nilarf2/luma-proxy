using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using YamlDotNet.RepresentationModel;

static class ConfigPolicy {
    static readonly HashSet<string> AllowedRoot = new(StringComparer.Ordinal) { "mixed-port", "port", "socks-port", "redir-port", "tproxy-port", "allow-lan", "bind-address", "mode", "log-level", "ipv6", "unified-delay", "tcp-concurrent", "find-process-mode", "global-client-fingerprint", "keep-alive-interval", "keep-alive-idle", "disable-keep-alive", "profile", "hosts", "dns", "tun", "sniffer", "proxies", "proxy-groups", "proxy-providers", "rule-providers", "rules", "sub-rules", "geodata-mode", "geodata-loader", "geo-auto-update", "geo-update-interval", "geox-url", "global-ua", "etag-support", "interface-name", "routing-mark", "external-controller", "secret", "authentication", "skip-auth-prefixes", "lan-allowed-ips", "lan-disallowed-ips", "listeners", "tunnels" };
    public static string Rewrite(string text, string dir, int controller, string secret, Dictionary<string, string>? protectedProviders = null, Dictionary<string, string>? localProviders = null) {
        if (text.Length > 8 * 1024 * 1024) throw new IOException("Config too large"); var yaml = new YamlStream(); yaml.Load(new StringReader(text));
        if (yaml.Documents.Count != 1 || yaml.Documents[0].RootNode is not YamlMappingNode root) throw new IOException("One YAML mapping required");
        foreach (var key in root.Children.Keys.ToArray()) { var name = (key as YamlScalarNode)?.Value ?? throw new IOException("Invalid root key"); if (!AllowedRoot.Contains(name)) throw new IOException("Unsupported privileged config option: " + name); }
        // No caller-selected listeners/controllers. Proxy listener ports themselves remain configurable.
        foreach (var key in new[] { "listeners", "tunnels", "external-controller", "secret" }) root.Children.Remove(new YamlScalarNode(key));
        foreach (var section in new[] { "proxy-providers", "rule-providers" }) if (root.Children.TryGetValue(new YamlScalarNode(section), out var providers)) {
            if (providers is not YamlMappingNode map) throw new IOException("Invalid provider mapping");
            foreach (var entry in map.Children) {
                if (entry.Value is not YamlMappingNode provider) throw new IOException("Invalid provider");
                var type = (provider.Children.TryGetValue(new YamlScalarNode("type"), out var typeNode) ? typeNode.ToString() : null); if (type != "http" && type != "inline" && type != "file") throw new IOException("Privileged service supports only HTTP or inline providers");
                if (type == "file") { var submitted = provider.Children.TryGetValue(new YamlScalarNode("path"), out var localPath) ? localPath.ToString() : ""; if (localProviders == null || !localProviders.TryGetValue(submitted, out var protectedPath)) throw new IOException("Local provider asset was not submitted"); provider.Children[new YamlScalarNode("path")] = new YamlScalarNode(protectedPath); continue; }
                if (type == "http" && section == "proxy-providers") { if (protectedProviders == null || !protectedProviders.TryGetValue(entry.Key.ToString(), out var providerPath)) throw new IOException("Proxy provider was not validated"); provider.Children[new YamlScalarNode("type")] = new YamlScalarNode("file"); provider.Children.Remove(new YamlScalarNode("url")); provider.Children.Remove(new YamlScalarNode("interval")); provider.Children[new YamlScalarNode("path")] = new YamlScalarNode(providerPath); continue; }
                if (type == "http") { var url = (provider.Children.TryGetValue(new YamlScalarNode("url"), out var urlNode) ? urlNode.ToString() : ""); RequireHttp(url); }
                var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(section + ":" + entry.Key)));
                provider.Children[new YamlScalarNode("path")] = new YamlScalarNode(Path.Combine(dir, "cache", hash + ".yaml"));
            }
        }
        ValidateTree(root, dir, 0);
        root.Children[new YamlScalarNode("external-controller")] = new YamlScalarNode("127.0.0.1:" + controller);
        root.Children[new YamlScalarNode("secret")] = new YamlScalarNode(secret);
        Directory.CreateDirectory(Path.Combine(dir, "cache"));
        using var output = new StringWriter(); yaml.Save(output, false); return output.ToString();
    }
    public static string LocalProviderContent(string text, string dir) {
        if (text.Length > 8 * 1024 * 1024) throw new IOException("Provider too large"); var yaml = new YamlStream(); yaml.Load(new StringReader(text));
        if (yaml.Documents.Count != 1 || yaml.Documents[0].RootNode is not YamlMappingNode root || root.Children.Count != 1) throw new IOException("Local provider must contain a single proxies or payload list");
        if (root.Children.ContainsKey(new YamlScalarNode("proxies"))) return ProviderContent(text, dir);
        if (!root.Children.TryGetValue(new YamlScalarNode("payload"), out var payload) || payload is not YamlSequenceNode sequence || sequence.Children.Any(n => n is not YamlScalarNode)) throw new IOException("Local rule provider must contain scalar payload");
        using var output = new StringWriter(); yaml.Save(output, false); return output.ToString();
    }
    public static Dictionary<string, (string Url, int Interval)> ProxyProviderSources(string text) {
        var yaml = new YamlStream(); yaml.Load(new StringReader(text)); var result = new Dictionary<string, (string Url, int Interval)>();
        if (yaml.Documents.Count != 1 || yaml.Documents[0].RootNode is not YamlMappingNode root) throw new IOException("Invalid config");
        if (root.Children.TryGetValue(new YamlScalarNode("proxy-providers"), out var node) && node is YamlMappingNode map) foreach (var entry in map.Children) {
            if (entry.Value is YamlMappingNode provider && provider.Children.TryGetValue(new YamlScalarNode("type"), out var type) && type.ToString() == "http") { var url = provider.Children.TryGetValue(new YamlScalarNode("url"), out var address) ? address.ToString() : ""; RequireBridge(url); var interval = 0; if (provider.Children.TryGetValue(new YamlScalarNode("interval"), out var configured) && (!int.TryParse(configured.ToString(), out interval) || interval < 0)) throw new IOException("Invalid provider interval"); result[entry.Key.ToString()] = (url, interval); }
        } return result;
    }
    public static string ProviderContent(string text, string dir) {
        if (text.Length > 8 * 1024 * 1024) throw new IOException("Provider too large"); var yaml = new YamlStream(); yaml.Load(new StringReader(text));
        if (yaml.Documents.Count != 1 || yaml.Documents[0].RootNode is not YamlMappingNode root || root.Children.Count != 1 || !root.Children.TryGetValue(new YamlScalarNode("proxies"), out var proxies) || proxies is not YamlSequenceNode) throw new IOException("Service proxy providers require YAML proxies");
        ValidateTree(root, dir, 0); using var output = new StringWriter(); yaml.Save(output, false); return output.ToString();
    }
    static void RequireBridge(string value) { if (!Regex.IsMatch(value, @"\Ahttp://127\.0\.0\.1:[0-9]{1,5}/luma-provider/[a-f0-9]{64}/[a-f0-9]{64}\z") || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Port < 1 || uri.Port > 65535) throw new IOException("Proxy providers require an authenticated local bridge"); }
    static void RequireHttp(string value) { if (!Uri.TryCreate(value, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https") || !string.IsNullOrEmpty(u.UserInfo)) throw new IOException("Only HTTP(S) URLs without user info are allowed"); }
    static void ValidateTree(YamlNode node, string dir, int depth, string context = "") {
        if (depth > 40) throw new IOException("Configuration nesting too deep");
        if (node is YamlMappingNode map) foreach (var pair in map.Children) {
            var key = (pair.Key as YamlScalarNode)?.Value ?? throw new IOException("Invalid key");
            if (key == "path" && context is not ("ws-opts" or "http-opts" or "h2-opts" or "grpc-opts")) { var value = pair.Value.ToString(); if (!value.StartsWith(Path.Combine(dir, "cache") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || Path.GetFullPath(value) != value) throw new IOException("File paths outside protected cache are forbidden"); }
            else if (key.Contains("file", StringComparison.OrdinalIgnoreCase) && key != "profile" && key != "find-process-mode") throw new IOException("File config options forbidden in service mode");
            else if (key is "certificate" or "private-key-file" or "ca" or "ca-file" or "client-cert" or "client-key" or "external-ui" or "external-ui-url" or "external-controller-pipe" or "external-controller-unix" or "external-controller-tls" or "script" or "command" or "exec") throw new IOException("Privileged file/executable option forbidden");
            // Prevent alternate path-bearing fields from becoming privileged arbitrary file access.
            else if (key.Contains("path", StringComparison.OrdinalIgnoreCase) && key is not ("path")) { if (key != "ws-path") throw new IOException("Unsupported path-bearing option"); }
            ValidateTree(pair.Value, dir, depth + 1, key);
        } else if (node is YamlSequenceNode sequence) foreach (var child in sequence.Children) ValidateTree(child, dir, depth + 1, context);
    }
}

static class ApiPolicy {
    public static void Validate(string endpoint, string method, JsonNode? data) {
        if (endpoint.Length > 8192 || !endpoint.StartsWith('/') || endpoint.Contains('#') || endpoint.Contains('\\') || endpoint.Contains("..")) throw new UnauthorizedAccessException("Invalid API path");
        var path = endpoint.Split('?')[0]; var decoded = Uri.UnescapeDataString(path); if (decoded.Contains("..") || decoded.Contains('\\') || decoded.Count(c => c == '/') != path.Count(c => c == '/')) throw new UnauthorizedAccessException("Encoded API path denied");
        if (method == "GET" && (path is "/version" or "/configs" or "/proxies" or "/connections" or "/rules" or "/providers/proxies" or "/providers/rules" || Regex.IsMatch(path, @"^/(proxies|providers/proxies|providers/rules)/[^/]+(/(delay|healthcheck))?$"))) return;
        if (method == "DELETE" && (path == "/connections" || Regex.IsMatch(path, @"^/connections/[^/]+$"))) return;
        if (method == "PUT" && Regex.IsMatch(path, @"^/providers/(proxies|rules)/[^/]+$")) { if (data != null) throw new UnauthorizedAccessException(); return; }
        if (method == "POST" && path is "/cache/fakeip/flush" or "/cache/dns/flush" && data == null) return;
        if (method == "PUT" && Regex.IsMatch(path, @"^/proxies/[^/]+$") && data is JsonObject node && node.Count == 1 && node["name"]?.GetValue<string>().Length is > 0 and < 2048) return;
        if (method == "PATCH" && path == "/configs" && data is JsonObject settings && settings.Count > 0) {
            foreach (var pair in settings) {
                if (pair.Key == "mode" && pair.Value?.GetValue<string>() is "rule" or "global" or "direct") continue;
                if (pair.Key == "log-level" && pair.Value?.GetValue<string>() is "silent" or "error" or "warning" or "info" or "debug") continue;
                // Enabling TUN is permitted only from the already validated runtime configuration.
                if (pair.Key == "tun" && pair.Value is JsonObject tun && tun.Count == 1 && tun["enable"] is JsonValue flag && flag.TryGetValue<bool>(out _)) continue;
                throw new UnauthorizedAccessException("Unsupported config mutation");
            } return;
        }
        throw new UnauthorizedAccessException("API endpoint denied");
    }
}
