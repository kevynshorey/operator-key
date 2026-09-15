#!/usr/bin/env python3
"""Canonical chord comparison and conflict annotation."""
from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable

MODIFIER_ORDER = ("ctrl", "alt", "shift", "super")
ALIASES = {
    "control": "ctrl",
    "ctl": "ctrl",
    "option": "alt",
    "meta": "super",
    "cmd": "super",
    "command": "super",
    "win": "super",
    "windows": "super",
    "return": "enter",
    "escape": "esc",
}


def _name(token: str) -> str:
    value = re.sub(r"\s+", "", token).lower()
    return ALIASES.get(value, value)


def _canonical_combo(value: str) -> str:
    parts = [_name(part) for part in re.split(r"\s*\+\s*|\s+", value.strip()) if part.strip()]
    modifiers = [modifier for modifier in MODIFIER_ORDER if modifier in parts]
    keys = [part for part in parts if part not in MODIFIER_ORDER]
    return "+".join(modifiers + keys)


def canonicalize_chord(display: str) -> str:
    """Normalize chord spelling/order without modifying the display value."""
    alternatives = [part.strip() for part in re.split(r"\s+/\s+", display.strip()) if part.strip()]
    normalized: list[str] = []
    for alternative in alternatives:
        words = alternative.split()
        is_plus_sequence = len(words) > 1 and all("+" in word for word in words)
        is_plain_sequence = len(words) > 1 and not any(_name(word) in MODIFIER_ORDER for word in words)
        if is_plus_sequence or is_plain_sequence:
            normalized.append(" ".join(_canonical_combo(word) for word in words))
        else:
            normalized.append(_canonical_combo(alternative))
    return " / ".join(normalized)


def _scope(context: str) -> str:
    text = context.lower()
    if "terminal" in text or "shell" in text:
        return "terminal"
    if "hyprland" in text or "desktop" in text:
        return "desktop"
    return re.sub(r"\s+", " ", text).strip()


def contexts_overlap(left: str, right: str) -> bool:
    """Return whether two advisory contexts can consume the same key event."""
    if not left or not right:
        return True
    left_scope, right_scope = _scope(left), _scope(right)
    return left_scope == right_scope or left.lower() in right.lower() or right.lower() in left.lower()


def _components(rows: list[dict]) -> Iterable[list[dict]]:
    remaining = list(rows)
    while remaining:
        component = [remaining.pop(0)]
        changed = True
        while changed:
            changed = False
            for row in list(remaining):
                if any(contexts_overlap(row.get("context", ""), member.get("context", "")) for member in component):
                    remaining.remove(row)
                    component.append(row)
                    changed = True
        yield component


def annotate_conflicts(rows: list[dict]) -> list[dict]:
    """Attach canonical chords/conflict IDs and return deterministic conflict sets."""
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        row["conflict_ids"] = []
        if row.get("interface") != "hotkey":
            row["canonical_chord"] = ""
            continue
        canonical = canonicalize_chord(row.get("command", ""))
        row["canonical_chord"] = canonical
        if not row.get("available", True):
            continue
        for chord in canonical.split(" / "):
            grouped.setdefault(chord, []).append(row)

    conflicts: list[dict] = []
    for chord, candidates in sorted(grouped.items()):
        for component in _components(candidates):
            unique = {row["id"]: row for row in component}
            if len(unique) < 2:
                continue
            entry_ids = sorted(unique)
            contexts = sorted({row.get("context", "") or "global" for row in unique.values()})
            identity = f"{chord}\0{'\0'.join(entry_ids)}"
            conflict_id = hashlib.sha1(identity.encode()).hexdigest()[:16]
            conflict = {
                "id": conflict_id,
                "canonical_chord": chord,
                "context": " | ".join(contexts),
                "entry_ids": entry_ids,
            }
            conflicts.append(conflict)
            for row in unique.values():
                row["conflict_ids"].append(conflict_id)
    return conflicts
