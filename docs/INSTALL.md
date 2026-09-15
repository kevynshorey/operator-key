# Omarchy installation

Operator Key ships a preview-first installer that adds one managed Omarchy binding without rewriting any other user configuration.

## Requirements

- Omarchy/Hyprland with `hyprctl` and `omarchy` on `PATH`
- Python 3.11 or newer
- Node.js/npm and the Rust/Tauri toolchain to build Operator Key
- The system libraries required by Tauri on your distribution

Run commands from the repository root.

## Build the launcher

For a local development build:

```sh
npm ci
npm run tauri build -- --debug --no-bundle
```

The default installer source is `src-tauri/target/release/operator-key` when it exists, otherwise `src-tauri/target/debug/operator-key`. Select a build explicitly with `--binary` when both exist or when reviewing a particular artifact.

## Preview (the default)

```sh
python3 scripts/install-omarchy-binding.py \
  --binary "$PWD/src-tauri/target/debug/operator-key"
```

Preview is read-only: it does **not** change `~/.config/hypr/bindings.lua`, install a binary, reload Hyprland, trigger a binding, or launch Operator Key.

Typical output identifies the target and backup, the source and stable destination (`~/.local/bin/operator-key`), the source SHA-256, every candidate decision, and an exact block like:

```lua
-- >>> Operator Key managed binding >>>
o.bind("SUPER + SHIFT + K", "Operator Key", o.launch("/home/you/.local/bin/operator-key"))
-- <<< Operator Key managed binding <<<
```

Omarchy's user bindings file already defines `o`; its helper contract accepts `o.bind(chord, description, o.launch(absolute_path))`. The installer preserves the exact bytes and mode outside this uniquely marked block, including the file's newline style.

### Candidate and conflict rules

Candidates are checked in this order:

1. `SUPER + SHIFT + K`
2. `SUPER + SHIFT + Q`
3. `SUPER + SHIFT + U`
4. `SUPER + CTRL + Y`
5. `SUPER + CTRL + U`

The installer queries `hyprctl -j binds`, with `omarchy menu keybindings --print` as a fallback. Modifier order, aliases, and physical keys are normalized, so an existing press, release, locked, repeat, or long-press binding rejects that physical chord. The first unused candidate wins. Supply repeated `--candidate` options to review a different ordered list. If all candidates conflict, nothing is proposed.

## Apply

Review the complete preview, then run the same command with `--apply`:

```sh
python3 scripts/install-omarchy-binding.py \
  --binary "$PWD/src-tauri/target/debug/operator-key" \
  --apply
```

The installer requires both `--apply` and the exact typed phrase shown at the prompt, such as `APPLY SUPER + SHIFT + K`. There is no non-interactive approval option: stdin must be a TTY, and EOF, a mismatch, or a non-TTY invocation fails without applying.

Apply regenerates and checks the exact proposed config bytes, and rechecks the config, source hash, destination hash, and backup paths immediately before mutation. It reads the written config and destination back before reload and requires the reviewed bytes and SHA-256. Symlinks and non-regular files are rejected. Existing regular backups are preserved and never silently overwritten. New files are written through same-directory temporary files, flushed, mode-set, and atomically replaced. Commands use exact argument arrays, never a shell.

On success it re-reads `hyprctl -j binds`, requires exactly one binding on the selected physical chord with description `Operator Key`, and rejects a late conflict. Omarchy's Lua bridge reports this active binding with dispatcher `__lua` and a numeric callback argument. The installer requires that exact dispatcher and a bounded, strictly positive decimal argument; unexpected or unsafe active data fails closed. It captures clients, then invokes the registered callback with the exact no-shell argument array `hyprctl dispatch __lua <validated-arg>`. This exercises the action attached to the installed active binding without relying on synthetic keyboard routing or direct-spawning the destination.

The dispatcher command must succeed and produce a new client whose `class` or `initialClass` is exactly `operator-key`; the title, reverse-domain identifiers, and substrings do not count. The new client must include a PID, and `/proc/<pid>/exe` must resolve exactly to the installed destination. An invalid dispatcher record, failed dispatch, missing PID, or mismatched executable causes verification to fail and rollback rather than producing a false success.

`wtype` is not an installer verification dependency. It is required only for Operator Key's optional guarded terminal-insertion runtime feature described in the README.

If any mutation, reload, binding check, or end-to-end trigger check fails, rollback independently attempts config restoration, launcher restoration/removal, and (whenever config mutation was attempted) a Hyprland reload. Every rollback error is reported; one failed restoration never skips later steps. The original config backup is `bindings.lua.operator-key.bak`; a replaced launcher is backed up as `operator-key.operator-key.bak` beside the destination.

## Verify manually

```sh
hyprctl -j binds
sha256sum "$HOME/.local/bin/operator-key"
```

Confirm the selected chord has description `Operator Key`, the installed hash matches the preview, and pressing the chord opens the launcher. Escape and the close button should close the process rather than merely hide its window.

## Uninstall

Preview only:

```sh
python3 scripts/install-omarchy-binding.py --uninstall
```

Apply after reviewing the preview:

```sh
python3 scripts/install-omarchy-binding.py --uninstall --apply
```

The typed phrase is `UNINSTALL OPERATOR KEY`, and a TTY is mandatory. Uninstall recognizes only a strict three-line generated block: an exact unindented begin marker, one canonical generated `o.bind(...)` line, and an exact unindented end marker, all with one newline style. Marker text inside strings/long strings, comments, indented lines, or larger lines is not managed state. Extra content, malformed exact markers, or multiple exact blocks are rejected without mutation. The destination is taken only from that validated block. After reload, uninstall re-reads `hyprctl -j binds` and requires the managed chord/description to be absent; failure runs the same best-effort complete rollback.

## Manual recovery

Do not copy a backup blindly if its origin is uncertain. Inspect it first and stop Hyprland configuration edits while recovering.

1. Restore the reviewed config backup atomically or copy its contents back to `~/.config/hypr/bindings.lua`, preserving its original mode.
2. If a launcher existed before install, restore the reviewed `~/.local/bin/operator-key.operator-key.bak` to `~/.local/bin/operator-key` and restore its executable mode. Otherwise remove only the installed regular file.
3. Run `hyprctl reload`.
4. Re-run the installer without `--apply` and inspect the new preview.

If any target or backup is a symlink, directory, device, or other non-regular file, leave it untouched and resolve that filesystem condition manually before retrying.
