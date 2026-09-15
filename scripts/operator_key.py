#!/usr/bin/env python3
"""Search the generated Operator Key command catalog."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "data" / "catalog.json"


def score(entry: dict, terms: list[str]) -> int:
    command = entry["command"].lower()
    description = entry["description"].lower()
    task = entry["task_group"].lower()
    product = entry["product"].lower()
    aliases = " ".join(entry.get("aliases", [])).lower()
    total = 0
    for term in terms:
        if term == command:
            total += 100
        if term in command:
            total += 25
        if term in aliases:
            total += 20
        if term in task:
            total += 14
        if term in description:
            total += 10
        if term in product:
            total += 5
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description="Search shortcuts and commands by operator intent")
    parser.add_argument("query", nargs="*", help="Task, shortcut, command, or description")
    parser.add_argument("--product", choices=["omarchy", "hermes", "claude-code", "codex"])
    parser.add_argument("--interface", choices=["hotkey", "slash-command", "shell-command", "cli-flag"])
    parser.add_argument("--task")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    args = parser.parse_args()

    data = json.loads(args.catalog.read_text(encoding="utf-8"))
    rows = data["entries"]
    if args.product:
        rows = [row for row in rows if row["product"] == args.product]
    if args.interface:
        rows = [row for row in rows if row["interface"] == args.interface]
    if args.task:
        rows = [row for row in rows if args.task.lower() in row["task_group"].lower()]

    terms = [term for term in re.split(r"\s+", " ".join(args.query).lower().strip()) if term]
    if terms:
        ranked = [(score(row, terms), row) for row in rows]
        rows = [row for points, row in sorted(ranked, key=lambda item: (-item[0], item[1]["command"])) if points > 0]
    rows = rows[:max(1, args.limit)]

    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    if not rows:
        print("No matching commands.")
        return 1
    for row in rows:
        print(f"{row['product']:<12} {row['interface']:<13} {row['command']}")
        print(f"  {row['description']}")
        print(f"  task={row['task_group']}  safety={row['safety_level']}  version={row['product_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
