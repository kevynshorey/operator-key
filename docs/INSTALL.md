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

Preview is read-only: it does **not** change `~/.config/hypr/bindings.lua`, install a binary, reload Hyprland, or launch Operator Key. `--yes` is also harmless unless combined with `--apply`.

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

The installer requires both `--apply` and the exact typed phrase shown at the prompt, such as `APPLY SUPER + SHIFT + K`. For reviewed automation, `--apply --yes` bypasses that prompt; it is intentionally dangerous and should only be used after a human has approved a preview produced from the same files.

Apply rechecks the config, source, destination, and backup paths immediately before mutation. Symlinks and non-regular files are rejected. Existing regular backups are preserved and never silently overwritten. New files are written through same-directory temporary files, flushed, mode-set, and atomically replaced. The installer uses exact argument arrays—not a shell—to run `hyprctl reload` and the installed launcher.

On success it verifies the active binding, launches the installed executable, and waits for a new Operator Key Hyprland client. That verified app instance is deliberately left running for the user; closing it with Escape or the close button exits the process so the global launcher can start a fresh instance later.

If any mutation, reload, binding check, or launch check fails, the installer restores the exact prior config and launcher bytes and modes. It reloads Hyprland after rollback whenever the config may have changed. The original config backup is `bindings.lua.operator-key.bak`; a replaced launcher is backed up as `operator-key.operator-key.bak` beside the destination.

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

The typed phrase is `UNINSTALL OPERATOR KEY`. Uninstall removes only the uniquely marked block and the absolute launcher destination recorded inside that block. It preserves every other byte, writes `bindings.lua.operator-key.uninstall.bak` without overwriting an existing regular backup, reloads Hyprland, and transactionally restores the config and launcher if removal fails.

## Manual recovery

Do not copy a backup blindly if its origin is uncertain. Inspect it first and stop Hyprland configuration edits while recovering.

1. Restore the reviewed config backup atomically or copy its contents back to `~/.config/hypr/bindings.lua`, preserving its original mode.
2. If a launcher existed before install, restore the reviewed `~/.local/bin/operator-key.operator-key.bak` to `~/.local/bin/operator-key` and restore its executable mode. Otherwise remove only the installed regular file.
3. Run `hyprctl reload`.
4. Re-run the installer without `--apply` and inspect the new preview.

If any target or backup is a symlink, directory, device, or other non-regular file, leave it untouched and resolve that filesystem condition manually before retrying.
