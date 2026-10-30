# Luma

Windows 10 / 11 x64 Mihomo client. Pure white content, a wide sidebar, light/dark/system themes and custom colors.

## Download

[GitHub Releases](https://github.com/Nilarf2/luma-proxy/releases) provides an installer and a portable EXE. Both include Mihomo and the optional Windows service helper. They are unsigned. Compare the downloaded file with `SHA256SUMS.txt`.

The installer finish page has a **创建桌面快捷方式** checkbox. Login startup is available in the installed app; the portable edition keeps data in the same user application-data directory and does not register login startup.

## Features

- Import local YAML, subscription URLs, Base64 subscriptions and common SS/Trojan/VLESS/VMess URIs. Edit/export profiles, combine sources, apply global/per-profile YAML or isolated JavaScript, and manage rules, nodes and groups.
- Rule/global/direct modes, selectors, latency tests, provider refresh/health checks, searchable rules, per-connection controls and live logs.
- System proxy with bypass, PAC and ownership-aware recovery. TUN with configurable stack, routes and DNS. IPv6, LAN access and listener ports are configurable.
- Optional protected Windows service for TUN from a normal desktop account. Installation/removal requires an explicit UAC action. Without the service, TUN requires an elevated app.
- Subscription usage/expiry and automatic refresh; local startup diagnostics; tray controls; silent launch, global hotkeys, notifications, network-change reconnect and UWP loopback settings.
- Local/scheduled backups, explicit WebDAV upload/restore, verified app downloads and stable/alpha Mihomo updates.
- Light/dark/system appearance, preset/custom accent and sidebar colors, navigation order/visibility and custom CSS.

All network tests are user initiated unless an interval is explicitly enabled. Startup diagnostics check the local environment; they do not test nodes, fetch subscriptions or connect automatically. Automatic connection is a separate setting. There is no telemetry.

TUN installation and service controls affect Windows networking. The service runs a fixed protected core, accepts requests only from its installing user and keeps its privileged controller secret private. Local provider files must be explicitly imported as assets. Custom desktop cores are currently unavailable in service mode; unsupported configurations fail visibly rather than silently running a different core.

## Configuration

Profiles and settings live under `%APPDATA%/Luma`. Backups contain subscription credentials and node secrets; store them privately. WebDAV credentials are used for the requested operation and are not saved in settings. HTTPS URLs are recommended.

Composition order is source profiles → selected profile → global YAML → profile YAML → global JavaScript → profile JavaScript → managed runtime networking. Conflicting node/group/provider names across sources fail validation. Source rules precede the selected profile's rules, excluding source catch-all rules. JavaScript receives JSON configuration only, with bounded time and memory and no Node APIs.

See [capability and acceptance checklist](docs/PARITY.md) for known differences from Clash Verge Rev. This version does not establish complete feature parity. Windows ARM64, interactive UAC behavior and a genuinely non-elevated desktop require their own acceptance coverage. Some privileged file/certificate configurations are intentionally constrained. GEOIP/GEOSITE configurations may need first-use data downloads.

## Development

Node.js 24+ and .NET 8 SDK:

```sh
npm ci
npm test
npm run dev
npm run core:win
dotnet run --project service/tests/Policy.Tests.csproj -c Release
dotnet publish service/Luma.Service.csproj -c Release -r win-x64 --self-contained true -o resources/service
npm run dist:win
```

`npm run core:linux` enables the real-core integration test on Linux. `npm run test:ui` runs browser interaction checks; `CHROMIUM_PATH` can select an installed Chromium binary. Windows CI builds the native helper, tests service policy, exercises actual TUN/route/owner-death cleanup using local fixtures, tests the packaged app and proxy recovery, then builds both EXEs. No real subscription or public latency endpoint is used in automated tests.

## License

GPL-3.0-only. See [LICENSE](LICENSE), [third-party notices](THIRD-PARTY-NOTICES.md) and [service architecture](service/README.md).
