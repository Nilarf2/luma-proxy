# Upstream provenance

- Project: Clash Verge Rev, <https://github.com/clash-verge-rev/clash-verge-rev>.
- Release: v2.5.8, annotated tag object `3fee9e8747c88580b67d28eff892ffc3418c07d4`.
- Resolved source commit: `4337bd85758d54d7b9044b2da3c9ac1176eae1f3`.
- Source path: `crates/clash-verge-media-unlock`.
- Original copyright holders retain their copyright; the copied sources are distributed under the upstream GNU GPL version 3. The complete upstream license is included as [LICENSE](LICENSE).

All fourteen Rust source files in `upstream/src/` are byte-for-byte copies of that commit. `upstream/SHA256SUMS.upstream` records their SHA-256 hashes. `upstream/Cargo.toml.original` preserves the upstream manifest. Verify the source copies from `media/upstream` with `sha256sum -c SHA256SUMS.upstream`.

The replacement `upstream/Cargo.toml` resolves the original workspace dependencies into a standalone build, pins their original direct versions, disables unused default reqwest features, and substitutes the small local logging crate for the original application's logging workspace. The logging shim only writes upstream diagnostic messages to stderr. No media-check logic is modified. The Luma stdin/stdout wrapper in `src/main.rs` enforces explicit invocation, a fixed loopback proxy, bounded input and local-only tests. `Cargo.lock` records the complete resolved dependency graph and crate checksums.

The twelve upstream entries are 哔哩哔哩大陆, 哔哩哔哩港澳台, ChatGPT Web, Claude, Gemini, YouTube Premium, Bahamut Anime, Netflix, Disney+, Prime Video, Spotify and TikTok. These detections report upstream heuristics; they do not bypass authentication, subscription requirements or regional restrictions.
