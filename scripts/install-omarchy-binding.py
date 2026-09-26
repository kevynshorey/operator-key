#!/usr/bin/env python3
"""Preview-first installer for the Operator Key Omarchy binding."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

BEGIN_MARKER = "-- >>> Operator Key managed binding >>>"
END_MARKER = "-- <<< Operator Key managed binding <<<"
DEFAULT_CANDIDATES = (
    "SUPER + SHIFT + K",
    "SUPER + SHIFT + Q",
    "SUPER + SHIFT + U",
    "SUPER + CTRL + Y",
    "SUPER + CTRL + U",
)
# Task 5: closed allowlist of named alias actions. Each maps a NAME the user may
# select to a fixed human description and a fixed command string. There is no
# flag that accepts a command: anything not in this table cannot be installed.
# Commands must contain no double quotes or newlines (they sit inside one
# double-quoted Lua string) — enforced by tests and by parse-time validation.
@dataclass(frozen=True)
class AliasAction:
    description: str
    command: str


ALIAS_ACTIONS: dict[str, AliasAction] = {
    # Restore the pre-3.1.0 Omarchy ChatGPT chord for muscle memory: same
    # webapp launch Omarchy itself uses for its ChatGPT binding.
    "chatgpt-classic": AliasAction(
        description="ChatGPT (Operator Key alias)",
        command="omarchy-launch-webapp https://chatgpt.com",
    ),
    # Region screenshot via Omarchy's own capture helper.
    "screenshot": AliasAction(
        description="Screenshot (Operator Key alias)",
        command="omarchy-capture-screenshot",
    ),
}


MODMASK = (
    (1, "SHIFT"),
    (4, "CTRL"),
    (8, "ALT"),
    (64, "SUPER"),
)
MOD_ALIASES = {
    "SHIFT": "shift",
    "CTRL": "ctrl",
    "CONTROL": "ctrl",
    "ALT": "alt",
    "OPTION": "alt",
    "SUPER": "super",
    "MOD4": "super",
    "META": "super",
    "WIN": "super",
}
MOD_ORDER = {"ctrl": 0, "shift": 1, "alt": 2, "super": 3}
DISPLAY_ORDER = {"super": 0, "shift": 1, "ctrl": 2, "alt": 3}
KEY_ALIASES = {
    "enter": "return",
    "return": "return",
    "esc": "escape",
    "escape": "escape",
    "spacebar": "space",
}
SAFE_PATH = re.compile(r"^/[A-Za-z0-9_./+-]+$")
OPERATOR_KEY_CLASS = "operator-key"
PHYSICAL_VERIFICATION_TIMEOUT = 120.0
CLIENT_QUERY_TIMEOUT = 5.0
CLIENT_POLL_INTERVAL = 0.25


class InstallError(RuntimeError):
    """A safe, user-actionable installation failure."""


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class Binding:
    chord: str
    physical: str
    description: str
    trigger: str
    source: str
    dispatcher: str = ""
    arg: str = ""


@dataclass(frozen=True)
class InstallPlan:
    target: Path
    backup: Path
    source: Path
    destination: Path
    source_hash: str
    chord: str
    aliases: tuple[tuple[str, str], ...]
    decisions: tuple[str, ...]
    block: bytes
    proposed: bytes
    original: bytes
    target_mode: int


@dataclass(frozen=True)
class UninstallPlan:
    target: Path
    backup: Path
    destination: Path | None
    chord: str
    original: bytes
    proposed: bytes
    target_mode: int


class SubprocessRunner:
    def run(self, args: Sequence[str], *, timeout: float | None = None) -> CommandResult:
        try:
            completed = subprocess.run(
                list(args),
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return CommandResult(127, "", str(error))
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def canonicalize_chord(chord: str) -> str:
    tokens = [token for token in re.split(r"\s*\+\s*|\s+", chord.strip()) if token]
    if not tokens:
        raise InstallError("Binding chord is empty")
    modifiers: set[str] = set()
    keys: list[str] = []
    for token in tokens:
        alias = MOD_ALIASES.get(token.upper())
        if alias:
            modifiers.add(alias)
        else:
            key = token.lower()
            keys.append(KEY_ALIASES.get(key, key))
    if len(keys) != 1:
        raise InstallError(f"Binding chord must contain exactly one physical key: {chord!r}")
    ordered = sorted(modifiers, key=MOD_ORDER.__getitem__)
    return "+".join([*ordered, keys[0]])


def display_chord(physical: str) -> str:
    parts = physical.split("+")
    names = {"ctrl": "CTRL", "shift": "SHIFT", "alt": "ALT", "super": "SUPER"}
    modifiers = sorted(parts[:-1], key=DISPLAY_ORDER.__getitem__)
    return " + ".join(names.get(part, part.upper()) for part in [*modifiers, parts[-1]])


def parse_alias_specs(specs: Sequence[str]) -> tuple[tuple[str, str], ...]:
    """Parse NAME=CHORD alias requests against the closed allowlist.

    Returns (name, display_chord) pairs. Every failure is an InstallError so the
    CLI reports it as a safe, user-actionable refusal with nothing proposed.
    """
    parsed: list[tuple[str, str]] = []
    seen_names: set[str] = set()
    seen_physical: dict[str, str] = {}
    for spec in specs:
        name, separator, raw_chord = spec.partition("=")
        name = name.strip()
        if not separator or not name or not raw_chord.strip():
            raise InstallError(f"Alias must look like NAME=CHORD, got {spec!r}")
        if name not in ALIAS_ACTIONS:
            allowed = ", ".join(sorted(ALIAS_ACTIONS))
            raise InstallError(f"Unknown alias {name!r}; the closed allowlist is: {allowed}")
        if name in seen_names:
            raise InstallError(f"duplicate alias name {name!r}")
        physical = canonicalize_chord(raw_chord)
        if physical in seen_physical:
            raise InstallError(
                f"duplicate alias chord {display_chord(physical)!r}: "
                f"already requested for {seen_physical[physical]!r}"
            )
        seen_names.add(name)
        seen_physical[physical] = name
        parsed.append((name, display_chord(physical)))
    return tuple(parsed)


def _trigger(row: dict) -> str:
    flags = []
    if row.get("release"):
        flags.append("release")
    else:
        flags.append("press")
    if row.get("locked"):
        flags.append("locked")
    if row.get("repeat") or row.get("repeating"):
        flags.append("repeat")
    if row.get("longPress"):
        flags.append("long-press")
    return ", ".join(flags)


def parse_hyprctl_binds(payload: str) -> list[Binding]:
    try:
        rows = json.loads(payload)
    except json.JSONDecodeError as error:
        raise InstallError(f"hyprctl returned malformed binding JSON: {error}") from error
    if not isinstance(rows, list):
        raise InstallError("hyprctl binding JSON must be an array")
    parsed = []
    for row in rows:
        if not isinstance(row, dict):
            raise InstallError("hyprctl binding entry must be an object")
        key = str(row.get("key") or "").strip()
        keycode = row.get("keycode", 0)
        if not key and keycode:
            key = f"code:{keycode}"
        if not key:
            continue
        try:
            mask = int(row.get("modmask", 0))
        except (TypeError, ValueError) as error:
            raise InstallError("hyprctl binding modmask must be an integer") from error
        modifiers = [name for bit, name in MODMASK if mask & bit]
        canonical_modifiers = sorted(
            (MOD_ALIASES[name] for name in modifiers), key=MOD_ORDER.__getitem__
        )
        canonical_key = KEY_ALIASES.get(key.lower(), key.lower())
        physical = "+".join([*canonical_modifiers, canonical_key])
        parsed.append(
            Binding(
                chord=display_chord(physical),
                physical=physical,
                description=str(row.get("description") or "(no description)"),
                trigger=_trigger(row),
                source="hyprctl -j binds",
                dispatcher=str(row.get("dispatcher") or ""),
                arg=str(row.get("arg") or ""),
            )
        )
    return parsed


def parse_omarchy_print(payload: str) -> list[Binding]:
    parsed = []
    for raw_line in payload.splitlines():
        if "→" not in raw_line:
            continue
        chord, description = raw_line.split("→", 1)
        chord = chord.strip()
        try:
            physical = canonicalize_chord(chord)
        except InstallError:
            continue
        parsed.append(
            Binding(
                chord=display_chord(physical),
                physical=physical,
                description=description.strip() or "(no description)",
                trigger="press (details unavailable from text fallback)",
                source="omarchy menu keybindings --print",
            )
        )
    if not parsed and payload.strip():
        raise InstallError("Could not parse Omarchy keybinding output")
    return parsed


def collect_active_bindings(runner) -> list[Binding]:
    structured = runner.run(["hyprctl", "-j", "binds"], timeout=5)
    if structured.returncode == 0:
        return parse_hyprctl_binds(structured.stdout)
    fallback = runner.run(["omarchy", "menu", "keybindings", "--print"], timeout=5)
    if fallback.returncode == 0:
        return parse_omarchy_print(fallback.stdout)
    raise InstallError(
        "Cannot inspect active bindings: hyprctl and Omarchy keybinding queries failed "
        f"({structured.stderr.strip() or structured.returncode}; "
        f"{fallback.stderr.strip() or fallback.returncode})"
    )


def choose_candidate(
    active: Iterable[Binding], candidates: Sequence[str] = DEFAULT_CANDIDATES
) -> tuple[str, tuple[str, ...]]:
    by_physical: dict[str, list[Binding]] = {}
    for binding in active:
        by_physical.setdefault(binding.physical, []).append(binding)
    decisions = []
    selected = None
    for candidate in candidates:
        physical = canonicalize_chord(candidate)
        display = display_chord(physical)
        conflicts = by_physical.get(physical, [])
        if conflicts:
            details = "; ".join(
                f"{item.description} [{item.trigger}] via {item.source}" for item in conflicts
            )
            decisions.append(f"{display}: rejected — conflicts with {details}")
        elif selected is None:
            selected = display
            decisions.append(f"{display}: available — first unused ergonomic candidate")
        else:
            decisions.append(f"{display}: not evaluated — earlier candidate is available")
    if selected is None:
        raise InstallError("No unused candidate chord remains; no change was proposed")
    return selected, tuple(decisions)


def _lstat_regular(path: Path, label: str, *, must_exist: bool) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if must_exist:
            raise InstallError(f"{label} does not exist: {path}")
        return None
    if stat.S_ISLNK(info.st_mode):
        raise InstallError(f"Refusing {label} symlink surprise: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise InstallError(f"{label} must be a regular file: {path}")
    return info


def validate_command_path(path: Path) -> None:
    value = str(path)
    if not path.is_absolute() or not SAFE_PATH.fullmatch(value) or ".." in path.parts:
        raise InstallError(
            f"Refusing unsafe launcher path {value!r}; use an absolute path containing only "
            "letters, digits, _, ., /, +, or -"
        )


def _line_parts(line: bytes) -> tuple[bytes, bytes]:
    if line.endswith(b"\r\n"):
        return line[:-2], b"\r\n"
    if line.endswith(b"\n"):
        return line[:-1], b"\n"
    return line, b""


def _advance_lua_long_state(body: bytes, long_end: bytes | None) -> bytes | None:
    """Track Lua long strings/comments so marker-looking data is ignored."""
    index = 0
    while index < len(body):
        if long_end is not None:
            close = body.find(long_end, index)
            if close < 0:
                return long_end
            index = close + len(long_end)
            long_end = None
            continue
        if body.startswith(b"--", index):
            opener = re.match(rb"\[(=*)\[", body[index + 2 :])
            if opener:
                long_end = b"]" + opener.group(1) + b"]"
                index += 2 + len(opener.group(0))
                continue
            return None
        if body[index:index + 1] in (b'"', b"'"):
            quote = body[index:index + 1]
            index += 1
            while index < len(body):
                if body[index:index + 1] == b"\\":
                    index += 2
                elif body[index:index + 1] == quote:
                    index += 1
                    break
                else:
                    index += 1
            continue
        opener = re.match(rb"\[(=*)\[", body[index:])
        if opener:
            long_end = b"]" + opener.group(1) + b"]"
            index += len(opener.group(0))
            continue
        index += 1
    return long_end


def _managed_block(content: bytes) -> tuple[int, int, str, Path] | None:
    lines = content.splitlines(keepends=True)
    offsets: list[int] = []
    begins: list[int] = []
    ends: list[int] = []
    offset = 0
    long_end: bytes | None = None
    for index, line in enumerate(lines):
        offsets.append(offset)
        body, _ = _line_parts(line)
        in_code = long_end is None
        if in_code and body == BEGIN_MARKER.encode():
            begins.append(index)
        elif in_code and body == END_MARKER.encode():
            ends.append(index)
        long_end = _advance_lua_long_state(body, long_end)
        offset += len(line)
    if len(begins) != len(ends) or len(begins) > 1:
        raise InstallError("Malformed or ambiguous Operator Key marker blocks")
    if not begins:
        return None
    begin_index, end_index = begins[0], ends[0]
    if end_index < begin_index + 2:
        raise InstallError("managed Operator Key block must contain a binding line")
    block_lines = lines[begin_index:end_index + 1]
    parts = [_line_parts(line) for line in block_lines]
    endings = [ending for _, ending in parts]
    if not endings[0] or len(set(endings)) != 1:
        raise InstallError("Managed Operator Key block must use one consistent newline style")
    try:
        binding_line = parts[1][0].decode("utf-8")
    except UnicodeDecodeError as error:
        raise InstallError("Managed Operator Key binding is not valid UTF-8") from error
    match = re.fullmatch(
        r'o\.bind\("([^"\r\n]+)", "Operator Key", o\.launch\("([^"\r\n]+)"\)\)',
        binding_line,
    )
    if not match:
        raise InstallError("Managed Operator Key block does not contain the exact generated binding")
    chord, raw_destination = match.groups()
    if display_chord(canonicalize_chord(chord)) != chord:
        raise InstallError("Managed Operator Key chord is not canonical")
    destination = Path(raw_destination)
    validate_command_path(destination)
    # Any further interior lines must each be one exact allowlisted alias
    # binding. Anything else — including a formerly allowlisted command that
    # was edited by hand — is not a managed block this tool will touch.
    for body, _ in parts[2:-1]:
        try:
            alias_line = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise InstallError("Managed Operator Key alias line is not valid UTF-8") from error
        alias_match = re.fullmatch(
            r'o\.bind\("([^"\r\n]+)", "([^"\r\n]+)", "([^"\r\n]+)"\)',
            alias_line,
        )
        recognized = False
        if alias_match:
            alias_chord, description, command = alias_match.groups()
            for action in ALIAS_ACTIONS.values():
                if description == action.description and command == action.command:
                    recognized = display_chord(canonicalize_chord(alias_chord)) == alias_chord
                    break
        if not recognized:
            raise InstallError(
                "managed Operator Key block contains a line that is not an "
                "exact generated allowlisted alias binding"
            )
    start = offsets[begin_index]
    stop = offsets[end_index] + len(lines[end_index])
    return start, stop, chord, destination


def _validate_markers(content: bytes) -> tuple[int | None, int | None]:
    block = _managed_block(content)
    return (None, None) if block is None else block[:2]


def newline_for(content: bytes) -> bytes:
    return b"\r\n" if b"\r\n" in content else b"\n"


def make_block(
    chord: str,
    destination: Path,
    newline: bytes,
    aliases: Sequence[tuple[str, str]] = (),
) -> bytes:
    validate_command_path(destination)
    lines = [BEGIN_MARKER, f'o.bind("{chord}", "Operator Key", o.launch("{destination}"))']
    for name, alias_chord in aliases:
        action = ALIAS_ACTIONS[name]
        lines.append(f'o.bind("{alias_chord}", "{action.description}", "{action.command}")')
    lines.append(END_MARKER)
    ending = newline.decode()
    return (ending.join(lines) + ending).encode()


def replace_managed_block(content: bytes, block: bytes) -> bytes:
    start, stop = _validate_markers(content)
    if start is not None and stop is not None:
        return content[:start] + block + content[stop:]
    newline = newline_for(content)
    separator = b"" if not content or content.endswith((b"\n", b"\r")) else newline
    return content + separator + block


def remove_managed_block(content: bytes) -> bytes:
    start, stop = _validate_markers(content)
    if start is None or stop is None:
        return content
    return content[:start] + content[stop:]


def managed_chord(content: bytes) -> str | None:
    block = _managed_block(content)
    return None if block is None else block[2]


def managed_alias_bindings(content: bytes) -> tuple[tuple[str, str], ...]:
    """Return (physical_chord, description) for each alias line in the managed block.

    _managed_block has already proven every interior line is exactly generated,
    so this re-parse cannot meet an unexpected shape.
    """
    block = _managed_block(content)
    if block is None:
        return ()
    start, stop = block[0], block[1]
    pairs: list[tuple[str, str]] = []
    for raw in content[start:stop].splitlines()[2:-1]:
        match = re.fullmatch(
            r'o\.bind\("([^"\r\n]+)", "([^"\r\n]+)", "([^"\r\n]+)"\)',
            raw.decode("utf-8"),
        )
        if match:
            alias_chord, description, _ = match.groups()
            pairs.append((canonicalize_chord(alias_chord), description))
    return tuple(pairs)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def create_plan(
    *,
    target: Path,
    source: Path,
    destination: Path,
    runner,
    candidates: Sequence[str] = DEFAULT_CANDIDATES,
    aliases: Sequence[tuple[str, str]] = (),
) -> InstallPlan:
    target = Path(target)
    source = Path(source)
    destination = Path(destination)
    validate_command_path(destination)
    target_info = _lstat_regular(target, "bindings target", must_exist=True)
    source_info = _lstat_regular(source, "source binary", must_exist=True)
    _lstat_regular(destination, "launcher destination", must_exist=False)
    assert target_info is not None and source_info is not None
    if not source_info.st_mode & stat.S_IXUSR:
        raise InstallError(f"Source binary is not executable: {source}")
    original = target.read_bytes()
    _validate_markers(original)
    source_bytes = source.read_bytes()
    active = collect_active_bindings(runner)
    previous_chord = managed_chord(original)
    if previous_chord is not None:
        previous_physical = canonicalize_chord(previous_chord)
        for index, binding in enumerate(active):
            if binding.physical == previous_physical and binding.description == "Operator Key":
                del active[index]
                break
    # A rerun must also ignore its OWN previously installed alias bindings.
    # Same standard as the launcher line above: exclude exactly one active
    # binding per previous alias, matched on BOTH physical chord and exact
    # description — anything else on those chords stays and conflicts.
    for previous_physical, description in managed_alias_bindings(original):
        for index, binding in enumerate(active):
            if binding.physical == previous_physical and binding.description == description:
                del active[index]
                break
    chord, decisions = choose_candidate(active, candidates)
    launcher_physical = canonicalize_chord(chord)
    by_physical: dict[str, list[Binding]] = {}
    for binding in active:
        by_physical.setdefault(binding.physical, []).append(binding)
    for name, alias_chord in aliases:
        physical = canonicalize_chord(alias_chord)
        if physical == launcher_physical:
            raise InstallError(
                f"Alias {name!r} chord {alias_chord} conflicts with the launcher chord {chord}"
            )
        conflicts = by_physical.get(physical, [])
        if conflicts:
            details = "; ".join(
                f"{item.description} [{item.trigger}] via {item.source}" for item in conflicts
            )
            raise InstallError(
                f"Alias {name!r} chord {alias_chord} conflicts with {details}; no change was proposed"
            )
    block = make_block(chord, destination, newline_for(original), aliases)
    return InstallPlan(
        target=target,
        backup=Path(str(target) + ".operator-key.bak"),
        source=source,
        destination=destination,
        source_hash=sha256(source_bytes),
        chord=chord,
        aliases=tuple(aliases),
        decisions=decisions,
        block=block,
        proposed=replace_managed_block(original, block),
        original=original,
        target_mode=stat.S_IMODE(target_info.st_mode),
    )


def render_preview(plan: InstallPlan) -> str:
    diff_action = "replace the existing uniquely marked block" if _managed_block(plan.original) is not None else "append one uniquely marked block"
    decisions = "\n".join(f"  - {item}" for item in plan.decisions)
    if plan.aliases:
        alias_lines = "\n".join(
            f"  - {alias_chord} -> {ALIAS_ACTIONS[name].description}: exact command {ALIAS_ACTIONS[name].command!r}"
            for name, alias_chord in plan.aliases
        )
        aliases_section = f"Aliases: {len(plan.aliases)} from the closed allowlist\n{alias_lines}\n"
    else:
        aliases_section = "Aliases: none requested\n"
    return (
        "Operator Key Omarchy install preview (no files changed)\n"
        f"Target: {plan.target}\n"
        f"Backup: {plan.backup}\n"
        f"Binding: {plan.chord}\n"
        + aliases_section +
        f"Change: {diff_action}; all other bytes remain unchanged\n"
        f"Source binary: {plan.source}\n"
        f"Destination: {plan.destination}\n"
        f"SHA-256: {plan.source_hash}\n"
        "Candidate decisions:\n"
        f"{decisions}\n"
        "Exact managed block:\n"
        f"{plan.block.decode().rstrip()}\n"
        "Apply verification steps:\n"
        "  1. Atomically copy the prebuilt binary and update bindings.lua\n"
        "  2. Run exact argv: hyprctl reload\n"
        "  3. Re-read hyprctl -j binds and require one exact Operator Key chord/description\n"
        f"  4. You must physically press {plan.chord} within 120 seconds; require a new exact-class client\n"
        "  5. On any failure, restore exact prior bytes/modes and run hyprctl reload again\n"
    )


def _atomic_write(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _lstat_regular(path, "write target", must_exist=False)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temp_path.unlink(missing_ok=True)


def _unlink_regular(path: Path, label: str) -> None:
    """Remove a regular file without following a last-minute symlink swap."""
    if _lstat_regular(path, label, must_exist=False) is not None:
        path.unlink()


def _backup_if_absent(path: Path, data: bytes, mode: int, label: str) -> None:
    """Create one durable backup, while preserving any existing regular backup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if _lstat_regular(path, label, must_exist=False) is not None:
        return
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_path, mode)
        try:
            os.link(temp_path, path, follow_symlinks=False)
        except FileExistsError:
            _lstat_regular(path, label, must_exist=True)
            return
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temp_path.unlink(missing_ok=True)


def _successful(result: CommandResult, label: str) -> None:
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise InstallError(f"{label} failed: {detail}")


def _verify_binding(plan: InstallPlan, runner) -> Binding:
    result = runner.run(["hyprctl", "-j", "binds"], timeout=5)
    _successful(result, "binding verification")
    physical = canonicalize_chord(plan.chord)
    bindings = parse_hyprctl_binds(result.stdout)
    on_chord = [item for item in bindings if item.physical == physical]
    managed = [item for item in on_chord if item.description == "Operator Key"]
    if not managed:
        raise InstallError(f"Active binding verification did not find Operator Key on {plan.chord}")
    if len(on_chord) != 1:
        details = "; ".join(
            f"{item.description} ({item.dispatcher or 'unknown dispatcher'})" for item in on_chord
        )
        raise InstallError(f"Post-reload verification found a conflicting active binding: {details}")
    for name, alias_chord in plan.aliases:
        alias_physical = canonicalize_chord(alias_chord)
        expected = ALIAS_ACTIONS[name].description
        on_alias = [item for item in bindings if item.physical == alias_physical]
        if not any(item.description == expected for item in on_alias):
            raise InstallError(
                f"Active binding verification did not find alias {name!r} on {alias_chord}"
            )
        if len(on_alias) != 1:
            details = "; ".join(
                f"{item.description} ({item.dispatcher or 'unknown dispatcher'})" for item in on_alias
            )
            raise InstallError(
                f"Post-reload verification found a conflicting active binding on {alias_chord}: {details}"
            )
    return managed[0]


def _validate_plan_integrity(plan: InstallPlan, source_bytes: bytes) -> None:
    expected_block = make_block(plan.chord, plan.destination, newline_for(plan.original), plan.aliases)
    expected_proposed = replace_managed_block(plan.original, expected_block)
    if plan.block != expected_block or plan.proposed != expected_proposed:
        raise InstallError("Install plan bytes are not the exact generated config; preview again")
    if sha256(source_bytes) != plan.source_hash:
        raise InstallError("Source binary changed after preview; preview again before applying")


def _operator_clients(runner, *, timeout: float = CLIENT_QUERY_TIMEOUT) -> dict[str, dict]:
    try:
        result = runner.run(["hyprctl", "-j", "clients"], timeout=timeout)
    except (subprocess.TimeoutExpired, TimeoutError) as error:
        raise InstallError(f"window verification query timed out: {error}") from error
    _successful(result, "window verification")
    try:
        clients = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise InstallError(f"hyprctl returned malformed client JSON: {error}") from error
    if not isinstance(clients, list):
        raise InstallError("hyprctl client JSON must be an array")
    matches: dict[str, dict] = {}
    for client in clients:
        if not isinstance(client, dict):
            continue
        identities = {str(client.get(field) or "") for field in ("class", "initialClass")}
        if OPERATOR_KEY_CLASS in identities:
            identity = str(
                client.get("address") or client.get("stableId") or
                f"pid:{client.get('pid')}:{json.dumps(client, sort_keys=True)}"
            )
            matches[identity] = client
    return matches


def resolve_process_exe(pid: int) -> Path:
    return Path(os.readlink(f"/proc/{pid}/exe"))


def _verify_launch(
    plan: InstallPlan, runner, process_exe_resolver, prompt_shortcut,
    *, monotonic=time.monotonic, sleep=time.sleep,
    verification_timeout: float = PHYSICAL_VERIFICATION_TIMEOUT,
) -> None:
    deadline = monotonic() + verification_timeout

    def require_time_remaining() -> float:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise InstallError("Physical shortcut verification timed out")
        return remaining

    def query_clients() -> dict[str, dict]:
        remaining = require_time_remaining()
        clients = _operator_clients(runner, timeout=min(CLIENT_QUERY_TIMEOUT, remaining))
        require_time_remaining()
        return clients

    before = query_clients()
    prompt_shortcut(plan.chord)
    while True:
        current = query_clients()
        for identity in current.keys() - before.keys():
            client = current[identity]
            pid = client.get("pid")
            if pid is None:
                raise InstallError("New exact-class Operator Key client did not include a PID")
            try:
                executable = Path(process_exe_resolver(int(pid))).resolve()
            except (OSError, TypeError, ValueError) as error:
                raise InstallError(f"Could not resolve new Operator Key client executable: {error}") from error
            require_time_remaining()
            if executable != plan.destination.resolve():
                raise InstallError(
                    f"New exact-class client executable {executable} does not match {plan.destination}"
                )
            require_time_remaining()
            return
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        sleep(min(CLIENT_POLL_INTERVAL, remaining))
    raise InstallError(
        "Physical shortcut verification did not observe a new exact-class Operator Key client"
    )


def _rollback(actions: Sequence[tuple[str, Callable[[], None]]]) -> list[str]:
    errors = []
    for label, action in actions:
        try:
            action()
        except Exception as error:
            errors.append(f"{label} failed: {error}")
    return errors


def _raise_transaction_failure(operation: str, error: Exception, rollback_errors: list[str]) -> None:
    if rollback_errors:
        raise InstallError(
            f"{operation} failed: {error}; rollback incomplete: " + "; ".join(rollback_errors)
        ) from error
    raise InstallError(f"{operation} failed and file changes were rolled back: {error}") from error


def apply_plan(
    plan: InstallPlan, *, runner, confirm: Callable[[str], bool],
    process_exe_resolver: Callable[[int], Path] = resolve_process_exe,
    prompt_shortcut: Callable[[str], None] | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    verification_timeout: float = PHYSICAL_VERIFICATION_TIMEOUT,
) -> None:
    if prompt_shortcut is None:
        prompt_shortcut = _interactive_shortcut_prompt
    phrase = f"APPLY {plan.chord}"
    if not confirm(phrase):
        raise InstallError("Confirmation declined; no files changed")
    current_info = _lstat_regular(plan.target, "bindings target", must_exist=True)
    source_info = _lstat_regular(plan.source, "source binary", must_exist=True)
    destination_info = _lstat_regular(plan.destination, "launcher destination", must_exist=False)
    assert current_info is not None and source_info is not None
    current = plan.target.read_bytes()
    if current not in (plan.original, plan.proposed):
        raise InstallError("bindings.lua changed after preview; preview again before applying")
    source_bytes = plan.source.read_bytes()
    _validate_plan_integrity(plan, source_bytes)
    old_destination = plan.destination.read_bytes() if destination_info else None
    old_destination_mode = stat.S_IMODE(destination_info.st_mode) if destination_info else None
    if current == plan.proposed and old_destination == source_bytes:
        _successful(runner.run(["hyprctl", "reload"], timeout=10), "Hyprland reload")
        _verify_binding(plan, runner)
        _verify_launch(
            plan, runner, process_exe_resolver, prompt_shortcut,
            monotonic=monotonic, sleep=sleep, verification_timeout=verification_timeout,
        )
        return
    binary_backup = Path(str(plan.destination) + ".operator-key.bak")
    # Inspect every backup before creating either one, so a symlink or special
    # file cannot be discovered only after another file has already changed.
    _lstat_regular(plan.backup, "bindings backup", must_exist=False)
    _lstat_regular(binary_backup, "launcher backup", must_exist=False)
    _backup_if_absent(plan.backup, plan.original, plan.target_mode, "bindings backup")
    if old_destination is not None:
        _backup_if_absent(
            binary_backup, old_destination, old_destination_mode or 0o700, "launcher backup"
        )

    # Final preflight immediately before primary mutations. Atomic writes also
    # lstat their own target immediately before replace.
    _lstat_regular(plan.backup, "bindings backup", must_exist=True)
    _lstat_regular(binary_backup, "launcher backup", must_exist=old_destination is not None)
    _lstat_regular(plan.target, "bindings target", must_exist=True)
    _lstat_regular(plan.source, "source binary", must_exist=True)
    _lstat_regular(plan.destination, "launcher destination", must_exist=False)
    if plan.target.read_bytes() != current or sha256(plan.source.read_bytes()) != plan.source_hash:
        raise InstallError("Install inputs changed during preflight; preview again before applying")
    if (plan.destination.read_bytes() if plan.destination.exists() else None) != old_destination:
        raise InstallError("Launcher destination changed during preflight; preview again before applying")

    destination_attempted = False
    target_attempted = False
    try:
        destination_attempted = True
        _atomic_write(plan.destination, source_bytes, stat.S_IMODE(source_info.st_mode) | stat.S_IXUSR)
        target_attempted = True
        _atomic_write(plan.target, plan.proposed, plan.target_mode)
        if plan.target.read_bytes() != plan.proposed:
            raise InstallError("Written bindings config does not match exact proposed bytes")
        if sha256(plan.destination.read_bytes()) != plan.source_hash:
            raise InstallError("Installed launcher hash does not match reviewed source hash")
        _successful(runner.run(["hyprctl", "reload"], timeout=10), "Hyprland reload")
        _verify_binding(plan, runner)
        _verify_launch(
            plan, runner, process_exe_resolver, prompt_shortcut,
            monotonic=monotonic, sleep=sleep, verification_timeout=verification_timeout,
        )
    except Exception as error:
        if destination_attempted or target_attempted:
            actions: list[tuple[str, Callable[[], None]]] = []
            if target_attempted:
                actions.append(("config restore", lambda: _atomic_write(
                    plan.target, current, stat.S_IMODE(current_info.st_mode)
                )))
            if old_destination is None:
                actions.append(("destination removal", lambda: _unlink_regular(
                    plan.destination, "launcher destination"
                )))
            else:
                actions.append(("destination restore", lambda: _atomic_write(
                    plan.destination, old_destination, old_destination_mode or 0o700
                )))
            if target_attempted:
                actions.append(("rollback reload", lambda: _successful(
                    runner.run(["hyprctl", "reload"], timeout=10), "Hyprland rollback reload"
                )))
            _raise_transaction_failure("Install", error, _rollback(actions))
        raise


def create_uninstall_plan(*, target: Path) -> UninstallPlan:
    target = Path(target)
    target_info = _lstat_regular(target, "bindings target", must_exist=True)
    assert target_info is not None
    original = target.read_bytes()
    managed = _managed_block(original)
    if managed is None:
        raise InstallError("No Operator Key managed marker block is installed")
    _, _, chord, destination = managed
    _lstat_regular(destination, "launcher destination", must_exist=False)
    return UninstallPlan(
        target=target,
        backup=Path(str(target) + ".operator-key.uninstall.bak"),
        destination=destination,
        chord=chord,
        original=original,
        proposed=remove_managed_block(original),
        target_mode=stat.S_IMODE(target_info.st_mode),
    )


def render_uninstall_preview(plan: UninstallPlan) -> str:
    return (
        "Operator Key Omarchy uninstall preview (no files changed)\n"
        f"Target: {plan.target}\n"
        f"Backup: {plan.backup}\n"
        "Change: remove the uniquely marked block; preserve every other byte\n"
        f"Installed launcher to remove: {plan.destination or '(not recognized; left untouched)'}\n"
        "Verification: run exact argv hyprctl reload and confirm the managed binding is absent\n"
        "Rollback: restore exact config and launcher bytes/modes, then reload, on failure\n"
    )


def _verify_binding_absent(plan: UninstallPlan, runner) -> None:
    result = runner.run(["hyprctl", "-j", "binds"], timeout=5)
    _successful(result, "uninstall binding verification")
    physical = canonicalize_chord(plan.chord)
    bindings = parse_hyprctl_binds(result.stdout)
    if any(item.physical == physical and item.description == "Operator Key" for item in bindings):
        raise InstallError(f"Operator Key managed binding is still active on {plan.chord}")


def apply_uninstall(plan: UninstallPlan, *, runner, confirm: Callable[[str], bool]) -> None:
    if not confirm("UNINSTALL OPERATOR KEY"):
        raise InstallError("Confirmation declined; no files changed")
    current_info = _lstat_regular(plan.target, "bindings target", must_exist=True)
    assert current_info is not None
    if plan.target.read_bytes() != plan.original:
        raise InstallError("bindings.lua changed after preview; preview again before uninstalling")
    old_binary = None
    old_binary_mode = None
    if plan.destination is not None:
        destination_info = _lstat_regular(plan.destination, "launcher destination", must_exist=False)
        if destination_info:
            old_binary = plan.destination.read_bytes()
            old_binary_mode = stat.S_IMODE(destination_info.st_mode)
    _lstat_regular(plan.backup, "uninstall backup", must_exist=False)
    _backup_if_absent(plan.backup, plan.original, plan.target_mode, "uninstall backup")
    _lstat_regular(plan.backup, "uninstall backup", must_exist=True)
    _lstat_regular(plan.target, "bindings target", must_exist=True)
    if plan.target.read_bytes() != plan.original:
        raise InstallError("bindings.lua changed during preflight; preview again before uninstalling")
    if plan.destination is not None:
        _lstat_regular(plan.destination, "launcher destination", must_exist=False)
        if (plan.destination.read_bytes() if plan.destination.exists() else None) != old_binary:
            raise InstallError("Installed launcher changed during preflight; preview again before uninstalling")

    target_attempted = False
    try:
        target_attempted = True
        _atomic_write(plan.target, plan.proposed, plan.target_mode)
        if plan.destination is not None:
            _unlink_regular(plan.destination, "launcher destination")
        _successful(runner.run(["hyprctl", "reload"], timeout=10), "Hyprland reload")
        _verify_binding_absent(plan, runner)
        if plan.destination is not None and _lstat_regular(
            plan.destination, "launcher destination", must_exist=False
        ) is not None:
            raise InstallError("Installed launcher still exists after uninstall")
    except Exception as error:
        if target_attempted:
            actions: list[tuple[str, Callable[[], None]]] = [
                ("config restore", lambda: _atomic_write(
                    plan.target, plan.original, plan.target_mode
                ))
            ]
            if plan.destination is not None and old_binary is not None:
                actions.append(("destination restore", lambda: _atomic_write(
                    plan.destination, old_binary, old_binary_mode or 0o700
                )))
            elif plan.destination is not None:
                actions.append(("destination removal", lambda: _unlink_regular(
                    plan.destination, "launcher destination"
                )))
            actions.append(("rollback reload", lambda: _successful(
                runner.run(["hyprctl", "reload"], timeout=10), "Hyprland rollback reload"
            )))
            _raise_transaction_failure("Uninstall", error, _rollback(actions))
        raise


def _interactive_confirmation(expected: str) -> bool:
    if not sys.stdin.isatty():
        raise InstallError("Apply requires an interactive terminal and exact typed confirmation")
    try:
        typed = input(f"Type {expected!r} to continue: ")
    except EOFError as error:
        raise InstallError("Apply confirmation input ended before a response") from error
    return typed == expected


def _interactive_shortcut_prompt(chord: str) -> None:
    if not sys.stdin.isatty():
        raise InstallError("Physical shortcut verification requires an interactive terminal")
    print(f"Press {chord} within 120 seconds to verify...", flush=True)


def _default_source(repo: Path) -> Path:
    return repo / "src-tauri" / "target" / "release" / "operator-key"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=Path, default=Path.home() / ".config/hypr/bindings.lua")
    parser.add_argument("--binary", type=Path, default=_default_source(repo), help="prebuilt executable source")
    parser.add_argument("--destination", type=Path, default=Path.home() / ".local/bin/operator-key")
    parser.add_argument("--candidate", action="append", dest="candidates", help="candidate chord, in preference order")
    parser.add_argument(
        "--alias", action="append", dest="aliases", default=[], metavar="NAME=CHORD",
        help="optional named alias from the closed allowlist (%s); repeatable"
        % ", ".join(sorted(ALIAS_ACTIONS)),
    )
    parser.add_argument("--apply", action="store_true", help="apply only after preview and confirmation")

    parser.add_argument("--uninstall", action="store_true", help="preview/remove the managed block and installed launcher")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    runner = SubprocessRunner()
    try:
        if args.uninstall:
            plan = create_uninstall_plan(target=args.target.expanduser())
            print(render_uninstall_preview(plan), end="")
            if args.apply:
                apply_uninstall(
                    plan,
                    runner=runner,
                    confirm=_interactive_confirmation,
                )
                print("Uninstall verified.")
            return 0
        plan = create_plan(
            target=args.target.expanduser(),
            source=args.binary.expanduser(),
            destination=args.destination.expanduser(),
            runner=runner,
            candidates=args.candidates or DEFAULT_CANDIDATES,
            aliases=parse_alias_specs(args.aliases),
        )
        print(render_preview(plan), end="")
        if args.apply:
            apply_plan(
                plan,
                runner=runner,
                confirm=_interactive_confirmation,
                prompt_shortcut=_interactive_shortcut_prompt,
            )
            print("Install, reload, and end-to-end binding verification passed.")
        return 0
    except InstallError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
