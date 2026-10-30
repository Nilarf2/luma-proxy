# Windows capability audit

Audit date: 2026-10-30. This compares official Clash Verge Rev **v2.5.8** (2026-10-09) with the current Luma **0.2.0 Windows x64 implementation**. It separates implemented behavior from actual verification. It does not treat Linux/macOS or additional CPU architectures as requirements for this Windows x64 release. A working Mihomo configuration alone does not establish equivalent application controls.

Official references: [release](https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/v2.5.8), [configuration model](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/src/config/verge.rs), [profile model](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src/types/global.d.ts), [profile import](https://www.clashverge.dev/guide/profile.html), [extensions](https://www.clashverge.dev/guide/extend.html), [URL schemes and subscription headers](https://www.clashverge.dev/guide/url_schemes.html), [Windows/service guidance](https://www.clashverge.dev/faq/windows.html), [hotkeys](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/src/core/hotkey.rs), [themes](https://www.clashverge.dev/guide/css_injection.html).

`Implemented` means application controls and backend behavior exist; it does not mean every native interaction passed. `Partial` identifies an actual remaining difference. Verification below names local evidence and Windows checks still pending.

| Capability in CVR | Luma 0.2.0 Windows x64 | Verification / remaining acceptance |
| --- | --- | --- |
| Bundled Mihomo | Implemented | Real-core local integration; packaged Windows connect/exit gate |
| TUN stacks, DNS hijack, routes and interfaces | Implemented | Windows adapter and confined route observed; corrected local TCP forwarding/owner-death fixture awaiting rerun |
| Persistent privileged Windows service | Implemented | Windows install/start/stop/private controller passed; same-SID restricted-token TUN gate added, awaiting rerun |
| Administrator TUN fallback | Implemented | Privilege snapshot and fail-closed engine checks; explicit elevated desktop interaction pending |
| System proxy and previous-setting restoration | Implemented | Registry recovery, watchdog repair, forced termination in packaged Windows gate |
| System proxy guard | Implemented | Ownership-aware reapply; unit lifecycle tests, native opt-in interaction pending |
| PAC, bypass and custom proxy host | Implemented | Local PAC and proxy tests; registry restoration remains required |
| Local/URL/drag-and-drop profile import | Implemented | Parser/downloader fixtures and UI import/drag checks |
| Protocol URL import | Implemented | Confirmed import, encoded URL validation; actual Windows protocol invocation pending |
| Subscription headers/name/usage/expiry/home | Implemented | Bounded local HTTP fixtures, metadata and invalid-input tests |
| Automatic updates, custom UA/proxy/timeout | Implemented | Scheduling/download fixtures and serialized reconnect; timer interaction in packaged app pending |
| Profile activation/update/delete and rollback | Implemented | Compiler/profile transaction tests; native subscription fixture |
| YAML creation/edit/export | Implemented | Validated editor/export; direct-only configurations accepted |
| Global/per-profile YAML and JavaScript extensions | Implemented | Deterministic composition and isolated bounded scripts tested |
| Visual rule/node/group editing | Implemented | Structured editor add/reorder/delete; generated-config and UI checks |
| Profile-specific overrides and composition | Implemented | Source ordering, name conflicts, YAML/script layering tested |
| Selector/URLTest/Fallback/LoadBalance groups | Implemented | Live group types and selection controls; native group interaction pending |
| Provider identity/refresh/health checks | Implemented | Identity-aware nodes; Windows URI/Base64, custom header, interval and manual refresh passed; individual healthcheck gate added |
| Individual/batch latency, URL/timeout/cancel | Implemented | Bounded queue and cancel tests; service cancels client wait, native operation remains bounded by 30s |
| Scheduled latency and test address lists | Implemented | Saved address lists and interval controls; local clock/queue tests |
| Rule/global/direct modes | Implemented | Managed runtime and live API controls; persistence checks |
| Rules search/provider update | Implemented | Rules page and proxy/rule provider controls; fixture API tests |
| Connections search/details/close one/all | Implemented | Connection metadata UI and per-ID/all closure; local API fixtures |
| Live logs/levels/export/cleanup | Implemented | Core output, controlled streams and redacted exports; controller fixtures |
| DNS/fake-IP/DoH/fallback/hosts | Implemented | Managed DNS editor and generated-config tests |
| IPv6/ports/LAN/listeners | Implemented | Validation, loopback defaults and explicit LAN control; native conflict acceptance pending |
| External controller/CORS/local WebUI | Implemented | Token/origin checks, imported local UI, allowlisted HTTP/WebSocket forwarding; privileged controller stays private |
| Tray connect/mode/TUN/groups/latency/icons | Implemented | Native tray menu and safe imported icons; manual tray interaction pending |
| Actual login startup and silent launch | Implemented | StartupApproved readback and tray-preserving startup; packaged Windows gate |
| Global hotkeys | Implemented | Conflict/rollback/persistence/cleanup unit tests; native key interaction pending |
| Notices and network-change reconnect | Implemented | Opt-out and lifecycle tests; native adapter-change interaction pending |
| UWP loopback list/select/revoke | Implemented | Explicit UAC fixed commands; actual selected-app enable/revoke requires interactive VM |
| Local/scheduled backup and restore | Implemented | Atomic/versioned bounded backup validation and restore tests |
| WebDAV upload/restore | Implemented | Explicit operations, local DAV fixtures; credentials excluded from public state |
| App updates/download/cancel/reuse | Implemented | Checksum/platform verification and cancellation fixtures; verified installer launch requires explicit action |
| Stable/alpha/custom core update and service sync | Implemented | Windows protected digest, stale-image rejection and UAC-helper sync/restart passed; rollback tests |
| Light/dark/system, presets/custom colors | Implemented | Persistent appearance and OS-mode UI checks |
| CSS/group/tray icons/navigation customization | Implemented | Local asset validation and UI controls; native tray preview interaction pending |
| Traffic/memory graphs and lightweight mode | Implemented | Counters/history, renderer teardown/recreation and memory polling tests |
| Twelve media-unlock checks | Implemented | Exact official source hashes and four loopback-only Rust tests; native Windows compilation still pending |
| TLS client certificates/keys (mTLS) | Implemented | Explicit certificate/key file selection imports a validated pair into profile YAML as inline PEM; privileged file references stay rejected. Native checks validate certificate/key matching, malformed input and nested provider credentials. RSA/EC/DSA supported; other private-key algorithms need explicit compatibility coverage |

## Windows service and TUN acceptance

A service is not counted as implemented merely because the whole UI can run as administrator. Default installation must not install a service or alter routes. The service is installed only from an explicit settings action with UAC; cancellation leaves the app usable. Its executable and fixed Mihomo binary live under a protected Program Files directory with Administrators/SYSTEM write access. Service data and configuration cannot become arbitrary privileged file paths. Requests arrive on a local pipe restricted to the installing user SID and are checked against the impersonated client and application owner PID/start time. No shell command or arbitrary executable is accepted. The core's privileged controller credentials stay inside the service; the pipe exposes only an allowlist of normal proxy-client operations.

On an isolated Windows runner/VM, save registry proxy values, routes, DNS, adapters and service state before testing. Use a local HTTP fixture and a local-only direct rule. Test explicit service install, ordinary-user status/start/stop, actual TUN adapter creation, route/DNS configuration, local fixture traffic, normal stop, main-process kill, owner PID reuse/start-time mismatch, and service restart. Confirm TUN disappears/restores after owner death. Test rejected cross-user pipe requests and malformed/oversize configs, path traversal, absolute provider/cache paths, controller reload/upgrade requests, and symlink/reparse-point targets. Uninstall stops the core first and removes only owned files. Restore the saved machine state in a finally block. The CI TUN owner is launched with the same installing SID using SAFER Basic User, and must report Administrator role false before acceptance; there is no elevated fallback. This restricted-token run still cannot prove the interactive UAC consent/cancellation experience, which remains a manual VM check until exercised.

## Test gates

1. Unit: settings, profile metadata/scheduling/compiler, service request/path/API validation, config rollback, backup restore, updater verification and integration lifecycle. Inject clocks/process/OS APIs where appropriate.
2. UI: all navigation and actual controls; white/wide sidebar, presets/custom colors and day/night persistence; errors, keyboard focus and narrow-window behavior.
3. Packaged Windows: local subscription import, local HTTP over core, proxy restore, watchdog repair, forced unavailable protection, real main-process termination, startup health and persistence, service/TUN lifecycle. Never use a real subscription or public latency endpoint.
4. Distribution: build unsigned x64 installer/portable with bundled core and service; install/uninstall service explicitly; record artifacts and SHA-256. This release targets Windows x64; other architectures are outside this acceptance scope.

Open differences must stay visible in this document and release notes. No blanket “not less than CVR” claim is supported while any required row remains missing or unverified.

## Current implementation verification

Local evidence: Windows-targeted service builds with zero warnings/errors; **49 native policy checks**, **16 Node service tests**, **4 provider bridge tests** and **4 Rust media tests** pass. The native suite adds a Windows-only locked-source check, so Windows reports one additional check. The service validates caller identity, confined assets, protected-image synchronization, private controller forwarding, per-provider healthcheck paths and inline TLS credentials. Rust tests invoke all twelve genuine upstream checks through a loopback proxy fixture that returns controlled failures, without contacting media services.

[Windows run 41072645311](https://github.com/Nilarf2/luma-proxy/actions/runs/41072645311) verified service installation, repeated pipe requests, normal start/stop, secret removal, denied reload/upgrade, selected-core digest synchronization/restart, custom-header URI/Base64 provider import, automatic refresh and manual refresh. It also observed the real TUN adapter and confined route. HTTP forwarding then failed because the test origin had not implemented the HTTP proxy CONNECT tunnel; that fixture is corrected and locally exercised with actual TCP. TUN forwarding, restricted-token ownership and owner-death cleanup await the next Windows run. No failed run is counted as a complete service/TUN pass.

The earlier media source hash failure was Windows checkout CRLF conversion. Pinned upstream files now use byte-preserving Git attributes; all fourteen hashes were reverified with `core.autocrlf=true`. Windows Rust build/tests and complete packaged UI/recovery acceptance still await a passing current-head run. Interactive UAC install/cancel/uninstall, selected UWP exemptions, hotkeys and native tray interactions remain explicit manual checks.
