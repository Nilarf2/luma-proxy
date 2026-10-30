# Luma

**让连接归于简单。** A quiet, minimal Windows proxy client, powered by Mihomo.

Porcelain white, generous spacing, restrained sage accents. Built for Windows 10 / 11 x64. Semantic theme tokens keep future palettes independent of components.

## v0.1 preview

- Import Clash / Mihomo YAML from subscription URL or local file; update, switch, and remove profiles.
- Start/stop bundled Mihomo; switch rule/global/direct modes and Windows system proxy.
- Select nodes within Selector groups; test latency with bounded concurrency.
- Real connection totals, transfer speeds, active connections, and sanitized diagnostic logs.
- Tray controls, single-instance, optional login startup, minimize to tray.
- Restore previous Windows proxy settings on disconnect/quit, with an independent watchdog and next-launch recovery. The watchdog can start without WMI; if recovery protection cannot start, the UI remains available and system proxy activation is refused with an explanation. Respect settings changed by another app.
- Local-only profile storage under `%APPDATA%/Luma`; no telemetry. Profile URLs are not exposed to the renderer.

## Download

Windows EXEs are available from GitHub Releases. Both NSIS installer and standalone portable EXE include the x64 Mihomo engine. The portable EXE extracts its runtime on launch; profile data still lives in the user application-data directory. Verify SHA-256 against `SHA256SUMS.txt`.

The installer finish page includes a checked-by-default desktop-shortcut option.

This preview is unsigned. Windows SmartScreen may show an unknown-publisher prompt. No TUN, ARM64, auto-updates, automatic subscription scheduling, Base64 subscriptions, individual URI imports, or external file providers in this release. System proxy only affects applications that honor Windows proxy settings. Import only trusted configurations. HTTPS subscriptions are recommended. URLs and IDs receive basic log redaction, not a guarantee that arbitrary provider output contains no private data.

## Development

Node.js 24 LTS or newer:

```sh
npm ci
npm test
npm run dev           # renderer preview, no fake connection data
npm run core:win      # checksum-verified official Windows kernel
npm start             # Windows desktop app
npm run dist:win      # Windows NSIS installer + portable EXE
```

GitHub Actions builds on Windows. `npm run core:linux` enables an isolated real-kernel integration test on Linux without altering host proxy settings. `npm run test:ui` runs UI smoke tests with Chromium (`CHROMIUM_PATH` can override the browser executable).

## Architecture

`src/`: React UI, `src/themes.css`: palette tokens. `electron/`: sandboxed renderer bridge, lifecycle, subscriptions, kernel management, Windows proxy recovery. The controller uses a random loopback port and per-run secret. Subscription configs cannot enable LAN listeners, TUN or external management endpoints; provider cache paths are contained in the application data directory.

## Validation

Automated checks cover subscription validation, configuration overrides, profile storage, proxy ownership/recovery via a mocked registry, and an isolated real Mihomo controller/proxy lifecycle. UI tests cover navigation, import, settings, node switching and errors with a deterministic bridge fixture. Windows CI runs the packaged EXE to verify local YAML import, the bundled kernel, real HTTP forwarding, Windows registry proxy settings, disconnect/normal-exit restoration, and recovery after forced main-process termination. It also checks both EXE headers and records SHA-256 checksums. Installer interaction, SmartScreen, tray presentation, and long-term behavior still require personal Windows desktop acceptance. Configurations using GEOIP/GEOSITE may need online data downloads on first use.

## License

GPL-3.0-only. See LICENSE and THIRD-PARTY-NOTICES.md. No Apple assets or trademarks are used.
