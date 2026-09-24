#!/usr/bin/env python3
"""Require the manifest to name and hash exactly the selected .deb and .rpm."""

import argparse
import hashlib
import re
import sys
from pathlib import Path

CHECKSUM_LINE = re.compile(r"([0-9a-f]{64})  ([^\r\n/\\]+)")


def verify(manifest: Path, deb: Path, rpm: Path) -> None:
    manifest, deb, rpm = map(Path, (manifest, deb, rpm))
    if manifest.name != "SHA256SUMS" or deb.suffix != ".deb" or rpm.suffix != ".rpm":
        raise ValueError("expected SHA256SUMS, one .deb and one .rpm")
    if len({manifest.name, deb.name, rpm.name}) != 3:
        raise ValueError("duplicate asset names")
    if any(path.is_symlink() or not path.is_file() for path in (manifest, deb, rpm)):
        raise ValueError("manifest and selected assets must be regular files")
    if not (manifest.parent.resolve() == deb.parent.resolve() == rpm.parent.resolve()):
        raise ValueError("selected assets must share the manifest directory")
    if manifest.stat().st_size > 16384:
        raise ValueError("oversized checksum manifest")
    try:
        lines = manifest.read_text(encoding="ascii").splitlines()
    except UnicodeError as exc:
        raise ValueError("invalid checksum manifest encoding") from exc
    expected = {deb.name: deb, rpm.name: rpm}
    seen: dict[str, str] = {}
    for line in lines:
        match = CHECKSUM_LINE.fullmatch(line)
        if match is None:
            raise ValueError("malformed checksum manifest line")
        digest, name = match.groups()
        if name in seen:
            raise ValueError(f"duplicate checksum entry: {name}")
        if name not in expected:
            raise ValueError(f"unexpected checksum asset: {name}")
        seen[name] = digest
    missing = expected.keys() - seen.keys()
    if missing:
        raise ValueError("missing checksum asset: " + ", ".join(sorted(missing)))
    for name, path in expected.items():
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(chunk)
        if h.hexdigest() != seen[name]:
            raise ValueError(f"checksum digest mismatch: {name}")
    print("PASS: manifest names and hashes exactly the selected .deb and .rpm")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("deb", type=Path)
    parser.add_argument("rpm", type=Path)
    args = parser.parse_args(argv)
    try:
        verify(args.manifest, args.deb, args.rpm)
    except (ValueError, OSError) as exc:
        print(f"FAIL: release asset checksums: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
