"""Claude Code local help, docs, and customization adapter."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .common import clean, entry, parse_help as parse_cli_help, run

COMMANDS_URL = "https://code.claude.com/docs/en/commands.md"
KEYS_URL = "https://code.claude.com/docs/en/interactive-mode.md"


def parse_help(text: str, product_version: str, source: str = "local: claude --help") -> list[dict]:
    return parse_cli_help("claude-code", "claude", text, product_version, source)


def _frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        return {}
    _, _, tail = text.partition("\n")
    block, separator, _ = tail.partition("\n---")
    if not separator:
        return {}
    values: dict[str, str] = {}
    for line in block.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def _markdown_description(path: Path, fallback: str) -> str:
    try:
        metadata = _frontmatter(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return fallback
    return metadata.get("description") or fallback


def parse_keybindings(text: str, product_version: str, source: str) -> list[dict]:
    try:
        document = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return []
    groups = document if isinstance(document, list) else document.get("keybindings", document.get("bindings", []))
    if isinstance(groups, dict):
        groups = [{"context": "Claude Code interactive terminal", "bindings": groups}]
    rows: list[dict] = []
    for group in groups if isinstance(groups, list) else []:
        if not isinstance(group, dict):
            continue
        context = str(group.get("context") or "Claude Code interactive terminal")
        bindings = group.get("bindings", {})
        if isinstance(bindings, dict):
            items = bindings.items()
        elif isinstance(bindings, list):
            items = ((item.get("key", ""), item.get("action")) for item in bindings if isinstance(item, dict))
        else:
            continue
        for chord, action in items:
            if not chord:
                continue
            enabled = action is not None and action is not False
            description = str(action) if enabled else "Binding disabled by user configuration"
            rows.append(entry("claude-code", "hotkey", str(chord), description, source, product_version,
                              context=context, available=enabled, provenance="override",
                              status="active" if enabled else "disabled"))
    return rows


def parse_customizations(root: Path, product_version: str) -> list[dict]:
    rows: list[dict] = []
    commands = root / "commands"
    if commands.exists():
        for path in sorted(commands.rglob("*.md")):
            relative = path.relative_to(commands).with_suffix("")
            command = "/" + ":".join(relative.parts)
            rows.append(entry("claude-code", "slash-command", command,
                              _markdown_description(path, f"Custom command {command}"), f"local: {path}",
                              product_version, context="Claude Code interactive terminal", provenance="custom"))
    skills = root / "skills"
    if skills.exists():
        for path in sorted(skills.glob("*/SKILL.md")):
            metadata = _frontmatter(path.read_text(encoding="utf-8"))
            name = metadata.get("name") or path.parent.name
            rows.append(entry("claude-code", "slash-command", f"/{name}",
                              metadata.get("description") or f"Custom skill {name}", f"local: {path}",
                              product_version, context="Claude Code interactive terminal", provenance="custom"))
    agents = root / "agents"
    if agents.exists():
        for path in sorted(agents.glob("*.md")):
            metadata = _frontmatter(path.read_text(encoding="utf-8"))
            name = metadata.get("name") or path.stem
            rows.append(entry("claude-code", "cli-flag", f"--agent {name}",
                              metadata.get("description") or f"Use custom agent {name}", f"local: {path}",
                              product_version, context="claude shell invocation", provenance="custom"))
    keybindings = root / "keybindings.json"
    if keybindings.exists():
        rows += parse_keybindings(keybindings.read_text(encoding="utf-8"), product_version, f"local: {keybindings}")
    return rows


def _table_rows(text: str):
    heading = ""
    for line in text.splitlines():
        if line.startswith("#"):
            heading = clean(line.lstrip("# "))
        elif line.startswith("|") and not re.match(r"^\|?\s*:?-+", line):
            cells = [cell.strip() for cell in re.split(r"\|(?![^`]*`)", line.strip().strip("|"))]
            if len(cells) >= 2 and cells[0].lower() not in {"command", "shortcut", "action", "key"}:
                yield heading, cells


def parse_docs(commands_text: str, keys_text: str, product_version: str) -> list[dict]:
    rows: list[dict] = []
    for heading, cells in _table_rows(commands_text):
        description = clean(cells[1])
        for command in re.findall(r"/[\w-]+", clean(cells[0])):
            rows.append(entry("claude-code", "slash-command", command, description,
                              f"official: {COMMANDS_URL}", product_version,
                              context="claude-code interactive terminal", category=heading,
                              provenance="official"))
    for heading, cells in _table_rows(keys_text):
        chord, description = clean(cells[0]), clean(cells[1])
        if chord and description and any(token in chord.lower() for token in ("ctrl", "alt", "option", "shift", "esc", "enter", "tab", "arrow", "cmd", "space")):
            rows.append(entry("claude-code", "hotkey", chord, description, f"official: {KEYS_URL}",
                              product_version, context="claude-code interactive terminal", category=heading,
                              provenance="official", status="version-gated"))
    return rows


def collect(product_version: str, commands_text: str, keys_text: str,
            roots: list[Path] | None = None) -> list[dict]:
    rows = parse_help(run("claude", "--help"), product_version)
    rows += parse_docs(commands_text, keys_text, product_version)
    roots = roots or [Path.home() / ".claude", Path.cwd() / ".claude"]
    seen: set[Path] = set()
    for root in roots:
        resolved = root.resolve()
        if resolved not in seen and root.exists():
            rows += parse_customizations(root, product_version)
            seen.add(resolved)
    return rows
