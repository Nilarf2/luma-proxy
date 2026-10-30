# Media unlock helper

This isolated executable preserves all twelve media unlock checks from Clash Verge Rev v2.5.8. It accepts exactly one JSON document on stdin and writes one JSON result on stdout. No input means an error; starting the app does not invoke any check.

```json
{"action":"list"}
{"action":"check","proxyPort":7890}
{"action":"check","proxyPort":7890,"check":"Netflix"}
```

`list` returns the twelve pending items without creating an HTTP client. `check` requires a nonzero TCP port and always uses `http://127.0.0.1:<port>` as an explicit proxy for every HTTP/HTTPS request. System/environment proxies are disabled. There is no direct fallback or caller-supplied proxy host, URL, or executable. An unknown check is rejected before creating the client. Actual checks are invoked only by a visible user action in the desktop app.

Success is `{"ok":true,"items":[...]}` using the upstream `UnlockItem` fields (`name`, `status`, `region`, `check_time`). Failure is `{"ok":false,"error":"..."}` with a nonzero exit status. Input is bounded at 4096 bytes. Upstream limits concurrency to four and bounds each check at fifteen seconds. Redirects and cookies remain within the same explicitly proxied HTTP client; TLS certificate validation remains enabled.

Build with Rust 1.99.1 or later:

```sh
cargo test --locked --manifest-path media/Cargo.toml
cargo build --locked --release --manifest-path media/Cargo.toml
```

The Windows workflow copies `media/target/release/luma-media.exe` into `resources/media/`. Tests exercise all twelve genuine checks through an ephemeral loopback proxy that immediately returns a fixture error. They never connect to the actual media targets. Error responses are test fixtures, not evidence that a real account, region, or subscription unlocks a service.

See [UPSTREAM.md](UPSTREAM.md) for the exact source revision, license and adaptation boundary.
