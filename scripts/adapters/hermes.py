"""Hermes Agent local help, registry, and key-control adapter."""
from __future__ import annotations

import ast
import re
from pathlib import Path

from .common import entry, parse_help as parse_cli_help, run

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
    ("Ctrl+B", "Toggle push-to-talk voice recording"),
]


def _literal(node: ast.AST, default=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return default


def parse_help(text: str, product_version: str, source: str = "local: hermes --help") -> list[dict]:
    return parse_cli_help("hermes", "hermes", text, product_version, source)


def parse_registry(text: str, product_version: str, source: str) -> list[dict]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    rows: list[dict] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function_name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
        if function_name != "CommandDef" or len(node.args) < 3:
            continue
        name, description, category = (_literal(node.args[index], "") for index in range(3))
        if not isinstance(name, str) or not name:
            continue
        keywords = {item.arg: _literal(item.value) for item in node.keywords if item.arg}
        restrictions = [label for label in ("cli_only", "gateway_only") if keywords.get(label)]
        context = "Hermes interactive session" + (f"; {', '.join(restrictions)}" if restrictions else "")
        rows.append(entry(
            "hermes", "slash-command", f"/{name}", str(description), source, product_version,
            context=context, aliases=[f"/{alias}" for alias in keywords.get("aliases") or ()],
            category=str(category), provenance="default",
        ))
    return rows


def _voice_key(config_text: str) -> str | None:
    in_voice = False
    voice_indent = 0
    for raw in config_text.splitlines():
        content = raw.split("#", 1)[0].rstrip()
        if not content.strip():
            continue
        indent = len(content) - len(content.lstrip())
        if re.match(r"^\s*voice\s*:\s*$", content):
            in_voice, voice_indent = True, indent
            continue
        if in_voice and indent <= voice_indent:
            in_voice = False
        if in_voice:
            match = re.match(r"^\s*record_key\s*:\s*['\"]?([^'\"#]+?)['\"]?\s*$", content)
            if match:
                raw_key = match.group(1).strip().lower()
                prefix, _, key = raw_key.partition("-")
                if prefix in {"a", "alt"}:
                    return f"Alt+{key.title()}"
                if prefix in {"c", "ctrl"}:
                    return f"Ctrl+{key.title()}"
    return None


def parse_controls(config_text: str, product_version: str,
                   source: str = "local source and Hermes interactive controls") -> list[dict]:
    configured = _voice_key(config_text)
    rows: list[dict] = []
    for chord, description in HERMES_KEYS:
        if chord == "Ctrl+B" and configured and configured != chord:
            rows.append(entry("hermes", "hotkey", chord, description, source, product_version,
                              context="Hermes interactive terminal", available=False,
                              provenance="default", status="disabled"))
        else:
            rows.append(entry("hermes", "hotkey", chord, description, source, product_version,
                              context="Hermes interactive terminal", provenance="default"))
    if configured and configured != "Ctrl+B":
        rows.append(entry("hermes", "hotkey", configured, "Toggle push-to-talk voice recording",
                          "local: Hermes voice.record_key", product_version,
                          context="Hermes interactive terminal", provenance="override"))
    return rows


def collect(product_version: str, *, install_dir: Path | None = None,
            config_path: Path | None = None, include_subcommands: bool = True) -> list[dict]:
    help_text = run("hermes", "--help")
    rows = parse_help(help_text, product_version)
    if include_subcommands:
        commands = [row["command"].split(maxsplit=1)[1] for row in rows if row["interface"] == "shell-command"]
        for command in commands:
            rows += parse_cli_help("hermes", f"hermes {command}", run("hermes", command, "--help", timeout=10),
                                   product_version, f"local: hermes {command} --help")
    if install_dir is None:
        match = re.search(r"Install directory:\s*(.+)", run("hermes", "--version"))
        install_dir = Path(match.group(1).strip()) if match else Path.home() / ".hermes" / "hermes-agent"
    registry = install_dir / "hermes_cli" / "commands.py"
    if registry.exists():
        rows += parse_registry(registry.read_text(encoding="utf-8"), product_version, f"local source: {registry}")
    config_path = config_path or Path.home() / ".hermes" / "config.yaml"
    config_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    rows += parse_controls(config_text, product_version)
    return rows
