#!/usr/bin/env python3
"""Check installed tool versions against upstream releases and documentation.

This script is deliberately separate from the application. Operator Key's authority comes
from being generated on this machine from installed binaries; if a network fetch could
write into ``catalog.json`` then every downstream guarantee -- entry identity, safety
levels, the insertion boundary -- would rest on whatever a web page said today.

So this writes ONLY ``data/freshness.json``, which is advisory. It never edits the catalog
and never changes a safety level. Regenerating the catalog stays an explicit local action
against installed binaries (``scripts/build_catalog.py``).

Exit codes:
  0  checked successfully (drift may still be reported in the file)
  1  could not reach any source AND no cached result existed
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "data" / "freshness.json"
CATALOG = ROOT / "data" / "catalog.json"
SCHEMA_VERSION = "1.0.0"
USER_AGENT = "Operator-Key-FreshnessCheck/1.0"

# Upstream release feeds. Omarchy publishes tags rather than releases, and Hermes has no
# public release feed we can rely on, so each product declares how it is discovered.
RELEASE_SOURCES: dict[str, dict[str, str]] = {
    "omarchy": {"kind": "github_tags", "repo": "omacom/omarchy"},
    "claude-code": {"kind": "github_release", "repo": "anthropics/claude-code"},
    "codex": {"kind": "github_release", "repo": "openai/codex"},
    "gh": {"kind": "github_release", "repo": "cli/cli"},
    # git publishes tags, not GitHub releases, on its official mirror.
    "git": {"kind": "github_tags", "repo": "git/git"},
    # Hermes intentionally omitted: no public release feed was found. Reporting "unknown"
    # is correct; inventing a source would produce confident nonsense.
}

# Documentation pages whose CONTENT can change without any version bump, which is how a
# command's meaning shifts under a catalog that still looks current.
DOC_SOURCES: dict[str, dict[str, str]] = {
    "claude_commands": {
        "product": "claude-code",
        "url": "https://code.claude.com/docs/en/commands.md",
    },
    "claude_keys": {
        "product": "claude-code",
        "url": "https://code.claude.com/docs/en/interactive-mode.md",
    },
    "codex_commands": {
        "product": "codex",
        "url": "https://learn.chatgpt.com/docs/developer-commands.md",
    },
}


def installed_versions() -> dict[str, str]:
    """Read versions from the binaries actually present on this machine."""

    def run(*cmd: str) -> str:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
        except (OSError, subprocess.SubprocessError):
            return ""
        return (result.stdout or result.stderr or "").strip()

    versions: dict[str, str] = {}

    pacman = run("pacman", "-Q", "omarchy")
    versions["omarchy"] = pacman.split()[1] if len(pacman.split()) > 1 else "unknown"

    hermes = run("hermes", "--version")
    match = re.search(r"Hermes Agent v([^\s]+)", hermes)
    versions["hermes"] = match.group(1) if match else "unknown"

    claude = run("claude", "--version")
    match = re.search(r"([0-9][^\s]*) \(Claude Code\)", claude)
    versions["claude-code"] = match.group(1) if match else "unknown"

    codex = run("codex", "--version")
    match = re.search(r"([0-9][^\s]*)", codex)
    versions["codex"] = match.group(1) if match else "unknown"

    git = run("git", "--version")
    match = re.search(r"git version ([^\s]+)", git)
    versions["git"] = match.group(1) if match else "unknown"

    gh = run("gh", "--version")
    match = re.search(r"gh version ([^\s]+)", gh)
    versions["gh"] = match.group(1) if match else "unknown"

    return versions


def normalize_version(raw: str) -> tuple[int, ...] | None:
    """Reduce a version string to comparable numbers.

    Upstream spellings disagree wildly: ``rust-v0.155.1``, ``v2.1.278``, ``4.0.3-1``.
    Returns None when no numeric core can be found, which the caller must treat as
    "cannot tell" rather than "up to date" -- a false all-clear is worse than a shrug.
    """
    if not raw:
        return None
    match = re.search(r"(\d+(?:\.\d+)*)", raw)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def compare_versions(installed: str, upstream: str) -> str:
    """Return 'current', 'behind', 'ahead', or 'unknown'."""
    left = normalize_version(installed)
    right = normalize_version(upstream)
    if left is None or right is None:
        return "unknown"
    # Pad so 2.1 and 2.1.0 compare equal rather than by length.
    width = max(len(left), len(right))
    left = left + (0,) * (width - len(left))
    right = right + (0,) * (width - len(right))
    if left == right:
        return "current"
    return "behind" if left < right else "ahead"


def http_get(url: str, headers: dict[str, str] | None = None, timeout: int = 20):
    """Perform a GET, returning (status, body, response_headers).

    A 304 yields an empty body, which is the normal and desirable outcome for a
    conditional request against unchanged documentation.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, b"", dict(error.headers or {})
    except (OSError, ValueError):
        return 0, b"", {}


def check_release(product: str, source: dict[str, str]) -> dict:
    """Ask GitHub for the newest published version of one product."""
    repo = source["repo"]
    if source["kind"] == "github_release":
        status, body, _ = http_get(f"https://api.github.com/repos/{repo}/releases/latest")
        if status != 200 or not body:
            return {"status": "unreachable", "http_status": status}
        payload = json.loads(body)
        return {
            "status": "ok",
            "latest": payload.get("tag_name") or "",
            "published_at": payload.get("published_at") or "",
            "url": payload.get("html_url") or f"https://github.com/{repo}/releases",
        }

    status, body, _ = http_get(f"https://api.github.com/repos/{repo}/tags?per_page=10")
    if status != 200 or not body:
        return {"status": "unreachable", "http_status": status}
    tags = json.loads(body)
    if not isinstance(tags, list) or not tags:
        return {"status": "unreachable", "http_status": status}
    # Tags arrive in repository order, which is not version order. Sort numerically so a
    # stale 'v4.0.10' style tag cannot be misread as older than 'v4.0.9'.
    best = max(tags, key=lambda tag: normalize_version(str(tag.get("name", ""))) or ())
    return {
        "status": "ok",
        "latest": str(best.get("name", "")),
        "published_at": "",
        "url": f"https://github.com/{repo}/tags",
    }


def check_doc(name: str, source: dict[str, str], previous: dict) -> dict:
    """Conditionally fetch a docs page, detecting content drift at an unchanged version."""
    url = source["url"]
    prior = (previous.get("docs") or {}).get(name) or {}
    headers: dict[str, str] = {}
    if prior.get("etag"):
        headers["If-None-Match"] = prior["etag"]
    if prior.get("last_modified"):
        headers["If-Modified-Since"] = prior["last_modified"]

    status, body, response_headers = http_get(url, headers=headers)

    if status == 304:
        return {**prior, "status": "unchanged", "product": source["product"], "url": url}
    if status != 200:
        return {
            **prior,
            "status": "unreachable",
            "http_status": status,
            "product": source["product"],
            "url": url,
        }

    import hashlib

    digest = hashlib.sha256(body).hexdigest()
    changed = bool(prior.get("sha256")) and prior["sha256"] != digest
    return {
        "product": source["product"],
        "url": url,
        "status": "changed" if changed else ("first-seen" if not prior.get("sha256") else "unchanged"),
        "sha256": digest,
        "etag": response_headers.get("ETag", ""),
        "last_modified": response_headers.get("Last-Modified", ""),
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def catalog_metadata() -> dict:
    """Read the versions the catalog was BUILT from, to detect catalog drift."""
    if not CATALOG.exists():
        return {}
    try:
        document = json.loads(CATALOG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        "generated_at": document.get("generated_at", ""),
        "versions": document.get("versions", {}),
    }


def build_report(*, offline: bool = False, output: Path = DEFAULT_OUTPUT) -> dict:
    previous: dict = {}
    if output.exists():
        try:
            previous = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = {}

    installed = installed_versions()
    catalog = catalog_metadata()
    built_from = catalog.get("versions", {})

    products: dict[str, dict] = {}
    reachable = False

    for product, current in installed.items():
        # "Not installed" is a different fact from "out of date", and conflating them is
        # actively misleading on a cloned repo: someone who has never installed Omarchy
        # would be told their catalog is stale for it, when really those 228 commands
        # simply do not apply to their machine.
        installed_here = bool(current) and current != "unknown"
        record: dict = {
            "installed": current,
            "installed_here": installed_here,
            "catalog_built_from": built_from.get(product, ""),
            # Catalog drift is local and always knowable: it needs no network at all.
            # A tool that is absent cannot be "out of sync", so it is not claimed to be.
            "catalog_matches_installed": (
                installed_here and built_from.get(product, "") == current
            ),
        }

        source = RELEASE_SOURCES.get(product)
        if not installed_here:
            # Nothing to compare against, and no reason to spend a request on it.
            record.update({"upstream_status": "not-installed", "drift": "unknown"})
        elif source is None:
            record.update({"upstream_status": "no-public-feed", "drift": "unknown"})
        elif offline:
            prior = (previous.get("products") or {}).get(product) or {}
            # Carry forward what the last online check learned, clearly marked stale. An
            # offline run must not erase known drift: overwriting "behind" with silence
            # would make a stale catalog look clean the moment someone checks on a train.
            record.update({
                "upstream_status": "offline",
                "latest": prior.get("latest", ""),
                "drift": "unknown",
                "last_known_drift": prior.get("drift", "unknown"),
                "last_known_at": previous.get("checked_at", ""),
            })
        else:
            result = check_release(product, source)
            if result["status"] == "ok":
                reachable = True
                record.update({
                    "upstream_status": "ok",
                    "latest": result["latest"],
                    "published_at": result["published_at"],
                    "release_url": result["url"],
                    "drift": compare_versions(current, result["latest"]),
                })
            else:
                record.update({
                    "upstream_status": "unreachable",
                    "http_status": result.get("http_status", 0),
                    "drift": "unknown",
                })
        products[product] = record

    docs: dict[str, dict] = {}
    if not offline:
        for name, source in DOC_SOURCES.items():
            result = check_doc(name, source, previous)
            if result.get("status") in {"unchanged", "changed", "first-seen"}:
                reachable = True
            docs[name] = result
    else:
        docs = previous.get("docs") or {}

    return {
        "schema_version": SCHEMA_VERSION,
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "offline": offline,
        "reachable": reachable,
        "catalog_generated_at": catalog.get("generated_at", ""),
        "products": products,
        "docs": docs,
    }


def summarize(report: dict) -> str:
    lines: list[str] = []
    lines.append(f"checked_at: {report['checked_at']}")
    lines.append(f"catalog generated: {report.get('catalog_generated_at') or 'unknown'}")
    lines.append("")
    lines.append(f"{'product':<14}{'installed':<14}{'latest':<18}{'drift':<10}catalog")
    for product, record in report["products"].items():
        if not record.get("installed_here", True):
            catalog_state = "not installed"
        elif record["catalog_matches_installed"]:
            catalog_state = "in sync"
        else:
            catalog_state = "STALE"
        lines.append(
            f"{product:<14}{record['installed']:<14}"
            f"{str(record.get('latest') or '-'):<18}"
            f"{record.get('drift', 'unknown'):<10}{catalog_state}"
        )
    changed = [name for name, doc in (report.get("docs") or {}).items() if doc.get("status") == "changed"]
    if changed:
        lines.append("")
        lines.append(f"docs changed since last check: {', '.join(changed)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="do not touch the network; reuse the last result")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--quiet", action="store_true", help="write the file without printing a summary")
    args = parser.parse_args(argv)

    report = build_report(offline=args.offline, output=args.output)

    if not report["reachable"] and not args.offline and not args.output.exists():
        print("error: no source reachable and no cached result to fall back on", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if not args.quiet:
        print(summarize(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
