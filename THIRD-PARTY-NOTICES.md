# Third-party software

Luma is licensed under GPL-3.0-only. Source: https://github.com/Nilarf2/luma-proxy

The distribution bundles Mihomo v1.19.33 (GPL-3.0):
- Source: https://github.com/MetaCubeX/mihomo/tree/v1.19.33
- License: https://github.com/MetaCubeX/mihomo/blob/v1.19.33/LICENSE
- Unmodified official binary, verified against the pinned SHA-256 in scripts/fetch-core.mjs.

Electron (MIT) includes Chromium, Node.js, and other open source components; see LICENSE.electron.txt and LICENSES.chromium.html distributed alongside the application. React and React DOM (MIT), Lucide (ISC), and YAML (ISC) retain their license notices in the application dependencies.

The optional native service uses the .NET 8 runtime (MIT) and YamlDotNet (MIT). Its project and package references are in service/Luma.Service.csproj. The published self-contained service includes those runtime components; their source and licenses are available at https://github.com/dotnet/runtime and https://github.com/aaubry/YamlDotNet.

The media unlock helper vendors Clash Verge Rev v2.5.8's media-unlock crate (GPL-3.0), unchanged, from commit 4337bd85758d54d7b9044b2da3c9ac1176eae1f3. The complete license, original source hashes, buildable source and integration changes are in media/. Source: https://github.com/clash-verge-rev/clash-verge-rev/tree/v2.5.8/crates/clash-verge-media-unlock. Rust dependency versions and source checksums are recorded in media/Cargo.lock; dependency license metadata remains in the published crates.
