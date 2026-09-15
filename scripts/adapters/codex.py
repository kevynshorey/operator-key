"""Codex CLI local help, config, keymap, and docs adapter."""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

from .common import clean, entry, parse_help as parse_cli_help, run, split_markdown_cells

DOCS_URL = "https://developers.openai.com/codex/developer-commands.md"
SENSITIVE_PARTS = ("api_key", "apikey", "token", "secret", "password", "credential")


def parse_help(text: str, product_version: str, source: str = "local: codex --help") -> list[dict]:
    return parse_cli_help("codex", "codex", text, product_version, source)


def _flatten(value: object, prefix: str = ""):
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            yield from _flatten(child, path)
    else:
        yield prefix, value


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse_config(text: str, product_version: str, source: str) -> list[dict]:
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return []
    rows: list[dict] = []
    for key, value in _flatten(document):
        if not key or any(part in key.lower() for part in SENSITIVE_PARTS):
            continue
        command = f"-c {key}={_toml_value(value)}"
        rows.append(entry("codex", "cli-flag", command, f"Configured Codex setting: {key}", source,
                          product_version, context="codex shell invocation", provenance="override"))
    return rows


def parse_keymap(text: str, product_version: str, source: str) -> list[dict]:
    try:
        document = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return []
    bindings = document.get("bindings", []) if isinstance(document, dict) else document
    rows: list[dict] = []
    for binding in bindings if isinstance(bindings, list) else []:
        if not isinstance(binding, dict) or not binding.get("key"):
            continue
        enabled = binding.get("enabled", True) is not False
        rows.append(entry("codex", "hotkey", str(binding["key"]),
                          str(binding.get("action") or "Codex key binding"), source, product_version,
                          context=str(binding.get("context") or "Codex interactive terminal"),
                          available=enabled, provenance="override",
                          status="active" if enabled else "disabled"))
    return rows


def parse_docs(text: str, product_version: str) -> list[dict]:
    rows: list[dict] = []
    heading = ""
    for line in text.splitlines():
        if line.startswith("#"):
            heading = clean(line.lstrip("# "))
            continue
        if not line.startswith("|") or re.match(r"^\|?\s*:?-+", line):
            continue
        cells = split_markdown_cells(line)
        if len(cells) < 2 or cells[0].lower() in {"command", "shortcut", "action", "key"}:
            continue
        raw, description = clean(cells[0]), clean(cells[1])
        commands = re.findall(r"/[\w-]+", raw)
        if commands:
            for command in commands:
                rows.append(entry("codex", "slash-command", command, description, f"official: {DOCS_URL}",
                                  product_version, context="codex interactive terminal", category=heading,
                                  provenance="official", status="version-gated"))
        elif raw.startswith("codex"):
            rows.append(entry("codex", "shell-command", raw, description, f"official: {DOCS_URL}",
                              product_version, context="Shell", category=heading, provenance="official",
                              status="version-gated"))
    return rows


def collect(product_version: str, docs_text: str, *, home: Path | None = None) -> list[dict]:
    rows = parse_help(run("codex", "--help"), product_version)
    rows += parse_docs(docs_text, product_version)
    home = home or Path.home() / ".codex"
    config = home / "config.toml"
    if config.exists():
        rows += parse_config(config.read_text(encoding="utf-8"), product_version, f"local: {config}")
    for name in ("keymap.json", "keybindings.json"):
        keymap = home / name
        if keymap.exists():
            rows += parse_keymap(keymap.read_text(encoding="utf-8"), product_version, f"local: {keymap}")
    return rows
