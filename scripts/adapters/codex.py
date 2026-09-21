"""Codex CLI local help, config, keymap, and docs adapter."""
from __future__ import annotations

import json
import math
import re
import tomllib
from pathlib import Path

from .common import clean, entry, parse_help as parse_cli_help, read_optional_text, run, split_markdown_cells, portable_path

DOCS_URL = "https://developers.openai.com/codex/developer-commands.md"

MODEL_IDENTIFIER = re.compile(r"(?:gpt|codex|o[1-9])[-A-Za-z0-9._:]*", re.IGNORECASE)
SAFE_BOOLEAN_PATHS = frozenset({
    "allow_login_shell",
    "analytics.enabled",
    "check_for_update_on_startup",
    "disable_paste_burst",
    "feedback.enabled",
    "hide_agent_reasoning",
    "model_supports_reasoning_summaries",
    "sandbox_workspace_write.exclude_slash_tmp",
    "sandbox_workspace_write.exclude_tmpdir_env_var",
    "sandbox_workspace_write.network_access",
    "show_raw_agent_reasoning",
    "tui.animations",
    "tui.raw_output_mode",
    "tui.show_tooltips",
    "tui.vim_mode_default",
    "features.apps",
    "features.code_mode.enabled",
    "features.context_management.experimental_mode",
    "features.enable_request_compression",
    "features.fast_mode",
    "features.goals",
    "features.hooks",
    "features.memories",
    "features.multi_agent",
    "features.personality",
    "features.prevent_idle_sleep",
    "features.remote_plugin",
    "features.shell_snapshot",
    "features.shell_tool",
    "features.skill_mcp_dependency_install",
    "features.unified_exec",
    "features.web_search",
    "features.web_search_cached",
    "features.web_search_request",
})
SAFE_ENUM_PATHS = {
    "approval_policy": frozenset({"never", "on-request"}),
    "approvals_reviewer": frozenset({"auto_review", "user"}),
    "file_opener": frozenset({"cursor", "none", "vscode", "vscode-insiders", "windsurf"}),
    "model_auto_compact_token_limit_scope": frozenset({"body_after_prefix", "total"}),
    "model_reasoning_effort": frozenset({"high", "low", "medium", "minimal", "xhigh"}),
    "model_reasoning_summary": frozenset({"auto", "concise", "detailed", "none"}),
    "model_verbosity": frozenset({"high", "low", "medium"}),
    "personality": frozenset({"friendly", "none", "pragmatic"}),
    "sandbox_mode": frozenset({"danger-full-access", "read-only", "workspace-write"}),
    "tui.alternate_screen": frozenset({"always", "auto", "never"}),
    "tui.notification_condition": frozenset({"always", "unfocused"}),
    "tui.notification_method": frozenset({"auto", "bel", "osc9"}),
    "tui.resume_cwd": frozenset({"current", "session"}),
    "web_search": frozenset({"cached", "disabled", "indexed", "live"}),
}
SAFE_NUMBER_PATHS = frozenset({
    "background_terminal_max_timeout",
    "model_auto_compact_token_limit",
    "model_context_window",
})


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


def _is_safe_config_value(path: str, value: object) -> bool:
    """Only expose documented, non-secret scalar Codex settings."""
    if path == "model":
        return isinstance(value, str) and len(value) <= 128 and MODEL_IDENTIFIER.fullmatch(value) is not None
    if path in SAFE_BOOLEAN_PATHS:
        return isinstance(value, bool)
    if path in SAFE_ENUM_PATHS:
        return isinstance(value, str) and value in SAFE_ENUM_PATHS[path]
    if path in SAFE_NUMBER_PATHS:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value >= 0
        )
    return False


def parse_config(text: str, product_version: str, source: str) -> list[dict]:
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return []
    rows: list[dict] = []
    for key, value in _flatten(document):
        if not key or not _is_safe_config_value(key, value):
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
    config_text = read_optional_text(config)
    if config_text is not None:
        rows += parse_config(config_text, product_version, f"local: {portable_path(config)}")
    for name in ("keymap.json", "keybindings.json"):
        keymap = home / name
        keymap_text = read_optional_text(keymap)
        if keymap_text is not None:
            rows += parse_keymap(keymap_text, product_version, f"local: {portable_path(keymap)}")
    return rows
