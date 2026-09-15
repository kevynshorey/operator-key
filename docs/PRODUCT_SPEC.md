# Operator Key Product Specification

## Product promise

You remember the task. Operator Key remembers the keys.

Operator Key is a local-first, context-aware command layer for Omarchy, Hermes Agent, Claude Code, Codex CLI, tmux, and terminal workflows. It translates operator intent into the correct hotkey, slash command, or shell command for the installed version.

## Problem

Operators often know the outcome they need but cannot remember which tool owns the command, whether the action is a hotkey or slash command, or whether two tools reuse the same key. Static cheat sheets become stale and force users to scan hundreds of unrelated entries.

## Primary operator

A keyboard-oriented business and technical operator using Omarchy and several terminal agents. The operator needs large, fast, low-ambiguity assistance and must not accidentally execute a destructive action.

## Jobs to be done

1. Find a command by describing the desired outcome.
2. Compare equivalent commands across agents.
3. Reverse-lookup what a key or command does.
4. Know whether a command applies in the desktop, shell, agent composer, picker, or modal.
5. Detect conflicts among Omarchy, terminal, tmux, Hermes, Claude, and Codex bindings.
6. Copy or insert a command without retyping it.
7. Learn frequently used commands gradually.

## Information architecture

Primary axis: task.

- Start and resume
- Plan and scope
- Build and edit
- Review and verify
- Debug and recover
- Parallel agents
- Context and memory
- Models and performance
- Capture and input
- System and hardware
- Configuration and safety
- Exit, handoff, and cleanup

Secondary axis: environment.

- Omarchy
- Terminal/shell
- tmux
- Hermes
- Claude Code
- Codex

Tertiary axis: interface type.

- Hotkey
- Slash command
- Shell command
- CLI flag
- Menu action

## Core flows

### Intent lookup

1. Open the overlay.
2. Type a task such as `review my changes`.
3. See one recommended result and agent alternatives.
4. Inspect context, safety, version, and provenance.
5. Copy or insert the result.

### Reverse lookup

1. Type or capture `Ctrl+B`.
2. See every active meaning by application and mode.
3. Highlight conflicts and the currently effective binding.

### Scenario guide

1. Select a scenario such as `agent appears stuck`.
2. Follow an ordered checklist of status, inspection, steering, interruption, and recovery actions.
3. Preserve completion state until the scenario is finished or dismissed.

## Context model

The resolver should consider:

- Active Hyprland window class/title
- Foreground process and ancestor process
- Current directory and Git status
- Running tmux session/pane
- Installed product versions
- Active agent mode or visible dialog when detectable
- User overrides and disabled defaults

Context detection must be advisory. The operator can always switch the selected environment manually.

## Command record

Required fields:

- Stable ID
- Product and installed version
- Interface type
- Task group and category
- Command/chord
- Aliases
- Description
- Active context
- Safety level
- Destructive boolean
- Availability
- Provenance

Planned fields:

- Prerequisites
- Scenario tags
- Conflict set
- User override
- Last verified timestamp
- Favourite and usage count
- Copy/insert/execute capabilities

## Safety policy

Green actions are read-only navigation, inspection, or help.

Amber actions may edit files, execute commands, install software, send content, or change state.

Red actions delete, terminate, bypass safeguards, log out, force operations, or affect production/power state.

The first UI release supports copy and insertion. Direct execution is out of scope until application-aware confirmation and an auditable policy engine exist. Red actions must never execute from a single keystroke.

## Catalog adapters

### Omarchy

Canonical local command:

`omarchy menu keybindings --print`

Read user overrides from `~/.config/hypr/bindings.lua`. Preserve duplicate bindings because press/release or layered behaviors may be intentional.

### Hermes

Use `hermes --help`, subcommand help, the installed slash-command registry, and documented global interactive controls. Record CLI-only and gateway-only restrictions.

### Claude Code

Use `claude --version`, `claude --help`, official command documentation, official interactive shortcut documentation, local custom commands, skills, agents, and keybindings.

### Codex

Use `codex --version`, `codex --help`, official developer-command documentation, `config.toml`, and `/keymap` exports when available.

## Search behavior

Ranking priority:

1. Exact command or chord
2. Alias
3. Task group
4. Description
5. Product
6. Usage frequency and favourites, once enabled

Search must tolerate spacing and modifier-order variations such as `ctrl shift p`, `Ctrl+Shift+P`, and `SHIFT CTRL P`.

## MVP acceptance criteria

- Generates a catalog without third-party Python dependencies.
- Includes all bindings emitted by the installed Omarchy command.
- Includes local shell commands and flags for Hermes, Claude, and Codex.
- Includes Hermes slash commands from the installed command registry.
- Includes official Claude and Codex slash-command/reference data when online, with cached offline regeneration.
- Records product versions and source provenance.
- Supports task, product, interface, and free-text filtering.
- Identifies red/amber/green safety levels.
- Passes deterministic tests and JSON validation.

## Phase 2 overlay

- Tauri overlay summoned by a configurable Omarchy chord.
- Search-as-you-type under 50ms for the local catalog.
- Context lane for the active application.
- Keycap visualization.
- Copy and terminal insertion.
- Conflict explorer.
- Large-text and reduced-motion modes.

## Phase 3 coach

- Private local usage history.
- Frequently repeated lookup detection.
- Five-command daily practice.
- Spaced repetition.
- Personal aliases such as `get back to work` → resume latest session.

## Non-goals for MVP

- Autonomous command execution
- Cloud accounts or synchronization
- Editing agent configuration
- Replacing Omarchy's launcher
- Supporting every editor or operating system
- LLM dependency for basic search

## Success measures

- Median lookup-to-copy under five seconds.
- At least 90% of common operator intents produce a useful top-three result.
- Zero one-keystroke execution of red actions.
- Catalog regeneration accurately reflects installed version changes.
- Repeated lookup frequency falls for commands enrolled in coaching.
