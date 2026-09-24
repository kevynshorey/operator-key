#!/usr/bin/env python3
"""Fail release if the exact .deb payload raises the supported GLIBC floor."""

import argparse
import io
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Callable


MAX_GLIBC = (2, 39)  # Oldest target: Ubuntu 24.04 LTS (amd64).
MAX_PACKAGE_BYTES = 128 * 1024 * 1024
MAX_BINARY_BYTES = 64 * 1024 * 1024
REQUIRED_WEBKIT = "libwebkit2gtk-4.1-0"
# Both target distros ship -0t64, which also Provides the legacy -0 name.
# The historical published v0.2.4 package uses the latter; actual apt install
# on each distro is the final arbiter, not a guessed package-name mapping.
GTK_DEPS = frozenset({"libgtk-3-0t64", "libgtk-3-0"})
GLIBC_SYMBOL = re.compile(r"\bGLIBC_(\d+\.\d+(?:\.\d+)*)\b")


def _ar_members(raw: bytes) -> dict[str, bytes]:
    if not raw.startswith(b"!<arch>\n"):
        raise ValueError("not a Debian ar package")
    offset = 8
    members: dict[str, bytes] = {}
    while offset < len(raw):
        header = raw[offset : offset + 60]
        if len(header) != 60 or header[58:] != b"`\n":
            raise ValueError("invalid Debian ar header")
        try:
            name = header[:16].decode("ascii").strip().rstrip("/")
            size = int(header[48:58].strip())
        except (UnicodeError, ValueError) as exc:
            raise ValueError("invalid Debian ar member") from exc
        start = offset + 60
        end = start + size
        if not name or name in members or end > len(raw):
            raise ValueError("missing, repeated or truncated Debian ar member")
        members[name] = raw[start:end]
        offset = end + (size % 2)
        if offset > len(raw):
            raise ValueError("truncated Debian ar member padding")
    if members.get("debian-binary") != b"2.0\n":
        raise ValueError("unsupported Debian package version")
    return members


def _one_regular_member(archive_bytes: bytes, expected: str, size_limit: int) -> bytes:
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:*") as archive:
            found = [
                member
                for member in archive.getmembers()
                if member.name in {expected, "./" + expected}
            ]
            if len(found) != 1 or not found[0].isfile():
                raise ValueError(f"package must contain one regular {expected}")
            member = found[0]
            if member.size <= 0 or member.size > size_limit:
                raise ValueError(f"{expected} has an invalid size")
            opened = archive.extractfile(member)
            if opened is None:
                raise ValueError(f"cannot read {expected}")
            with opened:
                return opened.read(size_limit + 1)
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise ValueError(f"cannot read Debian package {expected}") from exc


def _package_parts(path: Path) -> tuple[bytes, str]:
    if not path.is_file() or path.stat().st_size > MAX_PACKAGE_BYTES:
        raise ValueError("Debian package is missing or oversized")
    members = _ar_members(path.read_bytes())
    data_names = [name for name in members if name.startswith("data.tar.")]
    control_names = [name for name in members if name.startswith("control.tar.")]
    if len(data_names) != 1 or len(control_names) != 1:
        raise ValueError("Debian package requires one data and one control archive")
    binary = _one_regular_member(members[data_names[0]], "usr/bin/operator-key", MAX_BINARY_BYTES)
    if len(binary) > MAX_BINARY_BYTES or not binary.startswith(b"\x7fELF"):
        raise ValueError("package payload is not a bounded ELF binary")
    control = _one_regular_member(members[control_names[0]], "control", 64 * 1024)
    fields: dict[str, str] = {}
    for line in control.decode("utf-8").splitlines():
        if not line or line[0].isspace():
            continue
        key, separator, value = line.partition(":")
        if separator and key in fields:
            raise ValueError(f"duplicate Debian control field: {key}")
        if separator:
            fields[key] = value.strip()
    if fields.get("Package") != "operator-key":
        raise ValueError("unexpected Debian package identity")
    depends = fields.get("Depends", "")
    names = {part.strip().split(" ", 1)[0] for part in depends.split(",")}
    if REQUIRED_WEBKIT not in names:
        raise ValueError(f"Debian Depends missing {REQUIRED_WEBKIT}")
    if not GTK_DEPS.intersection(names):
        raise ValueError("Debian Depends missing libgtk-3-0t64 or libgtk-3-0")
    return binary, depends


def _read_symbols(binary: bytes) -> str:
    temp_root = os.environ.get("TMPDIR") or os.environ.get("RUNNER_TEMP")
    with tempfile.TemporaryDirectory(dir=temp_root) as directory:
        path = Path(directory) / "operator-key"
        path.write_bytes(binary)
        result = subprocess.run(
            ["objdump", "-T", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        return result.stdout


def check_package(
    path: Path, *, symbol_reader: Callable[[bytes], str] | None = None
) -> dict[str, str]:
    binary, depends = _package_parts(Path(path))
    symbols = (symbol_reader or _read_symbols)(binary)
    versions = [tuple(map(int, found.split("."))) for found in GLIBC_SYMBOL.findall(symbols)]
    if not versions:
        raise ValueError("no required GLIBC symbols found in package binary")
    highest = max(versions)
    version = ".".join(map(str, highest))
    if highest > MAX_GLIBC:
        raise ValueError(f"GLIBC_{version} exceeds supported GLIBC_2.39 ceiling")
    return {"max_glibc": version, "depends": depends}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deb", type=Path, help="exact built .deb to gate")
    args = parser.parse_args(argv)
    try:
        result = check_package(args.deb)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f"FAIL: package compatibility: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: highest required GLIBC_{result['max_glibc']} <= GLIBC_2.39")
    print(f"Debian Depends: {result['depends']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
