# Windows capability audit

Baseline audited 2026-10-30: Clash Verge Rev **v2.5.8**, released 2026-10-09, versus released Luma **v0.1.2**. This is an acceptance checklist, not a claim of completed parity. Work in progress must pass its listed checks before changing its status. A working Mihomo configuration does not by itself establish equivalent application controls.

Official references: [release](https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/v2.5.8), [configuration model](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/src/config/verge.rs), [profile model](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src/types/global.d.ts), [profile import](https://www.clashverge.dev/guide/profile.html), [extensions](https://www.clashverge.dev/guide/extend.html), [URL schemes and subscription headers](https://www.clashverge.dev/guide/url_schemes.html), [Windows/service guidance](https://www.clashverge.dev/faq/windows.html), [hotkeys](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/src/core/hotkey.rs), [themes](https://www.clashverge.dev/guide/css_injection.html).

`Partial` means useful functionality exists but application controls or acceptance coverage are missing. `Missing` describes the released baseline, even when a replacement is currently being implemented.

| Capability in CVR | Luma 0.1.2 | Required acceptance |
| --- | --- | --- |
| Bundled Mihomo | Present | Packaged binary version, local fixture connect, exit cleanup |
| TUN, stacks, DNS hijack, routes, interface controls | Missing | Real virtual adapter + route/DNS inspection, local destination only; stop and crash restore |
| Persistent privileged Windows service | Missing | Explicit UAC install/remove; protected files; user-bound pipe; ordinary-user UI starts TUN |
| Administrator TUN fallback | Missing | Elevation status accurate; no silent elevation; deny cleanly without service/admin |
| System proxy and previous-setting restoration | Present | Exact registry restoration after normal exit and actual main-process kill |
| System proxy guard/reapply interval | Missing | Controlled registry change detected/reapplied only while opted in; restoration remains correct |
| PAC, bypass, custom proxy host | Missing | Local PAC fixture; bypass saved and restored; no public PAC fetch |
| Local file, URL and drag/drop profiles | Partial | File and URL work; drag/drop must actually import a fixture |
| Protocol URL import | Missing | Encoded URL preserved; visible confirmation; invalid schemes rejected |
| Subscription headers/name/usage/expiry/home | Missing | Local HTTP fixtures exercise every supported header, malformed data and expiry |
| Automatic update intervals/custom UA/proxy mode/timeout | Missing | Clock-controlled schedule, retry/backoff, serialized active-profile reconnect; no lost edits |
| Multiple profile activation/update/delete | Present | Switching rollback, update rollback and cancellation; credentials absent from errors |
| Local YAML creation/editing/export | Missing | Validate before save; invalid edits preserve active config; export exact selected profile |
| Global and per-profile YAML extensions | Missing | Document merge order and list/DNS/hosts semantics; deterministic fixtures |
| Global and per-profile JavaScript extensions | Missing | Bounded execution, no Node/OS APIs; clear failures; output validation |
| Visual rules/proxies/groups editors | Missing | Reorder/add/delete persists and affects generated core config |
| Profile-specific rules/proxies/groups overrides | Missing | Original survives and overrides apply in documented order |
| Selector and automatic groups | Partial | Selector works; URLTest/Fallback/LoadBalance display and updates need coverage |
| Provider identity, refresh and health checks | Partial | Same node name across providers remains distinguishable; refresh and failure visible |
| Individual/group latency + custom URL/timeout | Partial | Baseline fixed URL only; configurable local test URL, bounded batch and cancellation |
| Scheduled latency tests/test URL lists | Missing | Clock-controlled interval; pause when disconnected; no external CI traffic |
| Rule/global/direct modes | Present | Core mode and saved mode agree after reconnect |
| Rules inspection/search/provider updates | Missing | Real `/rules` fixture and live reload/provider controls |
| Connections search/detail/close one/close all | Partial | Baseline closes all; verify per-ID closure, filtering and metadata |
| Live logs, level controls, export/cleanup | Partial | Baseline limited process output; verify core stream, retention, export redaction |
| DNS enable/fake-IP/DoH/fallback/hosts settings | Partial | Imported settings partially retained; managed editor and generated-config assertions |
| IPv6, mixed/HTTP/SOCKS ports, LAN/listeners | Missing controls | Port conflicts/validation; loopback defaults; explicit LAN consent |
| External controller/CORS/web UI management | Missing controls | Bound interface and origin restrictions; service never exposes privileged controller |
| Tray connect/modes/TUN/groups/latency/customization | Partial | Basic open/connect/quit only; native acceptance for expanded menu |
| Launch at login and silent launch | Partial | Actual StartupApproved readback; silent launch preserves tray and recovery |
| Global hotkeys | Missing | Registration conflict, rollback, persistence, cleanup; every supported action |
| Desktop notices and network-change handling | Missing | Opt-out, no secrets; reconnect/recheck behavior without unnecessary takeover |
| UWP loopback exemptions | Missing | Explicit admin action; list/select/revoke; restore only owned changes |
| Local backup/restore and scheduled backup | Missing | Atomic restore, corrupt/zip-slip/oversize rejection, secret handling, version migration |
| WebDAV backup/synchronization | Missing | Local DAV fixture auth/errors/conflicts; credentials excluded from public state |
| App update/download/cancel/reuse | Missing | GitHub fixture metadata, checksum validation, verified launch and rollback errors |
| Core stable/alpha update/switch | Missing | Match platform/architecture; verify archive+binary; stop/swap/rollback safely |
| Light/dark/system/custom themes/presets | Missing | Persistence, OS changes, contrast, no unreadable controls |
| Custom CSS/group icons/tray icons/navigation | Missing | Explicit controls; safe local handling; actual visual acceptance |
| Traffic/memory graph and lightweight mode | Partial | Traffic counters only; graph accuracy and lifecycle need coverage |
| Media unlock tests | Missing | CVR includes media-unlock integrations; external tests require user opt-in and are not run in CI |
| Windows x64 and ARM64 distribution | Partial | x64 only; architecture-specific core, service, installer and smoke coverage |

## Windows service and TUN acceptance

A service is not counted as implemented merely because the whole UI can run as administrator. Default installation must not install a service or alter routes. The service is installed only from an explicit settings action with UAC; cancellation leaves the app usable. Its executable and fixed Mihomo binary live under a protected Program Files directory with Administrators/SYSTEM write access. Service data and configuration cannot become arbitrary privileged file paths. Requests arrive on a local pipe restricted to the installing user SID and are checked against the impersonated client and application owner PID/start time. No shell command or arbitrary executable is accepted. The core's privileged controller credentials stay inside the service; the pipe exposes only an allowlist of normal proxy-client operations.

On an isolated Windows runner/VM, save registry proxy values, routes, DNS, adapters and service state before testing. Use a local HTTP fixture and a local-only direct rule. Test explicit service install, ordinary-user status/start/stop, actual TUN adapter creation, route/DNS configuration, local fixture traffic, normal stop, main-process kill, owner PID reuse/start-time mismatch, and service restart. Confirm TUN disappears/restores after owner death. Test rejected cross-user pipe requests and malformed/oversize configs, path traversal, absolute provider/cache paths, controller reload/upgrade requests, and symlink/reparse-point targets. Uninstall stops the core first and removes only owned files. Restore the saved machine state in a finally block. GitHub's normally elevated Windows runner validates the privileged path; it cannot alone prove interactive UAC cancellation or a genuinely non-elevated desktop session, so those remain separately recorded manual VM checks until exercised.

## Test gates

1. Unit: settings, profile metadata/scheduling/compiler, service request/path/API validation, config rollback, backup restore, updater verification and integration lifecycle. Inject clocks/process/OS APIs where appropriate.
2. UI: all navigation and actual controls; white/wide sidebar, presets/custom colors and day/night persistence; errors, keyboard focus and narrow-window behavior.
3. Packaged Windows: local subscription import, local HTTP over core, proxy restore, watchdog repair, forced unavailable protection, real main-process termination, startup health and persistence, service/TUN lifecycle. Never use a real subscription or public latency endpoint.
4. Distribution: build unsigned x64 installer/portable with bundled core and service; install/uninstall service explicitly; record artifacts and SHA-256. ARM64 remains unverified until its own build and acceptance run passes.

Open differences must stay visible in this document and release notes. No blanket “not less than CVR” claim is supported while any required row remains missing or unverified.

## Current implementation verification (unreleased workspace)

The baseline table above remains anchored to released 0.1.2. Current work has added a protected Windows service and pipe bridge, global/per-profile configuration composition and scripts, local provider assets, common URI imports, subscription metadata/scheduling, richer core/settings pages, themes, PAC/guard, integrations and maintenance modules. These are not yet counted as released or fully accepted.

Verified here: Windows-targeted native service builds with zero warnings/errors; 40 native executable policy checks, 14 Node service bridge tests, 4 provider bridge tests and 4 Rust media tests pass. The service test validates caller-bound operations, confined assets and private controller forwarding, and has explicit Windows acceptance for actual adapter/route/local forwarding and owner death. Windows runtime, interactive UAC, non-elevated desktop and complete new UI behavior are pending their respective acceptance runs. Explicit protected selected-core synchronization and a custom-header/URI/base64 provider bridge with scheduled/manual refresh are now implemented and awaiting Windows acceptance. All twelve exact upstream media checks are vendored with a source hash manifest; local-only fixtures verify they remain on the specified loopback proxy. Managed certificate files remain a constrained service case; x64 does not establish ARM64 parity.
