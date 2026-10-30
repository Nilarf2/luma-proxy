# Luma Windows service

The self-contained .NET 8 x64 helper installs an explicit, owner-bound Windows service. It is bundled next to `resources/core/mihomo.exe`; the desktop settings action requests UAC. The helper validates the initiating desktop PID's Windows SID before installing or uninstalling, including when a standard account supplies another administrator's credentials.

The protected installation is `%ProgramFiles%\Luma\Service`. Administrators and SYSTEM can write; users can execute the helper. `Data` inherits no ordinary-user read/write access. Installation refuses existing service directories instead of following or replacing them, and rejects reparse-point ancestry. No arbitrary source path, executable, arguments or shell operation is accepted. Uninstall uses the original bundled helper, stops the service/core, then removes its protected directory.

The pipe `\\.\pipe\Luma.Proxy.<SID>` uses an owner SID/SYSTEM ACL and first-instance protection. Its single server handle is created synchronously at service startup and retained across requests, preventing a name takeover between clients. Every request checks the impersonated Windows identity and obtains the actual client PID from the pipe. A start request must claim that same PID. The service holds the owner process handle and compares creation time before launch; a 750 ms watchdog kills the core and its TUN state when the owner exits. The service also assigns itself to a kill-on-close Windows Job Object before launching cores; child processes inherit that job, so forced service termination kills its cores too. Another process cannot mutate/stop the active owner's core. Status/logs remain visible to the installing user.

Only the fixed protected `mihomo.exe` can run. YAML root keys are allowlisted. Controllers/listeners from profiles are removed; runtime controllers use a private random port/secret. Ordinary users cannot read the generated runtime YAML. Proxy provider content is inspected before core access, with file references rejected; provider assets must arrive as submitted YAML blobs with hashed names and are copied into protected cache. The core receives no `SAFE_PATHS` override. HTTP rule-provider caches are also rewritten inside this directory. User-authorized proxy LAN listener settings remain intact.

The core's management API is relayed over the pipe through an allowlist. It permits ordinary node/group, connection, rule/provider and restricted mode/log/TUN operations. Configuration reload, restart, upgrades, arbitrary paths and executable operations are denied. `/configs` readback removes controller credentials. Unknown root/path-bearing configuration keys fail closed; service mode therefore requires explicit policy updates for newly introduced Mihomo file features.

Build and policy acceptance:

```
dotnet run --project service/tests/Policy.Tests.csproj -c Release
dotnet publish service/Luma.Service.csproj -c Release -r win-x64 --self-contained true -o resources/service
node --test test/service.test.cjs
```

`node scripts/service-smoke.mjs` runs only on an elevated isolated Windows runner, refuses a pre-existing service/test adapter, and always uninstalls its fixture. It checks real TUN adapter/route/local HTTP forwarding plus owner-process-death cleanup. Interactive UAC cancellation and ordinary-user desktop operation need separate VM acceptance; an elevated CI runner cannot establish either. No signing is configured.

Current constrained cases: remote proxy providers must deliver YAML `proxies`; common URI/base64 data must be normalized by the desktop importer and submitted as local assets. Certificate/private-key filesystem references require managed-asset import support before service mode can accept them. These are explicit parity differences, not silently ignored options.
