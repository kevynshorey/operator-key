import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "install-omarchy-binding.py"


def load_installer():
    spec = importlib.util.spec_from_file_location("install_omarchy_binding", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module from {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


installer = load_installer()


def bind(modmask, key, description, *, release=False, locked=False, repeat=False):
    return {
        "modmask": modmask,
        "key": key,
        "keycode": 0,
        "description": description,
        "release": release,
        "locked": locked,
        "repeat": repeat,
        "submap": "",
    }


class FakeRunner:
    def __init__(self, *, binds=None, clients=None, failures=None):
        self.binds = list(binds or [])
        self.clients = list(clients or [])
        self.failures = dict(failures or {})
        self.calls = []
        self.spawned = []

    def run(self, args, *, timeout=None):
        args = tuple(str(arg) for arg in args)
        self.calls.append(args)
        if self.failures.get(args):
            return installer.CommandResult(1, "", self.failures[args])
        if args == ("hyprctl", "-j", "binds"):
            return installer.CommandResult(0, json.dumps(self.binds), "")
        if args == ("hyprctl", "-j", "clients"):
            return installer.CommandResult(0, json.dumps(self.clients), "")
        if args == ("hyprctl", "reload"):
            return installer.CommandResult(0, "ok", "")
        if args == ("omarchy", "menu", "keybindings", "--print"):
            return installer.CommandResult(0, "SUPER + K → Keybindings\n", "")
        return installer.CommandResult(127, "", "unexpected command")

    def spawn(self, args):
        args = tuple(str(arg) for arg in args)
        self.calls.append(args)
        self.spawned.append(args)
        self.clients.append({"address": "0x99", "class": "operator-key", "title": "Operator Key"})
        return object()

    def sleep(self, seconds):
        self.calls.append(("sleep", seconds))


class InstallBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.target = self.root / "bindings.lua"
        self.target.write_bytes(b"-- personal\r\n")
        self.target.chmod(0o640)
        self.source = self.root / "release" / "operator-key"
        self.source.parent.mkdir()
        self.source.write_bytes(b"verified executable")
        self.source.chmod(0o755)
        self.destination = self.root / "bin" / "operator-key"

    def tearDown(self):
        self.temp.cleanup()

    def test_parses_hyprctl_structured_bindings_and_preserves_trigger_flags(self):
        rows = [
            bind(64 | 1, "k", "press", locked=True, repeat=True),
            bind(64 | 1, "K", "release", release=True),
        ]
        parsed = installer.parse_hyprctl_binds(json.dumps(rows))
        self.assertEqual([item.chord for item in parsed], ["SUPER + SHIFT + K"] * 2)
        self.assertEqual(parsed[0].trigger, "press, locked, repeat")
        self.assertEqual(parsed[1].trigger, "release")
        self.assertEqual(parsed[0].physical, parsed[1].physical)

    def test_parses_hyprctl_switch_names_with_spaces_without_aborting_preview(self):
        parsed = installer.parse_hyprctl_binds(
            json.dumps([bind(0, "switch:on:Lid Switch", "Lid switch")])
        )
        self.assertEqual(parsed[0].physical, "switch:on:lid switch")
        self.assertEqual(parsed[0].chord, "SWITCH:ON:LID SWITCH")

    def test_canonicalizes_modifier_order_and_key_aliases_for_physical_conflicts(self):
        variants = [
            "SHIFT SUPER + Return",
            "super+shift+enter",
            "MOD4 SHIFT ENTER",
        ]
        self.assertEqual(
            {installer.canonicalize_chord(chord) for chord in variants},
            {"shift+super+return"},
        )

    def test_parses_omarchy_print_fallback(self):
        parsed = installer.parse_omarchy_print(
            "SUPER SHIFT + K   → Keybindings\nSUPER + SPACE → Omarchy menu\n"
        )
        self.assertEqual(parsed[0].description, "Keybindings")
        self.assertEqual(parsed[1].physical, "super+space")

    def test_selects_first_truly_unused_candidate_and_reports_rejections(self):
        active = installer.parse_hyprctl_binds(
            json.dumps([bind(64 | 1, "K", "user binding", release=True)])
        )
        selected, decisions = installer.choose_candidate(
            active, ["SUPER + SHIFT + K", "SUPER + SHIFT + O"]
        )
        self.assertEqual(selected, "SUPER + SHIFT + O")
        self.assertIn("user binding [release]", decisions[0])
        self.assertIn("available", decisions[1])

    def test_fails_safely_when_no_candidate_is_available(self):
        active = installer.parse_omarchy_print("SUPER + K → one\nSUPER + O → two\n")
        with self.assertRaisesRegex(installer.InstallError, "No unused candidate"):
            installer.choose_candidate(active, ["SUPER + K", "SUPER + O"])

    def test_rerun_ignores_only_its_own_active_managed_binding(self):
        runner = FakeRunner(binds=[bind(64 | 1, "K", "Operator Key")])
        first = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=FakeRunner(),
            candidates=["SUPER + SHIFT + K", "SUPER + SHIFT + O"],
        )
        self.target.write_bytes(installer.replace_managed_block(self.target.read_bytes(), first.block))
        rerun = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + SHIFT + K", "SUPER + SHIFT + O"],
        )
        self.assertEqual(rerun.chord, "SUPER + SHIFT + K")

    def test_preview_is_exact_and_default_plan_does_not_write(self):
        runner = FakeRunner(binds=[bind(64, "K", "Keybindings")])
        before = self.target.read_bytes()
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + K", "SUPER + SHIFT + K"],
        )
        preview = installer.render_preview(plan)
        expected_block = (
            '-- >>> Operator Key managed binding >>>\r\n'
            'o.bind("SUPER + SHIFT + K", "Operator Key", o.launch("'
            + str(self.destination)
            + '"))\r\n'
            '-- <<< Operator Key managed binding <<<\r\n'
        )
        self.assertEqual(plan.block, expected_block.encode())
        self.assertIn(f"Target: {self.target}", preview)
        self.assertIn(f"Backup: {self.target}.operator-key.bak", preview)
        self.assertIn("SUPER + K: rejected", preview)
        self.assertIn(f"SHA-256: {hashlib.sha256(self.source.read_bytes()).hexdigest()}", preview)
        self.assertIn("hyprctl reload", preview)
        self.assertIn(expected_block.rstrip(), preview)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(self.destination.exists())

    def test_declined_confirmation_writes_nothing(self):
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=FakeRunner(),
            candidates=["SUPER + SHIFT + K"],
        )
        before = self.target.read_bytes()
        with self.assertRaisesRegex(installer.InstallError, "Confirmation declined"):
            installer.apply_plan(plan, runner=FakeRunner(), confirm=lambda _: False)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(self.destination.exists())

    def test_apply_is_atomic_preserves_original_and_is_idempotent(self):
        runner = FakeRunner()
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(64 | 1, "K", "Operator Key"))
        installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        first = self.target.read_bytes()
        installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), first)
        self.assertEqual(first.count(installer.BEGIN_MARKER.encode()), 1)
        self.assertEqual((Path(str(self.target) + ".operator-key.bak")).read_bytes(), b"-- personal\r\n")
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)
        self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o755)
        self.assertIn(("hyprctl", "reload"), runner.calls)
        self.assertIn((str(self.destination),), runner.spawned)

    def test_refuses_malformed_duplicate_or_nested_marker_blocks(self):
        cases = [
            installer.BEGIN_MARKER + "\n",
            installer.END_MARKER + "\n",
            installer.BEGIN_MARKER + "\n" + installer.BEGIN_MARKER + "\n" + installer.END_MARKER + "\n",
            installer.BEGIN_MARKER + "\n" + installer.END_MARKER + "\n" + installer.END_MARKER + "\n",
        ]
        for content in cases:
            with self.subTest(content=content):
                with self.assertRaisesRegex(installer.InstallError, "marker"):
                    installer.replace_managed_block(content.encode(), b"block\n")

    def test_refuses_symlink_target_source_and_destination_surprises(self):
        real = self.root / "real.lua"
        real.write_text("safe")
        link = self.root / "link.lua"
        link.symlink_to(real)
        for kwargs in [
            {"target": link, "source": self.source, "destination": self.destination},
            {"target": self.target, "source": link, "destination": self.destination},
        ]:
            with self.subTest(kwargs=kwargs):
                with self.assertRaisesRegex(installer.InstallError, "symlink"):
                    installer.create_plan(runner=FakeRunner(), candidates=["SUPER + SHIFT + K"], **kwargs)
        self.destination.parent.mkdir()
        self.destination.symlink_to(self.source)
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.create_plan(
                target=self.target,
                source=self.source,
                destination=self.destination,
                runner=FakeRunner(),
                candidates=["SUPER + SHIFT + K"],
            )

    def test_rejects_command_paths_that_could_inject_shell_syntax(self):
        for path in [self.root / "bad path", self.root / 'bad"path', self.root / "bad;path"]:
            with self.subTest(path=path):
                with self.assertRaisesRegex(installer.InstallError, "unsafe"):
                    installer.validate_command_path(path)

    def test_apply_refuses_a_backup_symlink_before_changing_files(self):
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=FakeRunner(),
            candidates=["SUPER + SHIFT + K"],
        )
        backup = Path(str(self.target) + ".operator-key.bak")
        backup.symlink_to(self.target)
        before = self.target.read_bytes()
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.apply_plan(plan, runner=FakeRunner(), confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(self.destination.exists())

    def test_apply_refuses_binary_backup_symlink_before_changing_files(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"old binary")
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        binary_backup = Path(str(self.destination) + ".operator-key.bak")
        binary_backup.symlink_to(self.source)
        before = self.target.read_bytes()
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.apply_plan(plan, runner=FakeRunner(), confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertEqual(self.destination.read_bytes(), b"old binary")

    def test_uninstall_refuses_backup_symlink_before_changing_files(self):
        install = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(install.proposed)
        plan = installer.create_uninstall_plan(target=self.target)
        plan.backup.symlink_to(self.target)
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.apply_uninstall(plan, runner=FakeRunner(), confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), install.proposed)

    def test_existing_regular_backups_are_never_overwritten(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"old binary")
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        config_backup = plan.backup
        binary_backup = Path(str(self.destination) + ".operator-key.bak")
        config_backup.write_bytes(b"keep config backup")
        binary_backup.write_bytes(b"keep binary backup")
        runner = FakeRunner(binds=[bind(64 | 1, "K", "Operator Key")])
        installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(config_backup.read_bytes(), b"keep config backup")
        self.assertEqual(binary_backup.read_bytes(), b"keep binary backup")

        uninstall = installer.create_uninstall_plan(target=self.target)
        uninstall.backup.write_bytes(b"keep uninstall backup")
        installer.apply_uninstall(uninstall, runner=FakeRunner(), confirm=lambda _: True)
        self.assertEqual(uninstall.backup.read_bytes(), b"keep uninstall backup")

    def test_apply_rolls_back_if_destination_write_mutates_then_raises(self):
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        original_write = installer._atomic_write
        failed = False

        def fail_after_destination(path, data, mode):
            nonlocal failed
            original_write(path, data, mode)
            if path == self.destination and not failed:
                failed = True
                raise OSError("injected destination write failure")

        runner = FakeRunner()
        with mock.patch.object(installer, "_atomic_write", side_effect=fail_after_destination):
            with self.assertRaisesRegex(installer.InstallError, "rolled back"):
                installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), plan.original)
        self.assertFalse(self.destination.exists())
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 0)

    def test_apply_rolls_back_if_config_write_mutates_then_raises(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"old")
        self.destination.chmod(0o700)
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        original_write = installer._atomic_write
        failed = False

        def fail_after_config(path, data, mode):
            nonlocal failed
            original_write(path, data, mode)
            if path == self.target and data == plan.proposed and not failed:
                failed = True
                raise OSError("injected config write failure")

        runner = FakeRunner()
        with mock.patch.object(installer, "_atomic_write", side_effect=fail_after_config):
            with self.assertRaisesRegex(installer.InstallError, "rolled back"):
                installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), plan.original)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)
        self.assertEqual(self.destination.read_bytes(), b"old")
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 1)

    def test_uninstall_rolls_back_if_unlink_fails_after_config_change(self):
        install = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(install.proposed)
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"installed")
        self.destination.chmod(0o751)
        plan = installer.create_uninstall_plan(target=self.target)
        runner = FakeRunner()
        original_unlink = installer._unlink_regular

        def fail_after_unlink(path, label):
            original_unlink(path, label)
            raise OSError("injected unlink failure")

        with mock.patch.object(installer, "_unlink_regular", side_effect=fail_after_unlink):
            with self.assertRaisesRegex(installer.InstallError, "rolled back"):
                installer.apply_uninstall(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), install.proposed)
        self.assertEqual(self.destination.read_bytes(), b"installed")
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o751)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 1)

    def test_uninstall_rolls_back_if_config_write_mutates_then_raises(self):
        install = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(install.proposed)
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"installed")
        self.destination.chmod(0o751)
        plan = installer.create_uninstall_plan(target=self.target)
        original_write = installer._atomic_write
        failed = False

        def fail_after_config(path, data, mode):
            nonlocal failed
            original_write(path, data, mode)
            if path == self.target and data == plan.proposed and not failed:
                failed = True
                raise OSError("injected uninstall config write failure")

        runner = FakeRunner()
        with mock.patch.object(installer, "_atomic_write", side_effect=fail_after_config):
            with self.assertRaisesRegex(installer.InstallError, "rolled back"):
                installer.apply_uninstall(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), install.proposed)
        self.assertEqual(self.destination.read_bytes(), b"installed")
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o751)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 1)

    def test_uninstall_extracts_destination_only_from_managed_block(self):
        unrelated = b'o.launch("/tmp/unrelated")\n'
        block = installer.make_block("SUPER + SHIFT + K", self.destination, b"\n")
        self.target.write_bytes(unrelated + block)
        plan = installer.create_uninstall_plan(target=self.target)
        self.assertEqual(plan.destination, self.destination)

    def test_yes_without_apply_is_preview_only(self):
        before = self.target.read_bytes()
        runner = FakeRunner()
        with mock.patch.object(installer, "SubprocessRunner", return_value=runner):
            result = installer.main([
                "--target", str(self.target), "--binary", str(self.source),
                "--destination", str(self.destination), "--candidate", "SUPER + SHIFT + K", "--yes",
            ])
        self.assertEqual(result, 0)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(self.destination.exists())

    def test_reload_or_launch_verification_failure_rolls_back_exact_bytes_and_binary(self):
        old_binary = b"old binary"
        self.destination.parent.mkdir()
        self.destination.write_bytes(old_binary)
        self.destination.chmod(0o700)
        original = self.target.read_bytes()
        runner = FakeRunner(failures={("hyprctl", "reload"): "reload failed"})
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + SHIFT + K"],
        )
        with self.assertRaisesRegex(installer.InstallError, "rolled back"):
            installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), original)
        self.assertEqual(self.destination.read_bytes(), old_binary)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_apply_uses_exact_argv_and_verifies_binding_and_new_window(self):
        runner = FakeRunner()
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(64 | 1, "K", "Operator Key"))
        installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(runner.spawned, [(str(self.destination),)])
        self.assertIn(("hyprctl", "-j", "clients"), runner.calls)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 1)

    def test_uninstall_preview_and_apply_remove_only_managed_block(self):
        runner = FakeRunner()
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(installer.replace_managed_block(self.target.read_bytes(), plan.block))
        before_user = b"-- personal\r\n"
        uninstall = installer.create_uninstall_plan(target=self.target)
        self.assertIn("remove the uniquely marked block", installer.render_uninstall_preview(uninstall))
        installer.apply_uninstall(uninstall, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), before_user)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
