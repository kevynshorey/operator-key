"""The in-app shortcut instruction must match the real installer contract.

Settings tells the operator which command to run to bind a global shortcut. That
command modifies desktop configuration, so an inaccurate instruction is a safety
problem, not a cosmetic one: it can send someone to a command that fails, or worse,
one that points at the wrong path. These tests hold the rendered string against the
installer's actual argument parser rather than against a copy of the documentation.
"""

from __future__ import annotations

import importlib.util
import re
import shlex
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "src" / "App.tsx"
INSTALLER = REPO / "scripts" / "install-omarchy-binding.py"


def _load_installer():
    spec = importlib.util.spec_from_file_location("install_omarchy_binding", INSTALLER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # Register before exec: dataclass processing resolves the module by name.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _extract_command(source: str) -> str:
    """Extract the displayed command, rejecting anything else in its container.

    Checking only the text inside ``<code>`` would fail open: an option appended
    beside the element, still on the displayed line, is copied by a reader just the
    same. So the container must hold exactly one ``<code>`` element and nothing else.

    There must also be exactly one such container in the file. Validating merely the
    first match would let a second displayed command be added elsewhere, carrying an
    applying or redirected invocation that no assertion ever inspects.
    """
    blocks = re.findall(r'<p className="shortcut-command">(.*?)</p>', source, re.DOTALL)
    if not blocks:
        raise AssertionError(
            "Settings must display the installer command in a shortcut-command block"
        )
    if len(blocks) > 1:
        raise AssertionError(
            f"exactly one displayed-command block is allowed, found {len(blocks)}; "
            "a second one would present an unchecked command to the operator"
        )

    paragraph = blocks[0].strip()
    inner = re.fullmatch(r"<code>([^<>]+)</code>", paragraph)
    if not inner:
        raise AssertionError(
            "the displayed-command block must hold exactly one <code> element and no "
            f"other text or markup, got: {paragraph!r}"
        )
    return inner.group(1).strip()


def _rendered_command() -> str:
    """Pull the command Settings displays out of the shortcut section."""
    return _extract_command(APP.read_text(encoding="utf-8"))


class ShortcutGuidanceTest(unittest.TestCase):
    def test_the_displayed_command_invokes_the_real_installer(self) -> None:
        tokens = shlex.split(_rendered_command())

        # Assert the EXACT command, not a substring: extra options would change what the
        # operator's desktop ends up doing, and assertIn would silently accept them.
        self.assertEqual(tokens, ["python3", "scripts/install-omarchy-binding.py"])
        self.assertTrue(INSTALLER.is_file(), "the installer the UI names must exist")

    def test_the_displayed_command_parses_with_the_installer_argument_parser(self) -> None:
        installer = _load_installer()
        tokens = shlex.split(_rendered_command())

        self.assertEqual(tokens[:2], ["python3", "scripts/install-omarchy-binding.py"])
        argv = tokens[2:]
        # The intended command is bare: it carries no --target, --destination or
        # --candidate that would redirect the write away from the reviewed defaults.
        self.assertEqual(argv, [])
        args = installer.parse_args(argv)

        # Preview is the read-only default. The UI must never show an applying command
        # as the first step an operator runs.
        self.assertFalse(args.apply, "the displayed command must be the preview step")
        self.assertFalse(args.uninstall)

    def test_the_displayed_command_does_not_pass_the_destination_as_the_source(self) -> None:
        installer = _load_installer()
        tokens = shlex.split(_rendered_command())

        args = installer.parse_args(tokens[2:])

        # --binary is the prebuilt SOURCE executable and --destination is where it gets
        # installed. Passing the destination as --binary reads plausibly and fails for
        # anyone who has not already installed the app.
        self.assertNotEqual(
            args.binary.resolve(),
            args.destination.resolve(),
            "--binary must name the build output, never the install destination",
        )
        self.assertEqual(args.binary, installer._default_source(REPO))

    def test_the_guidance_says_the_installer_needs_the_repository(self) -> None:
        # The .deb and .rpm bundles ship no resources, so a package-installed user has no
        # scripts/ directory. The command is relative to a checkout, so the surrounding
        # text has to say where to get one.
        source = APP.read_text(encoding="utf-8")
        match = re.search(
            r'aria-label="Global shortcut">(.+?)</section>', source, re.DOTALL
        )
        assert match, "the shortcut section must exist to describe the installer"
        section = match.group(1)

        self.assertIn("github.com/kevynshorey/operator-key", section)
        self.assertRegex(section, r"repositor|clone|source")

    def test_the_extractor_rejects_an_option_smuggled_beside_the_code_element(self) -> None:
        # The guard that matters: text appended next to <code> is still on the line a
        # reader copies. If the extractor ignored it, every assertion below would be
        # checking a command the UI does not actually display.
        smuggled = (
            '<p className="shortcut-command"><code>python3 scripts/install-omarchy-binding.py</code> --apply</p>'
        )
        with self.assertRaises(AssertionError):
            _extract_command(smuggled)

        extra_element = (
            '<p className="shortcut-command"><code>python3 scripts/install-omarchy-binding.py</code>'
            "<code>--destination /tmp/x</code></p>"
        )
        with self.assertRaises(AssertionError):
            _extract_command(extra_element)

        # Fail closed when the block disappears entirely, rather than silently passing.
        with self.assertRaises(AssertionError):
            _extract_command("<p>no command here</p>")

        # A second displayed command elsewhere in the app would go uninspected if only
        # the first match were validated.
        duplicated = (
            '<p className="shortcut-command"><code>python3 scripts/install-omarchy-binding.py</code></p>'
            '<div><p className="shortcut-command"><code>python3 scripts/install-omarchy-binding.py --apply</code></p></div>'
        )
        with self.assertRaises(AssertionError):
            _extract_command(duplicated)

        # The genuine shape still extracts cleanly.
        self.assertEqual(
            _extract_command(
                '<p className="shortcut-command"><code>python3 scripts/install-omarchy-binding.py</code></p>'
            ),
            "python3 scripts/install-omarchy-binding.py",
        )

    def test_the_installer_is_named_exactly_once_in_the_user_interface(self) -> None:
        # Class-independent guard. Counting only `.shortcut-command` elements would miss
        # an unclassed code block, or plain prose naming a different invocation. Whatever
        # form it takes, the UI must present exactly one installer command.
        source = APP.read_text(encoding="utf-8")
        occurrences = source.count("install-omarchy-binding.py")
        self.assertEqual(
            occurrences,
            1,
            "the interface must name the installer exactly once; a second mention can "
            "put an applying or redirected command in front of the operator",
        )

        # And no other user-facing component may name it either. Test files are excluded:
        # they assert on the command by design and ship to nobody.
        others = sorted(
            path
            for suffix in ("*.tsx", "*.ts")
            for path in (REPO / "src").rglob(suffix)
            if path != APP
            and ".test." not in path.name
            and "install-omarchy-binding.py" in path.read_text(encoding="utf-8")
        )
        self.assertEqual(others, [], "only the shortcut section may name the installer")

    def test_no_user_facing_text_tells_the_operator_to_apply_first(self) -> None:
        # The safe order is preview, read, then apply. Prose that hands someone an
        # --apply command up front would bypass the review step the section promises.
        source = APP.read_text(encoding="utf-8")
        for match in re.finditer(r"install-omarchy-binding\.py([^<]*)", source):
            self.assertNotIn(
                "--apply",
                match.group(1),
                "the displayed invocation must be the read-only preview step",
            )

    def test_the_installer_only_writes_behind_an_explicit_apply_flag(self) -> None:
        installer = _load_installer()

        # The guidance promises the displayed step changes nothing. That promise holds
        # only while applying requires an explicit flag.
        self.assertFalse(installer.parse_args([]).apply)
        self.assertTrue(installer.parse_args(["--apply"]).apply)


if __name__ == "__main__":
    unittest.main()
