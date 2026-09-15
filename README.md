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
- Deterministic Python and TypeScript tests

This milestone is reference-only: pressing Enter reports a copy placeholder, and no native copy, insert, or command execution action is wired. Those actions begin in Task 6.

## Install and develop

Install the pinned frontend dependencies:

```bash
npm install
```

Run the browser UI:

```bash
npm run dev
```

Run the desktop overlay in Tauri development mode:

```bash
npm run tauri dev
```

## Generate the catalog

```bash
python3 scripts/build_catalog.py
```

Use cached official documentation when offline:

```bash
python3 scripts/build_catalog.py --offline
```

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
python3 -m unittest discover -s tests -v
python3 -m json.tool data/catalog.json >/dev/null
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

## Build

Build the web UI:

```bash
npm run build
```

Build a local debug Tauri executable without platform bundles:

```bash
npm run tauri build -- --debug --no-bundle
```

The web build intentionally embeds the complete 1,302-entry catalog for local, offline search. Vite therefore reports the catalog chunk at approximately 952 kB (approximately 146 kB gzip), above its default 500 kB advisory threshold. This is the known catalog payload rather than application-code growth; the warning remains enabled so unrelated bundle growth stays visible.

## Important behavior

The catalog distinguishes hotkeys, slash commands, shell commands, and CLI flags. Every record includes product version, task group, context, safety level, availability, and provenance. Red actions are reference-only in the planned UI and must never execute without explicit confirmation.
