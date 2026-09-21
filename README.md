# Operator Key

Operator Key is a local-first command compass for operators who remember the task but not the shortcut.

It builds a version-aware catalog from the installed Omarchy, Hermes Agent, Claude Code, and Codex CLI environments, then lets the operator search by intent.

## Current deliverable

- Product specification
- Design intent
- Implementation plan
- Machine-readable JSON catalog
- Repeatable catalog generator
- Searchable command-line proof of concept
- React/Vite intent-search overlay backed by the checked-in catalog
- Product, task, interface, and safety filters
- Keyboard result navigation, product tabs, conflict telemetry, and large-text mode
- Tauri 2 desktop shell configured as a local, always-on-top overlay
- Catalog-validated clipboard copy and guarded terminal insertion
- Deterministic Python and TypeScript tests

Press Enter to copy the selected catalog command. On Hyprland/Wayland, Shift+Enter can insert an available, non-red shell command or CLI flag into an allowlisted terminal. Insertion types literal text only: it does not send Enter or execute the command. Ctrl/Meta+Enter remains disabled.

## Install and develop

Install the pinned frontend dependencies:

```bash
npm install
```

Run the browser-safe Operator Deck preview (bound to localhost only):

```bash
npm run dev -- --host 127.0.0.1
```

The browser preview detects web mode automatically. It searches the checked-in local catalog and copies literal command text; it does not call cloud services, inspect secrets or configuration, access a terminal, insert text, or execute commands.

| Capability | Browser preview | Native companion |
|---|---:|---:|
| Local catalog search and filters | Yes | Yes |
| Copy selected command | Browser clipboard + safe fallback | Native validated copy |
| Insert into confirmed terminal | No | Guarded eligible commands only |
| Execute or send Enter | Never | Never |
| Escape / top-right control | Clear/reset search | Close overlay |

Run the desktop overlay in Tauri development mode:

```bash
npm run tauri dev
```

To install a preview-first Omarchy launcher binding, follow [`docs/INSTALL.md`](docs/INSTALL.md). Preview is the default and does not change your configuration.

Native copy requires `wl-copy` from `wl-clipboard`. Guarded insertion additionally requires Hyprland's `hyprctl` and `wtype`; it is not supported on other desktops. The overlay hides, captures an allowlisted terminal target, refocuses that exact Hyprland window address, and revalidates its identity before inserting. Native handoff work has a bounded deadline. The overlay is restored and refocused if target detection or insertion fails.

## Generate the catalog

```bash
python3 scripts/build_catalog.py
```

Use cached official documentation when offline:

```bash
python3 scripts/build_catalog.py --offline
```

### If you cloned this repository

The `data/catalog.json` in git was generated on somebody else's computer. It is included
so the app runs immediately, but until you regenerate it, every entry is a description of
a machine you have never seen — possibly different versions, possibly tools you do not
have at all.

```bash
python3 scripts/build_catalog.py    # makes the catalog yours
```

The app is explicit about this rather than quietly pretending otherwise. If none of the
catalogued tools are found on your machine, it says the catalog describes a different
computer. If some are missing, it names them and excludes them from staleness warnings:
a tool you never installed cannot be "out of date".

Provenance paths are written as `~/.claude/...` rather than absolute paths, so a catalog
built on one machine does not leak a username or point at directories that exist nowhere
else. `tests/test_catalog.py` fails the build if an absolute home path reappears.

## Stay current

The catalog describes the tools installed on this machine at the moment it was generated.
Upstream keeps moving, so a separate check compares what you have against what has shipped:

```bash
python3 scripts/check_updates.py
```

It writes `data/freshness.json` and prints a summary:

```
product       installed     latest            drift     catalog
omarchy       4.0.3-1       v4.0.4            behind    in sync
claude-code   2.1.272       v2.1.278          behind    in sync
```

Three different problems are tracked, because they need different responses:

- **Version drift** — your installed tool is behind upstream. Update, then regenerate.
- **Content drift** — official documentation changed at the *same* version, so a command's
  meaning may have moved. Detected by hashing docs between runs.
- **Catalog drift** — the catalog was built from versions other than those installed now.
  This is purely local and is detected even with no network.

The app reads `data/freshness.json` and shows a banner when there is something to say. It
is advisory: **the checker never writes to the catalog**. Network content must not be able
to change a command or how it is classified — the catalog earns its authority by being
generated locally from installed binaries, and `scripts/build_catalog.py` remains the only
thing that writes it.

The application itself never reaches the network. Run the check from cron:

```cron
0 9 * * 1 cd /path/to/operator-key && python3 scripts/check_updates.py --quiet
```

Offline runs preserve what the last online check found rather than erasing it:

```bash
python3 scripts/check_updates.py --offline
```

Weekly rather than daily is deliberate: most runs would find nothing, and a banner that
cries wolf gets ignored precisely when it matters.

## Run it as a web app

The same build serves as a plain website with no Tauri and no Rust:

```bash
npm run build
npx serve dist        # or any static host
```

The app detects its runtime and adapts. In a browser it labels itself `WEB DECK · COPY
ONLY` and removes every execution path: commands can be read, searched, explained and
copied, but nothing can be run, because a web page has no business executing anything on
your machine. Search, teaching, predictions, onboarding and the freshness banner all work
identically. `dist/` is a static bundle, so any host will do.

## Search by intent

```bash
python3 scripts/operator_key.py review code
python3 scripts/operator_key.py resume session --product hermes
python3 scripts/operator_key.py move window --product omarchy
python3 scripts/operator_key.py context --interface slash-command
```

For machine-readable results:

```bash
python3 scripts/operator_key.py review --json
```

## Test and verify

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e
python3 -m unittest discover -s tests -v
python3 -m json.tool data/catalog.json >/dev/null
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

Playwright keeps its portable shared-memory default. On a local Omarchy host where `/tmp` is constrained but `/dev/shm` has sufficient capacity, opt in explicitly with `OPERATOR_KEY_PLAYWRIGHT_USE_DEV_SHM=1 npm run test:e2e`.

See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for the exact installed artifact, catalog counts, browser coverage, and native copy/insertion evidence.

## Build

Build the web UI:

```bash
npm run build
```

Build the standalone Tauri executable without platform bundles:

```bash
npm run tauri -- build --no-bundle
```

Install only `src-tauri/target/release/operator-key`. A binary produced by plain `cargo build` loads the development URL and is not standalone. The web build intentionally embeds the complete 1,303-entry catalog for local, offline search. Vite therefore reports the catalog chunk at approximately 958 kB (approximately 148 kB gzip), above its default 500 kB advisory threshold. This is the known catalog payload rather than application-code growth; the warning remains enabled so unrelated bundle growth stays visible.

## Important behavior

The catalog distinguishes hotkeys, slash commands, shell commands, and CLI flags. Every record includes product version, task group, context, safety level, availability, and provenance. Red actions are copy-only. Operator Key has no command-execution action.
