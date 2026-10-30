using System.Text.Json.Nodes;
using YamlDotNet.RepresentationModel;
var passed = 0;
void Check(string name, Action action) { action(); Console.WriteLine("PASS " + name); passed++; }
void Denied(Action action) { try { action(); } catch (Exception e) when (e is UnauthorizedAccessException or IOException) { return; } throw new Exception("Unsafe input was accepted"); }
var dir = Path.Combine(Path.GetTempPath(), "luma-service-policy-" + Guid.NewGuid());
try {
    Check("fixed private controller replaces caller credentials", () => { var result = ConfigPolicy.Rewrite("proxies: []\nexternal-controller: 0.0.0.0:9090\nsecret: public\n", dir, 32123, "private"); if (!result.Contains("127.0.0.1:32123") || result.Contains("public")) throw new Exception(result); });
    Check("LAN intent retained", () => { if (!ConfigPolicy.Rewrite("allow-lan: true\nbind-address: '*'\nproxies: []", dir, 1, "x").Contains("allow-lan: true")) throw new Exception(); });
    Check("unknown root fails closed", () => Denied(() => ConfigPolicy.Rewrite("arbitrary-new-file-option: danger", dir, 1, "x")));
    Check("arbitrary provider file denied", () => Denied(() => ConfigPolicy.Rewrite("proxy-providers: {p: {type: file, path: C:/Windows/secrets}}", dir, 1, "x")));
    Check("submitted local provider becomes protected cache asset", () => { var name = "./providers/" + new string('a', 64) + ".yaml"; var result = ConfigPolicy.Rewrite("proxy-providers: {p: {type: file, path: '" + name + "'}}", dir, 1, "x", null, new() { [name] = Path.Combine(dir, "cache", "local.yaml") }); if (result.Contains("./providers/")) throw new Exception(result); });
    Check("local rule provider payload accepted", () => ConfigPolicy.LocalProviderContent("payload: [example.invalid]", dir));
    Check("local provider invalid root rejected", () => Denied(() => ConfigPolicy.LocalProviderContent("arbitrary: []", dir)));
    Check("HTTP proxy provider requires validation", () => Denied(() => ConfigPolicy.Rewrite("proxy-providers: {p: {type: http, url: https://example.invalid/a}}", dir, 1, "x")));
    Check("validated proxy provider becomes protected local file", () => { var result = ConfigPolicy.Rewrite("proxy-providers: {p: {type: http, url: https://example.invalid/a, path: ../../bad}}", dir, 1, "x", new() { ["p"] = Path.Combine(dir, "cache", "safe.yaml") }); if (!result.Contains("type: file") || result.Contains("example.invalid")) throw new Exception(result); });
    Check("rule provider cache path rewritten", () => { var result = ConfigPolicy.Rewrite("rule-providers: {r: {type: http, url: https://example.invalid/r, path: ../../bad}}", dir, 1, "x"); if (result.Contains("../../bad")) throw new Exception(); });
    Check("HTTP provider URL protocol constrained", () => Denied(() => ConfigPolicy.ProxyProviderSources("proxy-providers: {p: {type: http, url: file:///C:/Windows/secrets}}")));
    Check("remote proxy provider content inspected", () => Denied(() => ConfigPolicy.ProviderContent("proxies: [{name: x, type: http, ca-file: C:/Windows/secrets}]", dir)));
    Check("provider arbitrary root rejected", () => Denied(() => ConfigPolicy.ProviderContent("proxies: []\nexternal-controller: 0.0.0.0:1", dir)));
    Check("provider normal WebSocket path retained", () => ConfigPolicy.ProviderContent("proxies: [{name: x, type: vless, ws-opts: {path: /transport}}]", dir));
    Check("inline certificate path rejected", () => Denied(() => ConfigPolicy.Rewrite("proxies: [{type: http, certificate: C:/Windows/secrets}]", dir, 1, "x")));
    Check("file references nested deeply rejected", () => Denied(() => ConfigPolicy.Rewrite("proxies: [{type: x, opts: {private-key-file: C:/secret}}]", dir, 1, "x")));
    Check("normal read endpoints allowed", () => { foreach (var p in new[] { "/version", "/configs", "/proxies", "/connections", "/rules", "/providers/proxies/p", "/proxies/p/delay?url=http%3A%2F%2F127.0.0.1" }) ApiPolicy.Validate(p, "GET", null); });
    Check("controller reload denied", () => Denied(() => ApiPolicy.Validate("/configs", "PUT", JsonNode.Parse("{\"path\":\"C:/secret\"}"))));
    Check("controller upgrade denied", () => Denied(() => ApiPolicy.Validate("/upgrade", "POST", null)));
    Check("controller restart denied", () => Denied(() => ApiPolicy.Validate("/restart", "POST", null)));
    Check("safe mode mutation allowed", () => ApiPolicy.Validate("/configs", "PATCH", JsonNode.Parse("{\"mode\":\"rule\",\"tun\":{\"enable\":false}}")));
    Check("controller injection via PATCH denied", () => Denied(() => ApiPolicy.Validate("/configs", "PATCH", JsonNode.Parse("{\"external-controller\":\"0.0.0.0:1\"}"))));
    Check("TUN route mutation denied", () => Denied(() => ApiPolicy.Validate("/configs", "PATCH", JsonNode.Parse("{\"tun\":{\"enable\":true,\"device\":\"other\"}}"))));
    Check("proxy selection allowed", () => ApiPolicy.Validate("/proxies/Local%20Group", "PUT", JsonNode.Parse("{\"name\":\"DIRECT\"}")));
    Check("extra proxy mutation denied", () => Denied(() => ApiPolicy.Validate("/proxies/p", "PUT", JsonNode.Parse("{\"name\":\"x\",\"path\":\"bad\"}"))));
    Check("connection close allowed", () => ApiPolicy.Validate("/connections/fixture-id", "DELETE", null));
    Check("encoded path traversal denied", () => Denied(() => ApiPolicy.Validate("/proxies/%2e%2e/configs", "PUT", JsonNode.Parse("{\"name\":\"x\"}"))));
    Console.WriteLine($"Service policy: {passed} checks passed");
} finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
