#!/usr/bin/env python3
"""Build Operator Key's version-aware local command catalog."""
from __future__ import annotations

import argparse
import ast
import datetime as dt
import hashlib
import html
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "data" / "catalog.json"

DOCS = {
    "claude_commands": "https://code.claude.com/docs/en/commands.md",
    "claude_keys": "https://code.claude.com/docs/en/interactive-mode.md",
    "codex_commands": "https://developers.openai.com/codex/developer-commands.md",
}

TASK_RULES = [
    ("review-and-verify", ("review", "diff", "verify", "test", "security")),
    ("parallel-agents", ("agent", "subtask", "background", "worktree", "fork", "queue", "steer")),
    ("context-and-memory", ("context", "compact", "compress", "memory", "skill", "init", "instruction")),
    ("models-and-performance", ("model", "reasoning", "effort", "fast", "usage", "cost", "token")),
    ("debug-and-recover", ("debug", "doctor", "rewind", "rollback", "undo", "interrupt", "stop", "diagnos")),
    ("sessions-and-navigation", ("resume", "continue", "new session", "workspace", "window", "focus", "switch", "move", "layout")),
    ("capture-and-input", ("image", "paste", "copy", "clipboard", "screenshot", "record", "dictation", "voice", "ocr")),
    ("system-and-hardware", ("audio", "volume", "brightness", "wifi", "network", "bluetooth", "power", "lock", "display", "monitor")),
    ("configuration", ("config", "permission", "sandbox", "setting", "theme", "plugin", "mcp", "login", "logout")),
    ("development", ("code", "edit", "build", "run", "shell", "terminal", "file", "git", "deploy")),
]

DANGER_WORDS = ("delete", "remove", "logout", "kill", "bypass", "yolo", "force", "power off", "close all")
AMBER_WORDS = ("edit", "write", "install", "update", "apply", "run", "exec", "move", "send", "publish", "deploy")


def run(*cmd: str) -> str:
    try:
        return subprocess.run(cmd, text=True, capture_output=True, timeout=45, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def version(command: str) -> str:
    text = run(command, "--version").strip()
    if command == "hermes":
        m = re.search(r"Hermes Agent v([^\s]+)", text)
    elif command == "claude":
        m = re.search(r"([^\s]+) \(Claude Code\)", text)
    else:
        m = re.search(r"(?:codex-cli\s+)?([^\s]+)", text)
    return m.group(1) if m else text.splitlines()[0] if text else "unknown"


def clean(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"\[([^]]+)]\([^)]*\)", r"\1", value)
    value = value.replace("**", "").replace("\\", "")
    value = re.sub(r"`([^`]*)`", r"\1", value)
    return html.unescape(re.sub(r"\s+", " ", value)).strip()


def classify(command: str, description: str) -> str:
    haystack = f"{command} {description}".lower()
    for task, words in TASK_RULES:
        if any(word in haystack for word in words):
            return task
    return "help-and-reference"


def safety(command: str, description: str) -> tuple[str, bool]:
    command_text = command.lower()
    description_text = description.lower().lstrip()
    if any(word in command_text for word in DANGER_WORDS) or description_text.startswith(DANGER_WORDS):
        return "red", True
    if any(word in command_text for word in ("review", "diff", "status", "help", "show", "list", "context")):
        return "green", False
    if any(word in command_text for word in AMBER_WORDS) or description_text.startswith(AMBER_WORDS):
        return "amber", False
    return "green", False


def entry(product: str, interface: str, command: str, description: str, source: str,
          product_version: str, *, context: str = "", aliases: Iterable[str] = (),
          category: str = "", available: bool = True) -> dict:
    command, description = clean(command), clean(description)
    risk, destructive = safety(command, description)
    # Description is part of the identity because one physical chord can have
    # separate press/release or layered actions (Omarchy F9 is one example).
    identity = f"{product}\0{interface}\0{command}\0{description}\0{context}"
    return {
        "id": hashlib.sha1(identity.encode()).hexdigest()[:16],
        "product": product,
        "product_version": product_version,
        "interface": interface,
        "task_group": classify(command, description),
        "category": category or classify(command, description),
        "command": command,
        "aliases": [clean(a) for a in aliases if clean(a)],
        "description": description,
        "context": context,
        "safety_level": risk,
        "destructive": destructive,
        "available": available,
        "source": source,
    }


def parse_omarchy(product_version: str) -> list[dict]:
    source = "local: omarchy menu keybindings --print"
    rows = []
    for line in run("omarchy", "menu", "keybindings", "--print").splitlines():
        if "→" not in line:
            continue
        key, description = (part.strip() for part in line.split("→", 1))
        rows.append(entry("omarchy", "hotkey", key, description, source, product_version,
                          context="Omarchy/Hyprland desktop"))
    return rows


def parse_help(product: str, binary: str, product_version: str) -> list[dict]:
    text = run(binary, "--help")
    rows: list[dict] = []
    section = ""
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped in {"Commands:", "Options:", "Global Options:", "positional arguments:", "options:"}:
            section = stripped.lower()
            continue
        if not stripped or stripped.startswith(("Usage:", "usage:", "Arguments:", "Examples:")):
            continue
        if section in {"commands:", "positional arguments:"}:
            m = re.match(r"\s{2,}([a-z][\w-]*)(?:\s+\([^)]*\))?\s{2,}(.+)$", raw)
            if m:
                rows.append(entry(product, "shell-command", f"{binary} {m.group(1)}", m.group(2),
                                  f"local: {binary} --help", product_version,
                                  context="Shell"))
        elif section in {"options:", "global options:"}:
            m = re.match(r"\s{2,}((?:-[^\s,]+(?:,\s*)?)+|--[\w-]+)(?:\s+<[^>]+>|\s+[A-Z][A-Z_-]*)?\s{2,}(.+)$", raw)
            if m:
                flag = clean(m.group(1).replace(",", " /"))
                rows.append(entry(product, "cli-flag", flag, m.group(2),
                                  f"local: {binary} --help", product_version,
                                  context=f"{binary} shell invocation"))
    return rows


def literal(node: ast.AST, default=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return default


def parse_hermes_slash(product_version: str) -> list[dict]:
    version_text = run("hermes", "--version")
    match = re.search(r"Install directory:\s*(.+)", version_text)
    base = Path(match.group(1).strip()) if match else Path.home() / ".hermes" / "hermes-agent"
    path = base / "hermes_cli" / "commands.py"
    if not path.exists():
        return []
    tree = ast.parse(path.read_text(encoding="utf-8"))
    rows = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != "CommandDef":
            continue
        if len(node.args) < 3:
            continue
        name, description, category = (literal(node.args[i], "") for i in range(3))
        if not isinstance(name, str):
            continue
        kw = {item.arg: literal(item.value) for item in node.keywords if item.arg}
        aliases = kw.get("aliases") or ()
        restrictions = [label for label in ("cli_only", "gateway_only") if kw.get(label)]
        context = "Hermes interactive session" + (f"; {', '.join(restrictions)}" if restrictions else "")
        rows.append(entry("hermes", "slash-command", f"/{name}", str(description),
                          f"local source: {path}", product_version, context=context,
                          aliases=[f"/{a}" for a in aliases], category=str(category)))
    return rows


HERMES_KEYS = [
    ("Enter", "Submit the current prompt"),
    ("Alt+Enter / Ctrl+Enter / Ctrl+J", "Insert a newline in the prompt"),
    ("Ctrl+C", "Interrupt the agent; double press to force exit when idle"),
    ("Ctrl+D", "Exit the interactive session"),
    ("Ctrl+L", "Clear or redraw the screen"),
    ("Ctrl+R", "Reverse-search prompt history"),
    ("Ctrl+G / Ctrl+X Ctrl+E", "Open the prompt in the configured external editor"),
    ("Ctrl+S", "Stash or restore a prompt draft"),
    ("Ctrl+V / Alt+V", "Paste an image from the clipboard"),
    ("Ctrl+P", "Open the command palette"),
    ("Ctrl+T / F6", "Open the active-agent monitor"),
    ("F7", "Toggle the active-agent dock"),
    ("Esc Esc", "Open rewind or recovery controls"),
    ("Tab", "Accept an autosuggestion or complete a slash command"),
    ("Up / Down", "Navigate prompt history or the active picker"),
    ("Ctrl+B", "Toggle push-to-talk voice recording when using the default voice key"),
]


def parse_hermes_keys(product_version: str) -> list[dict]:
    return [entry("hermes", "hotkey", key, description,
                  "local source and Hermes 0.21.3 interactive controls", product_version,
                  context="Hermes interactive terminal") for key, description in HERMES_KEYS]


def fetch(url: str, cache_name: str, offline: bool) -> str:
    cache_dir = ROOT / "data" / "source-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / cache_name
    if not offline:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Operator-Key/0.1"})
            with urllib.request.urlopen(req, timeout=30) as response:
                text = response.read().decode("utf-8")
            cache.write_text(text, encoding="utf-8")
            return text
        except (OSError, UnicodeError):
            pass
    return cache.read_text(encoding="utf-8") if cache.exists() else ""


def split_markdown_cells(line: str) -> list[str]:
    """Split a table row without breaking pipes inside inline code."""
    cells, current, in_code, escaped = [], [], False, False
    for char in line.strip().strip("|"):
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            current.append(char)
            escaped = True
        elif char == "`":
            in_code = not in_code
            current.append(char)
        elif char == "|" and not in_code:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def markdown_rows(text: str):
    heading = ""
    for line in text.splitlines():
        if line.startswith("#"):
            heading = clean(line.lstrip("# "))
            continue
        if not line.startswith("|") or re.match(r"^\|?\s*:?-+", line):
            continue
        cells = split_markdown_cells(line)
        if len(cells) >= 2 and cells[0].lower() not in {"command", "shortcut", "action", "key"}:
            yield heading, cells


def parse_docs(product: str, product_version: str, commands_text: str, keys_text: str = "") -> list[dict]:
    rows = []
    source_url = DOCS["claude_commands"] if product == "claude-code" else DOCS["codex_commands"]
    for heading, cells in markdown_rows(commands_text):
        raw = clean(cells[0])
        description = clean(cells[1])
        if not raw or not description:
            continue
        # Store the stable slash-command token. Argument syntax belongs in the
        # description/category; keeping it in the command breaks aliases that
        # contain Markdown pipes (for example low|medium|high).
        candidates = re.findall(r"/[\w-]+", raw)
        if candidates:
            for candidate in candidates:
                rows.append(entry(product, "slash-command", candidate.strip(), description,
                                  f"official: {source_url}", product_version,
                                  context=f"{product} interactive terminal", category=heading))
        elif raw.startswith(("codex", "claude")):
            rows.append(entry(product, "shell-command", raw, description, f"official: {source_url}",
                              product_version, context="Shell", category=heading))
    if keys_text:
        key_url = DOCS["claude_keys"]
        for heading, cells in markdown_rows(keys_text):
            raw, description = clean(cells[0]), clean(cells[1])
            if raw and description and any(token in raw.lower() for token in
                                           ("ctrl", "alt", "option", "shift", "esc", "enter", "tab", "arrow", "cmd", "space")):
                rows.append(entry(product, "hotkey", raw, description, f"official: {key_url}",
                                  product_version, context=f"{product} interactive terminal", category=heading))
    return rows


def dedupe(rows: Iterable[dict]) -> list[dict]:
    seen: dict[tuple[str, str, str, str, str], dict] = {}
    for row in rows:
        # Omarchy may intentionally attach multiple actions to the same chord.
        # Keep distinct descriptions while still collapsing duplicate sources.
        description_key = row["description"].lower() if row["product"] == "omarchy" else ""
        key = (row["product"], row["interface"], row["command"].lower(), row["context"], description_key)
        current = seen.get(key)
        if current is None or (current["source"].startswith("official") and row["source"].startswith("local")):
            seen[key] = row
    return sorted(seen.values(), key=lambda r: (r["product"], r["task_group"], r["interface"], r["command"].lower()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--offline", action="store_true", help="Use cached official documentation")
    args = parser.parse_args()

    versions = {
        "omarchy": run("pacman", "-Q", "omarchy").strip().split()[1] if run("pacman", "-Q", "omarchy").strip() else "unknown",
        "hermes": version("hermes"),
        "claude-code": version("claude"),
        "codex": version("codex"),
    }
    claude_commands = fetch(DOCS["claude_commands"], "claude-commands.md", args.offline)
    claude_keys = fetch(DOCS["claude_keys"], "claude-interactive-mode.md", args.offline)
    codex_commands = fetch(DOCS["codex_commands"], "codex-developer-commands.md", args.offline)

    rows = []
    rows += parse_omarchy(versions["omarchy"])
    rows += parse_help("hermes", "hermes", versions["hermes"])
    rows += parse_hermes_slash(versions["hermes"])
    rows += parse_hermes_keys(versions["hermes"])
    rows += parse_help("claude-code", "claude", versions["claude-code"])
    rows += parse_docs("claude-code", versions["claude-code"], claude_commands, claude_keys)
    rows += parse_help("codex", "codex", versions["codex"])
    rows += parse_docs("codex", versions["codex"], codex_commands)
    rows = dedupe(rows)

    counts = {}
    for row in rows:
        counts[row["product"]] = counts.get(row["product"], 0) + 1
    document = {
        "schema_version": "1.0.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "host": os.uname().nodename,
        "versions": versions,
        "counts": counts,
        "total": len(rows),
        "entries": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "total": len(rows), "counts": counts, "versions": versions}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
