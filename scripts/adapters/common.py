"""Shared standard-library catalog adapter primitives."""
from __future__ import annotations

import hashlib
import html
import re
import subprocess
from collections.abc import Iterable
from pathlib import Path

from scripts.chords import canonicalize_chord

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


def run(*cmd: str, timeout: int = 45) -> str:
    try:
        return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def read_optional_text(path: Path) -> str | None:
    """Read an optional UTF-8 customization file, or skip an unusable one."""
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


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
          category: str = "", available: bool = True, provenance: str = "default",
          status: str | None = None, verbatim: bool = False) -> dict:
    if verbatim:
        command, description = command.strip(), description.strip()
    else:
        command, description = clean(command), clean(description)
    risk, destructive = safety(command, description)
    status = status or ("active" if available else "disabled")
    identity = f"{product}\0{interface}\0{command}\0{description}\0{context}\0{provenance}\0{status}"
    return {
        "id": hashlib.sha1(identity.encode()).hexdigest()[:16],
        "product": product,
        "product_version": product_version,
        "interface": interface,
        "task_group": classify(command, description),
        "category": category or classify(command, description),
        "command": command,
        "canonical_chord": canonicalize_chord(command) if interface == "hotkey" else "",
        "aliases": [clean(alias) for alias in aliases if clean(alias)],
        "description": description,
        "context": context,
        "safety_level": risk,
        "destructive": destructive,
        "available": available,
        "conflict_ids": [],
        "source": source,
        "provenance": {
            "kind": provenance,
            "status": status,
            "source": source,
            "version": product_version,
        },
    }


def split_markdown_cells(line: str) -> list[str]:
    """Split a Markdown table row without splitting inline code pipes."""
    cells: list[str] = []
    current: list[str] = []
    in_code = False
    escaped = False
    for char in line.strip().strip("|"):
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            current.append(char)
            # Backslashes are literal inside code spans (including the `\` key).
            # Outside code, retain Markdown's escaped-delimiter behavior.
            escaped = not in_code
        elif char == "`":
            current.append(char)
            in_code = not in_code
        elif char == "|" and not in_code:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def dedupe(rows: Iterable[dict]) -> list[dict]:
    """Deduplicate in input order while preserving Omarchy source parity."""
    result: list[dict] = []
    positions: dict[tuple[str, str, str, str, str, str], int] = {}
    for row in rows:
        provenance = row.get("provenance", {})
        if row.get("product") == "omarchy" and provenance.get("kind") == "default":
            result.append(row)
            continue
        description_key = row.get("description", "").lower() if row.get("product") == "omarchy" else ""
        key = (
            row["product"], row["interface"], row["command"].lower(), row["context"],
            description_key, provenance.get("status", ""),
        )
        index = positions.get(key)
        if index is None:
            positions[key] = len(result)
            result.append(row)
        elif result[index]["source"].startswith("official") and row["source"].startswith("local"):
            result[index] = row
    return result


def parse_help(product: str, binary: str, text: str, product_version: str,
               source: str | None = None) -> list[dict]:
    source = source or f"local: {binary} --help"
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
            match = re.match(r"\s{2,}([a-z][\w-]*)(?:\|[a-z][\w-]*)?(?:\s+\([^)]*\))?\s{2,}(.+)$", raw)
            if match:
                rows.append(entry(product, "shell-command", f"{binary} {match.group(1)}", match.group(2), source,
                                  product_version, context="Shell"))
        elif section in {"options:", "global options:"}:
            match = re.match(r"\s{2,}((?:-[^\s,]+(?:,\s*)?)+|--[\w-]+)(?:\s+<[^>]+>|\s+[A-Z][A-Z_-]*)?\s{2,}(.+)$", raw)
            if match:
                flag = clean(match.group(1).replace(",", " /"))
                rows.append(entry(product, "cli-flag", flag, match.group(2), source,
                                  product_version, context=f"{binary} shell invocation"))
    return rows
