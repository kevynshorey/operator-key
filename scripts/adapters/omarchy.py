"""Omarchy/Hyprland binding adapter."""
from __future__ import annotations

import re
from pathlib import Path

from .common import entry, read_optional_text, run

DEFAULT_OVERRIDES = Path.home() / ".config" / "hypr" / "bindings.lua"


def _active_lua_lines(text: str):
    for raw in text.splitlines():
        line = raw.split("--", 1)[0].strip()
        if line:
            yield line


def parse_overrides(text: str) -> tuple[list[str], list[tuple[str, str]]]:
    unbound: list[str] = []
    bound: list[tuple[str, str]] = []
    for line in _active_lua_lines(text):
        match = re.search(r"\bhl\.unbind\(\s*(['\"])(.*?)\1\s*\)", line)
        if match:
            unbound.append(match.group(2))
            continue
        match = re.search(
            r"\bo\.bind\(\s*(['\"])(.*?)\1\s*,\s*(?:(['\"])(.*?)\3|nil)\s*,\s*(['\"])(.*?)\5",
            line,
        )
        if match:
            description = match.group(4) or match.group(6) or "User binding"
            bound.append((match.group(2), description))
    return unbound, bound


def parse_bindings(text: str, product_version: str, *, overrides_text: str = "",
                   source: str = "local: omarchy menu keybindings --print",
                   overrides_source: str = "local: ~/.config/hypr/bindings.lua") -> list[dict]:
    unbound, bound = parse_overrides(overrides_text)
    rows: list[dict] = []
    for line in text.splitlines():
        if "→" not in line:
            continue
        chord, description = (part.strip() for part in line.split("→", 1))
        rows.append(entry(
            "omarchy", "hotkey", chord, description, source, product_version,
            context="Omarchy/Hyprland desktop", provenance="default", verbatim=True,
        ))
    for chord in unbound:
        rows.append(entry(
            "omarchy", "hotkey", chord, "Default binding disabled by user override",
            overrides_source, product_version, context="Omarchy/Hyprland desktop",
            available=False, provenance="override", status="disabled",
        ))
    for chord, description in bound:
        rows.append(entry(
            "omarchy", "hotkey", chord, description, overrides_source, product_version,
            context="Omarchy/Hyprland desktop", provenance="override", status="active",
        ))
    return rows


def collect(product_version: str, overrides_path: Path = DEFAULT_OVERRIDES) -> list[dict]:
    overrides_text = read_optional_text(overrides_path) or ""
    return parse_bindings(
        run("omarchy", "menu", "keybindings", "--print"), product_version,
        overrides_text=overrides_text, overrides_source=f"local: {overrides_path}",
    )
