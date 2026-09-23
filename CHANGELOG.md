# Changelog

All notable changes to Operator Key are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- State the running version and how this copy was installed in Settings, with an upgrade route that matches the install: a packaged copy points at the package manager, a hand-installed binary at the release download, a build tree at rebuilding. An unrecognised install offers no instruction rather than a confident wrong one. The panel deliberately carries no filesystem path, since it is what an operator screenshots into a bug report.

## [0.2.3] - 2026-09-23

### Improved

- Mark an individual command when it was catalogued from a version of its tool that is not the version installed now, so the warning reaches the operator at the command they are about to copy rather than only in the catalog-wide banner.
- Report desktop compatibility as a supported/partly-supported mode with the exact missing prerequisite for each unavailable action, instead of only "Not confirmed".
- Surface the reviewed global-shortcut installer in Settings as preview-first guidance, so the feature is discoverable without the app ever changing desktop configuration itself.
- Keep local catalog search described as available on every desktop, including sessions where no native action can run.
- Derive the displayed prerequisites and the native action gate from the same environment and PATH check, so guidance cannot disagree with what the app will allow.
- Keep the compatibility report free of the operator's home directory, username, and environment, so it stays safe to include in a bug report.

### Fixed

- Stop the catalog freshness banner from claiming `role="alert"`. It is a standing advisory, and the alert channel belongs to transient action feedback; sitting in it stole announcements from real actions and made the alert role ambiguous across the app. This only surfaced when a real freshness report existed on disk, which CI never has because the report is machine-specific and gitignored.

## [0.2.2] - 2026-09-23

### Improved

- Guide disabled reasoning users to Settings with a native-only configuration action, without displaying a personal configuration path in the status message.
- Show conservative desktop readiness, permission-dependent browser copy, and provider-specific disclosures.
- Expose compact task starters that filter/search without copying, inserting, or executing anything.
- Make native verification query replacement deterministic and cover it with unit tests.

## [0.2.1] - 2026-09-23

### Fixed

- Mitigate intermittent Linux WebKitGTK renderer shutdown crashes by disabling
  accelerated compositing within Operator Key before GTK/WebKit starts. Preserve
  explicit environment overrides and normal close behavior; no global graphics
  changes or suppressed crash reporting. See `docs/LINUX_RENDERER.md` for the
  performance tradeoff and evidence limits.
- Run Rust binary-target renderer-policy tests in CI alongside the library tests.

## [0.1.0] - 2026-09-22

### Security

- **Reasoning is now disabled by default and reads its configuration from outside the
  repository.** The app ships no model, no endpoint and no credential. A clone contains
  nothing about whoever built it. Configuration lives at
  `${XDG_CONFIG_HOME:-~/.config}/operator-key/reasoning.json`, which is read at startup and
  never written to. See `docs/REASONING.md`.
- **The reasoning transport refuses any address that is not loopback**, checked after DNS
  resolution rather than by inspecting the hostname string, so a name that resolves
  off-host is rejected rather than trusted. Enforced in `src-tauri/src/provider.rs` and
  covered by tests that drive a real socket.
- **The insertion gate now rejects every control character**, not just newline and
  carriage return. Terminal escape sequences, backspace, NUL, DEL, the C1 range and
  bidirectional overrides can all rewrite what a terminal displays versus what it
  receives; a command whose visible text differs from its real text must never be typed
  for the operator. Verified against all 1,468 insertable catalog entries with no false
  positives.
- **Availability is recomputed on the machine that runs the app.** It was previously baked
  into the catalog by the machine that built it, so a downloaded release claimed tools the
  operator does not have. Insertion of a command whose program is absent from `PATH` now
  fails closed with a clear message.
- **Provider login status is read from both stdout and stderr.** Codex prints `Logged in`
  to stderr, so a stdout-only check reported a working installation as broken.
- **A release no longer discloses the machine that built it.** A default `cargo build
  --release` embeds dependency source paths from the local registry, so the shipped binary
  contained 209 strings naming the builder's home directory and username — confirmed by
  running `strings` over a built `.deb` payload. `scripts/build-release.sh` remaps those
  paths and then fails the build if any home path or username survives, and the release
  workflow repeats the check independently.
- **An operator's own catalog cannot weaken a safety classification.** A catalog may now
  be supplied at runtime (see below). It may add and refresh entries, but an entry the
  reviewed catalog marks red or amber keeps that level, and an entry the app has never
  seen can never arrive as green. Verified by a test that writes a hostile file to the
  real location and confirms the insertion gate still refuses it.
- **Continuous verification added.** Every push and pull request runs the TypeScript,
  Python and Rust suites, typecheck, lint, production build, `npm audit`, `cargo audit`, a
  secret scan, and a guard that refuses to publish host paths, personal identifiers,
  private network addresses or machine-specific state. Dependabot keeps dependencies
  moving.

### Added

- Support for any OpenAI-compatible local model server, including Ollama and
  llama.cpp, alongside the existing Codex CLI provider. A small local model is sufficient:
  the provider only ranks and explains catalog entries it is given.
- `desktop_capabilities` command and matching UI state, so a desktop without Wayland and
  Hyprland disables insertion with an explanation instead of failing with a raw process
  error when the operator presses the button. Search and copy continue to work there.
- `SECURITY.md` with a private disclosure route and a map of the trust boundaries worth
  attacking.
- **A catalog rebuilt on your own machine is picked up without rebuilding the
  application.** Drop it at `${XDG_DATA_HOME:-~/.local/share}/operator-key/catalog.json`
  and restart. A missing, oversized, unreadable or malformed file changes nothing: the
  app falls back to its built-in catalog rather than starting with none. See
  `docs/CATALOG.md`.
- `catalog_snapshot` command, so the interface and the native insertion gate resolve the
  same command text. Without it, a sidecar-updated catalog would make every copy and
  insert fail as a text mismatch.
- `.deb` and `.rpm` packages, built and checksummed by a release workflow on a version
  tag, replacing "copy this binary onto your PATH" as the only install route.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and this changelog.
- `docs/REASONING.md` and `docs/reasoning.example.json`.

### Changed

- The handoff document no longer records one machine's installed versions or the author's
  personal notification setup.
- `docs/INSTALL.md` uses `$HOME` instead of a literal home directory in its example.

### Fixed

- Reasoning resolved candidate entries against the build-time catalog while the insertion
  gate used the runtime one. An entry supplied by an operator's catalog was therefore
  visible and insertable in the interface, yet rejected by reasoning as not existing. Both
  now read one loader, locked by a test that fails if they diverge.
- `is_none_or` raised the effective toolchain requirement to Rust 1.82 while the project
  declares 1.77.2, which would have failed to build for anyone on an older toolchain.
- Overlay tests no longer flake against a 5-second default timeout on a loaded machine.

[0.1.0]: https://github.com/kevynshorey/operator-key/releases/tag/v0.1.0
