# Using Operator Key

Operator Key helps you find and understand commands. It never executes a command or presses Enter in your terminal. Optional reasoning is disabled until you configure it.

On an empty Find screen, the compact task starters narrow the catalog to a useful task group and fill the search field. Selecting one does not copy, insert, or contact a reasoning provider; the rail disappears once a query is present.

## Desktop support

| Environment | Search and learning | Copy | Guarded terminal insertion |
| --- | --- | --- | --- |
| Browser preview | Yes, bundled reference catalog | Browser clipboard, subject to permission | Never |
| Linux Wayland | Yes | Requires `wl-copy` (`wl-clipboard`) | Only on supported Hyprland with `hyprctl` and `wtype` |
| Linux X11 | Search may run, not a supported native-action target | Not supported by the native clipboard integration | No |
| macOS / Windows | No tested native release | Not claimed | No |

A package installing successfully does not establish compositor compatibility. GNOME/KDE Wayland are not Hyprland: do not expect terminal insertion there. The app checks capabilities and disables unsupported actions.

## Install a published package

Download the package for your architecture and distribution from [GitHub Releases](https://github.com/kevynshorey/operator-key/releases). Also download `SHA256SUMS`. Verify only files you downloaded:

```sh
sha256sum --ignore-missing -c SHA256SUMS
```

Require an `OK` line for your package; an empty result is not verification. A checksum detects a mismatched download; it is not a separately signed identity guarantee.

Debian/Ubuntu, from the download directory:

```sh
sudo apt install ./Operator.Key_VERSION_amd64.deb
sudo apt install wl-clipboard
```

Fedora, from the download directory:

```sh
sudo dnf install ./Operator.Key-VERSION-1.x86_64.rpm
sudo dnf install wl-clipboard
```

Replace `VERSION` with the exact downloaded filename. These are package-manager instructions, not a claim that every distribution/version has been certified. Use a Wayland session. Install `wtype` only if you use the optional supported Hyprland integration.

Launch **Operator Key** from the application menu or run `operator-key`. For an optional Omarchy global shortcut, follow [INSTALL.md](INSTALL.md); the installer first previews changes and requires explicit confirmation. It does not silently rewrite your bindings.

### Omarchy / Arch

Do not install a Debian/RPM package into Arch. The supported developer-managed route remains the standalone production binary:

```sh
npm ci
bash scripts/build-release.sh
```

Use the preview-first installer in [INSTALL.md](INSTALL.md) to install the standalone artifact and optionally bind it. An Arch package/AUR publication is not currently promised. Package-building requires the Tauri system dependencies and Rust toolchain; ordinary deb/rpm consumers do not need the source toolchain.

## Find

Describe the task, choose a product when necessary, and inspect the selected command. Check its context: a slash command belongs inside its agent session, a shortcut is a key combination, and a flag is an option for a parent command—not necessarily a complete command to paste at a shell prompt.

- Up/Down selects results.
- Enter copies the selected catalog text when the clipboard is available.
- Shift+Enter inserts eligible text only on a supported native desktop.
- You decide whether and when to press Enter in the receiving terminal.
- Red commands cannot be inserted by Operator Key.

Favorites are local shortcuts to catalog entries. Recent copies are optional local history, not an execution log. Clear or disable history in Settings. A favorite or history entry is not a saved executable script.

## Learn

Open Learn for product guides and multi-step lessons. Selecting a referenced command returns to Find with that command selected. Missing catalog commands are named rather than hidden. A copied command is not evidence that a lesson step completed successfully.

Use the explicit command-explanation mode to inspect pasted text. Explanations are informational: they must not bypass the catalog's action validation.

## Settings and privacy

Set readability/learning preferences and inspect desktop capabilities and catalog information. Non-secret preferences and saved command references are stored locally. No account is required.

Desktop readiness states how much of Operator Key this desktop runs:

| Mode | Meaning |
| --- | --- |
| Fully supported | Search, copy, and guarded terminal insertion are all available. |
| Partly supported | Search works; some desktop actions are missing a prerequisite. |
| Search and learning work | No desktop action is available here, but the catalog is not affected. |

When an action is unavailable, Settings names the exact prerequisite to install or switch to (for example `wl-copy, from the wl-clipboard package` or `wtype, on PATH`) instead of only reporting "Not confirmed". These prerequisite descriptions are fixed text: they never include your home directory, username, or environment, so the readiness section stays safe to screenshot for a bug report. A named prerequisite is what the same native gate checks before allowing the action, so the list can never disagree with what the app will actually do.

### Setting up the global shortcut

Settings shows a **Global shortcut** section in the native app with the exact installer command to run from a terminal. Operator Key never changes your desktop configuration by itself, and there is deliberately no in-app button that applies it: the installer previews the exact shortcut, config block, backup path and rollback plan without editing anything, and only writes after you type a confirmation phrase. See [INSTALL.md](INSTALL.md) for the full walkthrough. The section describes the preview step rather than reporting whether a shortcut is already installed, because the app does not read your compositor configuration.

The bundled catalog is reference data, not proof that a tool is installed on your computer. For an authoritative local catalog, follow [CATALOG.md](CATALOG.md). A failed local-catalog load falls back to bundled data; inspect catalog health before assuming a refresh succeeded.

Optional reasoning talks to a model you run on loopback. It does not ship a model, endpoint, or credential. See [REASONING.md](REASONING.md) for configuration, supported providers, data boundaries, and disabling/resetting the feature. Never paste a secret into a search or model configuration field. A loopback service is separately operated software: check its own network/privacy behavior as well.

When reasoning is off in the native app, choose **Configure reasoning** in Find to open and focus **Settings → Optional local reasoning**. Search continues to work without a model or account. Settings also reports desktop readiness from the loaded runtime capabilities: native copy requires Wayland and `wl-copy`, while insertion requires Hyprland and `wtype`. “Ready” means the required capability was reported, not that a clipboard or insertion operation has already succeeded. Browser copy remains permission-dependent and browser insertion is unsupported.

## Upgrade and rollback

1. Keep the previous known-good package or binary and its checksum.
2. Close Operator Key before replacing its executable.
3. Verify the new package checksum and install with the same package manager.
4. Launch, search for a familiar command, and verify copy before depending on it.
5. If a regression occurs, close the app and reinstall the previous verified package. On Fedora, an explicit older-package downgrade may be necessary (`dnf downgrade ./exact-older-package.rpm`).

For a standalone install, retain a uniquely named backup and restore that file only after closing the running app. Do not blindly overwrite or remove your compositor configuration. Shortcut rollback is documented separately in [INSTALL.md](INSTALL.md).

App updates and catalog/tool freshness checks are different operations. There is no unattended app updater.

## Troubleshooting

Linux builds default to a conservative compositing mode to mitigate intermittent WebKitGTK renderer shutdown crashes. Explicit renderer environment settings remain respected. See [Linux renderer and shutdown](LINUX_RENDERER.md) for the scope, tradeoffs, and diagnostic override.

- **Copy disabled:** confirm Wayland and `wl-copy` on PATH; browser copy uses browser permissions instead.
- **Insert disabled:** check Hyprland, `hyprctl`, `wtype`, command risk/interface, and a supported terminal. Do not weaken the safety gate.
- **Catalog fallback:** inspect health, repair the local catalog, and reopen. Keep the last known-good catalog until replacement validation succeeds.
- **Reasoning unavailable:** deterministic search still works. Check the configured loopback model service; do not add a cloud endpoint to work around an error.
- **Window tiled:** compositor rules can override application sizing. Use an explicit user-controlled floating rule or the compositor's float action; do not assume every desktop implements always-on-top identically.

When reporting a bug, include app version, distribution, desktop/compositor, action performed, and the error text. Remove private paths, queries, command arguments, and credentials from screenshots or logs. Never upload your reasoning config or terminal history unreviewed.
