#!/usr/bin/env python3
"""Build Operator Key's version-aware local command catalog."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.adapters import claude as claude_adapter
from scripts.adapters import codex as codex_adapter
from scripts.adapters import gh as gh_adapter
from scripts.adapters import git as git_adapter
from scripts.adapters import hermes as hermes_adapter
from scripts.adapters import omarchy as omarchy_adapter
from scripts.adapters.common import classify, dedupe, entry, run, safety, split_markdown_cells
from scripts.chords import annotate_conflicts

DEFAULT_OUTPUT = ROOT / "data" / "catalog.json"
DEFAULT_SCHEMA = ROOT / "schema" / "catalog.schema.json"

# Record the URL we actually read, not the one we historically asked for. The Codex docs
# moved to learn.chatgpt.com behind a 308; urllib follows redirects silently, so the old
# entry made every Codex record claim provenance from an address that no longer serves it.
DOCS = {
    "claude_commands": "https://code.claude.com/docs/en/commands.md",
    "claude_keys": "https://code.claude.com/docs/en/interactive-mode.md",
    "codex_commands": "https://learn.chatgpt.com/docs/developer-commands.md",
}
PRODUCTS = ("omarchy", "hermes", "claude-code", "codex", "git", "gh")


def version(command: str) -> str:
    text = run(command, "--version").strip()
    if command == "hermes":
        match = re.search(r"Hermes Agent v([^\s]+)", text)
    elif command == "claude":
        match = re.search(r"([^\s]+) \(Claude Code\)", text)
    else:
        match = re.search(r"(?:codex-cli\s+)?([^\s]+)", text)
    return match.group(1) if match else text.splitlines()[0] if text else "unknown"


def installed_versions() -> dict[str, str]:
    omarchy_package = run("pacman", "-Q", "omarchy").strip()
    return {
        "omarchy": omarchy_package.split()[1] if omarchy_package else "unknown",
        "hermes": version("hermes"),
        "claude-code": version("claude"),
        "codex": version("codex"),
        # git and gh parse their own version banners, which do not match the patterns above.
        "git": git_adapter.version(),
        "gh": gh_adapter.version(),
    }


def fetch(url: str, cache_name: str, offline: bool) -> str:
    """Fetch a documentation source, caching it for offline rebuilds.

    Reports redirects on stderr rather than following them silently. A moved docs URL is
    how a catalog starts quoting provenance it no longer reads: the build keeps working,
    so nobody notices until an entry is traced back to a dead address.
    """
    cache_dir = ROOT / "data" / "source-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / cache_name
    if not offline:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Operator-Key/0.1"})
            with urllib.request.urlopen(request, timeout=30) as response:
                text = response.read().decode("utf-8")
                final_url = response.geturl()
            if final_url != url:
                print(
                    f"warning: {url} redirected to {final_url}; update DOCS so provenance "
                    "records the address actually read",
                    file=sys.stderr,
                )
            cache.write_text(text, encoding="utf-8")
            return text
        except (OSError, UnicodeError):
            pass
    return cache.read_text(encoding="utf-8") if cache.exists() else ""


def validate_catalog(document: object, schema_path: Path = DEFAULT_SCHEMA) -> list[str]:
    """Validate a catalog against the checked-in JSON Schema subset."""
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    errors: list[str] = []

    def resolve(rule: dict) -> dict:
        reference = rule.get("$ref")
        if not reference:
            return rule
        target: object = schema
        for part in reference.removeprefix("#/").split("/"):
            target = target[part]  # type: ignore[index]
        return target  # type: ignore[return-value]

    def visit(value: object, rule: dict, location: str) -> None:
        rule = resolve(rule)
        expected = rule.get("type")
        matches = {
            "object": isinstance(value, dict),
            "array": isinstance(value, list),
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
        }
        if expected and not matches.get(expected, False):
            errors.append(f"{location or 'catalog'} must be {expected}")
            return
        if "enum" in rule and value not in rule["enum"]:
            errors.append(f"{location} must be one of {rule['enum']}")
        if isinstance(value, str) and len(value) < rule.get("minLength", 0):
            errors.append(f"{location} must not be empty")
        if isinstance(value, int) and not isinstance(value, bool) and value < rule.get("minimum", value):
            errors.append(f"{location} must be at least {rule['minimum']}")
        if isinstance(value, dict):
            properties = rule.get("properties", {})
            for name in rule.get("required", []):
                if name not in value:
                    prefix = f"{location}." if location else ""
                    errors.append(f"{prefix}{name} is required")
            if rule.get("additionalProperties") is False:
                for name in value.keys() - properties.keys():
                    prefix = f"{location}." if location else ""
                    errors.append(f"{prefix}{name} is not allowed")
            for name, child in value.items():
                if name in properties:
                    prefix = f"{location}." if location else ""
                    visit(child, properties[name], f"{prefix}{name}")
        elif isinstance(value, list):
            if len(value) < rule.get("minItems", 0):
                errors.append(f"{location} must contain at least {rule['minItems']} items")
            if "items" in rule:
                for index, child in enumerate(value):
                    visit(child, rule["items"], f"{location}[{index}]")

    visit(document, schema, "")
    if isinstance(document, dict) and isinstance(document.get("entries"), list):
        entries = document["entries"]
        if document.get("total") != len(entries):
            errors.append("total must equal the number of entries")
        counts = document.get("counts")
        if isinstance(counts, dict):
            for product in PRODUCTS:
                actual = sum(row.get("product") == product for row in entries if isinstance(row, dict))
                if counts.get(product) != actual:
                    errors.append(f"counts.{product} must equal {actual}")
    return errors


def build_document(*, offline: bool = False,
                   versions: dict[str, str] | None = None) -> dict:
    """Collect all production adapters and return an annotated catalog."""
    versions = dict(versions or installed_versions())
    claude_commands = fetch(DOCS["claude_commands"], "claude-commands.md", offline)
    claude_keys = fetch(DOCS["claude_keys"], "claude-interactive-mode.md", offline)
    codex_commands = fetch(DOCS["codex_commands"], "codex-developer-commands.md", offline)

    rows: list[dict] = []
    rows += omarchy_adapter.collect(versions["omarchy"])
    rows += hermes_adapter.collect(versions["hermes"])
    rows += claude_adapter.collect(versions["claude-code"], claude_commands, claude_keys)
    rows += codex_adapter.collect(versions["codex"], codex_commands)
    # git and gh are catalogued purely from local binaries -- no docs fetch, so they are
    # unaffected by --offline and cost no network requests.
    rows += git_adapter.collect(versions["git"])
    rows += gh_adapter.collect(versions["gh"])
    rows = dedupe(rows)
    conflicts = annotate_conflicts(rows)
    counts = {product: sum(row["product"] == product for row in rows) for product in PRODUCTS}
    return {
        "schema_version": "1.0.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "host": os.uname().nodename,
        "versions": versions,
        "counts": counts,
        "total": len(rows),
        "conflicts": conflicts,
        "entries": rows,
    }


def _write_catalog(output: Path, document: dict) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=output.parent, prefix=f".{output.name}.", delete=False
        ) as temporary:
            temporary.write(serialized)
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, output)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--offline", action="store_true", help="Use cached official documentation")
    args = parser.parse_args(argv)

    document = build_document(offline=args.offline)
    errors = validate_catalog(document)
    if errors:
        print("Catalog validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    _write_catalog(args.output, document)
    print(json.dumps({
        "output": str(args.output),
        "total": document["total"],
        "counts": document["counts"],
        "versions": document["versions"],
        "conflicts": len(document["conflicts"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
