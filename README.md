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
- Deterministic unit tests

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

## Verify

```bash
python3 -m unittest discover -s tests -v
python3 -m json.tool data/catalog.json >/dev/null
```

## Important behavior

The catalog distinguishes hotkeys, slash commands, shell commands, and CLI flags. Every record includes product version, task group, context, safety level, availability, and provenance. Red actions are reference-only in the planned UI and must never execute without explicit confirmation.
