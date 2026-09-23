# Using your own catalog

Operator Key ships a catalog built from the tools installed on the machine that produced
the release. Your machine has different tools, and different versions of them.

You can point the app at your own catalog without rebuilding the application.

## Build a catalog from your machine

```bash
python3 scripts/build_catalog.py
```

This reads `--help` output from the tools you actually have installed. It needs only
Python's standard library. The result is written to `data/catalog.json`.

## Install it

Copy it to the location the app reads at startup:

```bash
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/operator-key"
cp data/catalog.json "${XDG_DATA_HOME:-$HOME/.local/share}/operator-key/catalog.json"
```

Restart Operator Key. Your commands, from your versions, are now what it searches.

To go back to the shipped catalog, delete that file.

## What a sidecar catalog may and may not change

This file is read at startup, so it is worth being precise about how far it is trusted.
The app types command text into a live terminal, which makes the catalog the trust anchor
for that text.

**It may** add commands the shipped catalog has never seen, and refresh the text,
description and metadata of commands it already knows.

**It may not lower a safety classification.** If the reviewed catalog marks an entry red,
it stays red no matter what the file says. A sidecar cannot relabel `git push --force` as
safe and get it inserted behind a green badge.

**A command that is new to the app never arrives as green.** An unrecognised entry is
clamped to amber at minimum, because nothing has reviewed it.

**A broken file changes nothing.** If it is missing, unreadable, larger than 32 MB, not a
regular file, empty, or not valid JSON, the app silently uses its built-in catalog. It
will not start with no catalog.

These rules are enforced in `src-tauri/src/actions.rs` and covered by tests, including one
that writes a hostile file to the real location and confirms a red command is still
refused.

## Why safety is not simply recomputed

A reasonable-sounding alternative is to ignore the file's labels and recompute risk from
the command text. It was measured against the shipped catalog and rejected: 33 entries are
deliberately classified *below* what word matching alone produces, because the adapters
understand things a word list cannot — `--force-with-lease` is the safe form of a force
push, `--dry-run` writes nothing.

Recomputing would paint those red. A red badge that fires on safe commands is the one
failure this product cannot afford: operators stop reading it, and then it cannot warn
them about anything real.

## Catalog health invoke contract

`catalog_health` returns `{ "source": "embedded" | "sidecar", "failure": null | "path_unavailable" | "unreadable" | "unsafe_file_type" | "too_large" | "malformed" }`. It does not return paths, file contents, or parser details. Sidecar health is computed from the same merge/validation path used by the catalog snapshot; missing sidecar is a healthy embedded source (`failure: null`). An invalid sidecar reports embedded source plus a safe failure category.
