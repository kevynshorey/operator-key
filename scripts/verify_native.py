#!/usr/bin/env python3
"""Safe compositor-level smoke test for the installed Operator Key binary."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

BINARY = Path(os.environ.get("OPERATOR_KEY_BINARY", Path.home() / ".local/bin/operator-key")).resolve()
QUERY = "hermes status"
EXPECTED = "hermes status"
TIMEOUT = 12.0


def run(
    argv: list[str], *, check: bool = True, input_bytes: bytes | None = None, timeout: float = 5
) -> subprocess.CompletedProcess:
    return subprocess.run(argv, check=check, input=input_bytes, capture_output=True, timeout=timeout)


def set_clipboard(value: bytes) -> None:
    process = subprocess.Popen(
        ["wl-copy"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        process.communicate(value, timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)
        raise RuntimeError("wl-copy did not detach after receiving clipboard data")
    if process.returncode != 0:
        raise RuntimeError(f"wl-copy failed with exit status {process.returncode}")


def clients() -> list[dict]:
    return json.loads(run(["hyprctl", "clients", "-j"]).stdout)


def active_address() -> str | None:
    value = json.loads(run(["hyprctl", "activewindow", "-j"]).stdout)
    return value.get("address")


def wait_client(predicate, previous: set[str] | None = None) -> dict:
    deadline = time.monotonic() + TIMEOUT
    previous = previous or set()
    while time.monotonic() < deadline:
        for client in clients():
            if client.get("address") not in previous and predicate(client):
                return client
        time.sleep(0.1)
    raise RuntimeError("timed out waiting for expected Hyprland client")


def focus(address: str) -> None:
    if not address.startswith("0x") or not all(character in "0123456789abcdefABCDEF" for character in address[2:]):
        raise RuntimeError("Hyprland returned an invalid window address")
    dispatcher = f'hl.dsp.focus({{ window = "address:{address}" }})'
    run(["hyprctl", "dispatch", dispatcher])
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if active_address() == address:
            return
        time.sleep(0.05)
    raise RuntimeError(f"could not focus disposable window {address}")


def type_query(*, shift_enter: bool = False) -> None:
    # Keep selection and deletion on one virtual-keyboard connection.
    run(["wtype", "-k", "Home", "-M", "shift", "-k", "End", "-m", "shift", "-k", "BackSpace"])
    run(["wtype", "-d", "35", QUERY])
    time.sleep(0.25)
    if shift_enter:
        run(["wtype", "-M", "shift", "-k", "Return", "-m", "shift"])
    else:
        run(["wtype", "-k", "Return"])


def stop(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def launch_operator(previous: set[str]) -> tuple[subprocess.Popen, dict]:
    process = subprocess.Popen([str(BINARY)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = wait_client(
        lambda item: item.get("class") == "operator-key" and item.get("initialClass") == "operator-key",
        previous,
    )
    focus(client["address"])
    time.sleep(1.0)
    return process, client


def main() -> int:
    required = ["foot", "tmux", "wtype", "wl-paste", "hyprctl"]
    missing = [command for command in required if not shutil.which(command)]
    if missing:
        raise RuntimeError(f"missing native smoke dependencies: {', '.join(missing)}")
    if not BINARY.is_file():
        raise RuntimeError(f"installed binary is missing: {BINARY}")

    original_focus = active_address()
    clipboard: bytes | None = None
    if shutil.which("wl-copy"):
        try:
            copied = run(["wl-paste", "--no-newline"], check=False, timeout=1)
            if copied.returncode == 0:
                clipboard = copied.stdout
        except subprocess.TimeoutExpired:
            pass

    operator: subprocess.Popen | None = None
    foot: subprocess.Popen | None = None
    tmux_label = f"operator-key-{os.getpid()}"
    session = "smoke"
    copy_proof = False
    insert_proof = False
    try:
        before = {item["address"] for item in clients()}
        operator, _ = launch_operator(before)
        type_query()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            pasted = run(["wl-paste", "--no-newline"], check=False, timeout=1)
            if pasted.returncode == 0 and pasted.stdout.decode("utf-8") == EXPECTED:
                copy_proof = True
                break
            time.sleep(0.1)
        if not copy_proof:
            raise RuntimeError("clipboard did not equal the selected catalog command")
        stop(operator)
        operator = None

        with tempfile.TemporaryDirectory(prefix="operator-key-native-") as directory:
            rcfile = Path(directory) / "bashrc"
            rcfile.write_text("PS1='OK_NATIVE_PROMPT> '\n", encoding="utf-8")
            run(["tmux", "-L", tmux_label, "new-session", "-d", "-s", session,
                 "/bin/bash", "--noprofile", "--rcfile", str(rcfile), "-i"])
            before = {item["address"] for item in clients()}
            foot = subprocess.Popen(
                ["foot", "--title", "Operator Key Native Smoke", "tmux", "-L", tmux_label, "attach", "-t", session],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            foot_client = wait_client(lambda item: item.get("class") in {"foot", "footclient"}, before)
            focus(foot_client["address"])
            before_operator = {item["address"] for item in clients()}
            operator, _ = launch_operator(before_operator)
            type_query(shift_enter=True)

            deadline = time.monotonic() + 4
            captured = ""
            while time.monotonic() < deadline:
                capture = run(["tmux", "-L", tmux_label, "capture-pane", "-p", "-t", session])
                captured = capture.stdout.decode("utf-8", errors="replace")
                if f"OK_NATIVE_PROMPT> {EXPECTED}" in captured:
                    insert_proof = True
                    break
                time.sleep(0.1)
            if not insert_proof:
                raise RuntimeError("literal command was not found at the disposable terminal prompt")
            if captured.count("OK_NATIVE_PROMPT>") != 1:
                raise RuntimeError("terminal produced a second prompt; inserted command may have executed")

        print(json.dumps({
            "binary": str(BINARY),
            "query": QUERY,
            "selected_command": EXPECTED,
            "copy_exact": copy_proof,
            "inserted_at_unsubmitted_prompt": insert_proof,
            "new_prompt_count": 1,
            "red_action_invoked": False,
        }, sort_keys=True))
        return 0
    finally:
        stop(operator)
        stop(foot)
        run(["tmux", "-L", tmux_label, "kill-server"], check=False)
        if clipboard is not None and shutil.which("wl-copy"):
            set_clipboard(clipboard)
        if original_focus:
            try:
                focus(original_focus)
            except (RuntimeError, subprocess.SubprocessError):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
