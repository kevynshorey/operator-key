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


def bind(modmask, key, description, *, release=False, locked=False, repeat=False,
         dispatcher="__lua", arg="42"):
    return {
        "modmask": modmask,
        "key": key,
        "keycode": 0,
        "description": description,
        "release": release,
        "locked": locked,
        "repeat": repeat,
        "submap": "",
        "dispatcher": dispatcher,
        "arg": arg,
    }


class FakeRunner:
    def __init__(self, *, binds=None, clients=None, failures=None):
        self.binds = list(binds or [])
        self.clients = list(clients or [])
        self.failures = dict(failures or {})
        self.calls = []
        self.timeouts = []
        self.trigger_client = {
            "address": "0x99", "class": "operator-key",
            "initialClass": "operator-key", "title": "Operator Key", "pid": 4242,
        }

    def run(self, args, *, timeout=None):
        args = tuple(str(arg) for arg in args)
        self.calls.append(args)
        self.timeouts.append((args, timeout))
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

    def prompt_and_open(self, runner, events=None):
        def prompt(chord):
            if events is not None:
                events.append(("prompt", chord))
            client = dict(runner.trigger_client)
            existing = {item.get("address") for item in runner.clients}
            if client.get("address") in existing:
                client["address"] = f"{client['address']}-{len(runner.clients)}"
            runner.clients.append(client)
        return prompt

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
        self.assertEqual(parsed[0].dispatcher, "__lua")
        self.assertEqual(parsed[0].arg, "42")

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
        self.assertIn("physically press SUPER + SHIFT + K within 120 seconds", preview)
        self.assertNotIn("wtype", preview)
        self.assertNotIn("dispatch __lua", preview)
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
        installer.apply_plan(
            plan, runner=runner, confirm=lambda _: True,
            process_exe_resolver=lambda pid: self.destination,
            prompt_shortcut=self.prompt_and_open(runner),
        )
        first = self.target.read_bytes()
        installer.apply_plan(
            plan, runner=runner, confirm=lambda _: True,
            process_exe_resolver=lambda pid: self.destination,
            prompt_shortcut=self.prompt_and_open(runner),
        )
        self.assertEqual(self.target.read_bytes(), first)
        self.assertEqual(first.count(installer.BEGIN_MARKER.encode()), 1)
        self.assertEqual((Path(str(self.target) + ".operator-key.bak")).read_bytes(), b"-- personal\r\n")
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)
        self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o755)
        self.assertIn(("hyprctl", "reload"), runner.calls)
        self.assertFalse(any(call[:2] == ("hyprctl", "dispatch") for call in runner.calls))
        self.assertFalse(any(call and call[0] == "wtype" for call in runner.calls))

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
        installer.apply_plan(
            plan, runner=runner, confirm=lambda _: True,
            process_exe_resolver=lambda pid: self.destination,
            prompt_shortcut=self.prompt_and_open(runner),
        )
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

    def test_yes_option_is_removed(self):
        with self.assertRaises(SystemExit):
            installer.parse_args(["--yes"])

    def test_non_tty_confirmation_always_fails(self):
        with mock.patch.object(sys.stdin, "isatty", return_value=False):
            with self.assertRaisesRegex(installer.InstallError, "interactive terminal"):
                installer._interactive_confirmation("APPLY SUPER + SHIFT + K")

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
        with self.assertRaisesRegex(installer.InstallError, "rollback incomplete"):
            installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), original)
        self.assertEqual(self.destination.read_bytes(), old_binary)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_apply_prompts_after_reload_and_binding_verification_without_synthetic_trigger(self):
        runner = FakeRunner()
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=runner,
            candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(64 | 1, "K", "Operator Key"))
        events = []

        def prompt(chord):
            self.assertEqual(runner.calls[-1], ("hyprctl", "-j", "clients"))
            reload_index = runner.calls.index(("hyprctl", "reload"))
            verified_bind_index = max(
                index for index, call in enumerate(runner.calls)
                if call == ("hyprctl", "-j", "binds")
            )
            self.assertLess(reload_index, verified_bind_index)
            self.assertLess(verified_bind_index, len(runner.calls) - 1)
            self.assertEqual(self.target.read_bytes(), plan.proposed)
            self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())
            events.append(("prompt", chord))
            runner.clients.append(dict(runner.trigger_client))

        installer.apply_plan(
            plan, runner=runner, confirm=lambda _: True,
            process_exe_resolver=lambda pid: self.destination,
            prompt_shortcut=prompt,
        )
        self.assertNotIn((str(self.destination),), runner.calls)
        self.assertEqual(events, [("prompt", "SUPER + SHIFT + K")])
        self.assertFalse(any(call[:2] == ("hyprctl", "dispatch") for call in runner.calls))
        self.assertFalse(any(call and call[0] == "wtype" for call in runner.calls))
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

    def test_binding_verification_returns_the_unique_managed_binding(self):
        runner = FakeRunner(binds=[bind(65, "K", "Operator Key", arg="987")])
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        verified = installer._verify_binding(plan, runner)
        self.assertEqual((verified.dispatcher, verified.arg), ("__lua", "987"))

    def test_new_client_present_before_prompt_does_not_count(self):
        runner = FakeRunner(clients=[dict(FakeRunner().trigger_client)])
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(65, "K", "Operator Key"))
        clock = mock.Mock(side_effect=[0.0, 0.0, 0.2, 0.4, 0.6])
        with self.assertRaisesRegex(installer.InstallError, "[Pp]hysical shortcut"):
            installer.apply_plan(
                plan, runner=runner, confirm=lambda _: True,
                prompt_shortcut=lambda chord: None,
                monotonic=clock, sleep=lambda seconds: None,
                verification_timeout=0.5,
            )
        self.assertEqual(self.target.read_bytes(), plan.original)
        self.assertFalse(self.destination.exists())

    def test_prompt_exception_rolls_back(self):
        runner = FakeRunner(binds=[bind(65, "K", "Operator Key")])
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )

        def fail_prompt(chord):
            raise RuntimeError("tty write failed")

        with self.assertRaisesRegex(installer.InstallError, "tty write failed"):
            installer.apply_plan(
                plan, runner=runner, confirm=lambda _: True,
                prompt_shortcut=fail_prompt,
            )
        self.assertEqual(self.target.read_bytes(), plan.original)
        self.assertFalse(self.destination.exists())

    def test_physical_verification_uses_one_bounded_deadline(self):
        runner = FakeRunner(binds=[bind(65, "K", "Operator Key")])
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        times = iter([100.0, 100.0, 100.2, 100.7, 101.0])
        sleeps = []
        with self.assertRaisesRegex(installer.InstallError, "[Pp]hysical shortcut"):
            installer.apply_plan(
                plan, runner=runner, confirm=lambda _: True,
                prompt_shortcut=lambda chord: None,
                monotonic=lambda: next(times), sleep=sleeps.append,
                verification_timeout=1.0,
            )
        client_timeouts = [timeout for args, timeout in runner.timeouts
                           if args == ("hyprctl", "-j", "clients")]
        self.assertTrue(client_timeouts)
        self.assertTrue(all(0 < timeout <= 1.0 for timeout in client_timeouts))
        self.assertTrue(all(0 < seconds <= 0.25 for seconds in sleeps))

    def test_default_physical_verification_window_is_one_bounded_120_seconds(self):
        self.assertEqual(installer.PHYSICAL_VERIFICATION_TIMEOUT, 120.0)

        with mock.patch.object(sys.stdin, "isatty", return_value=True):
            with mock.patch("builtins.print") as printed:
                installer._interactive_shortcut_prompt("SUPER + SHIFT + K")

        printed.assert_called_once_with(
            "Press SUPER + SHIFT + K within 120 seconds to verify...",
            flush=True,
        )

    def test_launch_rejects_valid_client_when_query_crosses_deadline(self):
        clock = [0.0]

        class DeadlineCrossingRunner(FakeRunner):
            def __init__(inner_self):
                super().__init__()
                inner_self.client_queries = 0

            def run(inner_self, args, *, timeout=None):
                if tuple(args) == ("hyprctl", "-j", "clients"):
                    inner_self.client_queries += 1
                    if inner_self.client_queries == 2:
                        inner_self.clients.append(dict(inner_self.trigger_client))
                result = super().run(args, timeout=timeout)
                if tuple(args) == ("hyprctl", "-j", "clients") and inner_self.client_queries == 2:
                    clock[0] = 1.1
                return result

        runner = DeadlineCrossingRunner()
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        with self.assertRaisesRegex(installer.InstallError, "timed out"):
            installer._verify_launch(
                plan, runner, lambda pid: self.destination, lambda chord: None,
                monotonic=lambda: clock[0], sleep=lambda seconds: None,
                verification_timeout=1.0,
            )

    def test_launch_rejects_valid_client_when_pid_resolution_crosses_deadline(self):
        clock = [0.0]
        runner = FakeRunner()
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )

        def prompt(chord):
            runner.clients.append(dict(runner.trigger_client))

        def resolve_after_deadline(pid):
            clock[0] = 1.1
            return self.destination

        with self.assertRaisesRegex(installer.InstallError, "timed out"):
            installer._verify_launch(
                plan, runner, resolve_after_deadline, prompt,
                monotonic=lambda: clock[0], sleep=lambda seconds: None,
                verification_timeout=1.0,
            )

    def test_launch_requires_new_exact_class_not_title_or_substring(self):
        runner = FakeRunner()
        runner.trigger_client = {
            "address": "0x99", "class": "not-operator-key-helper",
            "initialClass": "foot", "title": "Operator Key",
        }
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(65, "K", "Operator Key"))
        with self.assertRaisesRegex(installer.InstallError, "[Pp]hysical shortcut"):
            installer.apply_plan(
                plan, runner=runner, confirm=lambda _: True,
                prompt_shortcut=self.prompt_and_open(runner),
                verification_timeout=0.01,
            )

    def test_runtime_identity_is_exact_operator_key_class(self):
        clients = installer._operator_clients(FakeRunner(clients=[
            {"address": "exact", "class": "operator-key", "initialClass": "operator-key"},
            {"address": "reverse-domain", "class": "com.operator-key.overlay"},
            {"address": "title-only", "class": "foot", "title": "Operator Key"},
            {"address": "substring", "class": "operator-key-helper"},
        ]))
        self.assertEqual(set(clients), {"exact"})

    def test_launch_rejects_new_exact_class_client_without_pid(self):
        runner = FakeRunner()
        runner.trigger_client.pop("pid")
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(65, "K", "Operator Key"))
        with self.assertRaisesRegex(installer.InstallError, "PID"):
            installer.apply_plan(
                plan, runner=runner, confirm=lambda _: True,
                prompt_shortcut=self.prompt_and_open(runner),
            )

    def test_post_reload_binding_verification_rejects_same_chord_conflict(self):
        runner = FakeRunner()
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.extend([
            bind(65, "K", "Operator Key"),
            bind(65, "K", "late conflicting binding", dispatcher="exec", arg="other"),
        ])
        with self.assertRaisesRegex(installer.InstallError, "conflicting active binding"):
            installer.apply_plan(plan, runner=runner, confirm=lambda _: True)

    def test_launch_rejects_pid_executable_mismatch(self):
        runner = FakeRunner()
        runner.trigger_client["pid"] = 4242
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(65, "K", "Operator Key"))
        with self.assertRaisesRegex(installer.InstallError, "executable"):
            installer.apply_plan(
                plan, runner=runner, confirm=lambda _: True,
                process_exe_resolver=lambda pid: Path("/wrong/binary"),
                prompt_shortcut=self.prompt_and_open(runner),
            )

    def test_launch_accepts_pid_only_when_executable_matches_destination(self):
        runner = FakeRunner()
        runner.trigger_client["pid"] = 4242
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=runner, candidates=["SUPER + SHIFT + K"],
        )
        runner.binds.append(bind(65, "K", "Operator Key"))
        installer.apply_plan(
            plan, runner=runner, confirm=lambda _: True,
            process_exe_resolver=lambda pid: self.destination,
            prompt_shortcut=self.prompt_and_open(runner),
        )

    def test_uninstall_reloads_then_requires_managed_binding_absent(self):
        install = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(install.proposed)
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"installed")
        plan = installer.create_uninstall_plan(target=self.target)
        runner = FakeRunner(binds=[bind(65, "K", "Operator Key")])
        with self.assertRaisesRegex(installer.InstallError, "still active"):
            installer.apply_uninstall(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), install.proposed)
        self.assertEqual(self.destination.read_bytes(), b"installed")
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_marker_substrings_and_lookalikes_are_not_managed_blocks(self):
        content = (
            b'local a = "-- >>> Operator Key managed binding >>>"\n'
            b"  -- >>> Operator Key managed binding >>>\n"
            b"-- prefix -- <<< Operator Key managed binding <<<\n"
        )
        block = installer.make_block("SUPER + SHIFT + K", self.destination, b"\n")
        self.assertEqual(installer.replace_managed_block(content, block), content + block)
        self.target.write_bytes(content)
        with self.assertRaisesRegex(installer.InstallError, "No Operator Key"):
            installer.create_uninstall_plan(target=self.target)

    def test_exact_marker_lines_inside_lua_long_string_are_ignored(self):
        content = (
            b"local text = [[\n-- >>> Operator Key managed binding >>>\n"
            b"not executable\n-- <<< Operator Key managed binding <<<\n]]\n"
        )
        block = installer.make_block("SUPER + SHIFT + K", self.destination, b"\n")
        self.assertEqual(installer.replace_managed_block(content, block), content + block)

    def test_preview_reports_append_for_marker_lookalikes_without_a_managed_block(self):
        contents = (
            b'local marker = "-- >>> Operator Key managed binding >>>"\n',
            b"  -- >>> Operator Key managed binding >>>\n",
            (
                b"local text = [[\n-- >>> Operator Key managed binding >>>\n"
                b"not executable\n-- <<< Operator Key managed binding <<<\n]]\n"
            ),
        )
        for content in contents:
            with self.subTest(content=content):
                self.target.write_bytes(content)
                plan = installer.create_plan(
                    target=self.target,
                    source=self.source,
                    destination=self.destination,
                    runner=FakeRunner(),
                    candidates=["SUPER + SHIFT + K"],
                )
                preview = installer.render_preview(plan)
                self.assertIn("Change: append one uniquely marked block", preview)
                self.assertNotIn("replace the existing uniquely marked block", preview)
                self.assertEqual(plan.proposed, content + plan.block)

    def test_strict_block_rejects_extra_content_and_multiple_exact_blocks(self):
        good = installer.make_block("SUPER + SHIFT + K", self.destination, b"\n")
        extra = good.replace(
            installer.END_MARKER.encode(),
            b"os.execute('bad')\n" + installer.END_MARKER.encode(),
        )
        for content in (extra, good + good):
            with self.subTest(content=content):
                with self.assertRaisesRegex(installer.InstallError, "managed|marker"):
                    installer.remove_managed_block(content)

    def test_apply_revalidates_exact_proposed_bytes_before_mutation(self):
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        from dataclasses import replace
        tampered = replace(plan, proposed=plan.proposed + b"-- injected\n")
        with self.assertRaisesRegex(installer.InstallError, "plan bytes"):
            installer.apply_plan(tampered, runner=FakeRunner(), confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), plan.original)

    def test_install_rollback_continues_after_config_restore_fails(self):
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        runner = FakeRunner(failures={("hyprctl", "reload"): "reload failed"})
        original_write = installer._atomic_write

        def fail_config_restore(path, data, mode):
            if path == self.target and data == plan.original and self.target.read_bytes() == plan.proposed:
                raise OSError("restore config failed")
            return original_write(path, data, mode)

        with mock.patch.object(installer, "_atomic_write", side_effect=fail_config_restore):
            with self.assertRaisesRegex(installer.InstallError, "rollback incomplete.*restore config failed"):
                installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertFalse(self.destination.exists())
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_uninstall_rollback_continues_after_config_restore_fails(self):
        install = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(install.proposed)
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"installed")
        plan = installer.create_uninstall_plan(target=self.target)
        runner = FakeRunner(failures={("hyprctl", "reload"): "reload failed"})
        original_write = installer._atomic_write

        def fail_config_restore(path, data, mode):
            if path == self.target and data == plan.original and self.target.read_bytes() == plan.proposed:
                raise OSError("restore config failed")
            return original_write(path, data, mode)

        with mock.patch.object(installer, "_atomic_write", side_effect=fail_config_restore):
            with self.assertRaisesRegex(installer.InstallError, "rollback incomplete.*restore config failed"):
                installer.apply_uninstall(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.destination.read_bytes(), b"installed")
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_install_rollback_reloads_after_destination_restore_fails(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"old")
        plan = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        runner = FakeRunner(failures={("hyprctl", "reload"): "primary reload failed"})
        original_write = installer._atomic_write

        def fail_destination_restore(path, data, mode):
            if path == self.destination and data == b"old" and self.target.read_bytes() == plan.original:
                raise OSError("restore destination failed")
            return original_write(path, data, mode)

        with mock.patch.object(installer, "_atomic_write", side_effect=fail_destination_restore):
            with self.assertRaisesRegex(installer.InstallError, "restore destination failed"):
                installer.apply_plan(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), plan.original)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_uninstall_rollback_reloads_after_destination_restore_fails(self):
        install = installer.create_plan(
            target=self.target, source=self.source, destination=self.destination,
            runner=FakeRunner(), candidates=["SUPER + SHIFT + K"],
        )
        self.target.write_bytes(install.proposed)
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"installed")
        plan = installer.create_uninstall_plan(target=self.target)
        runner = FakeRunner(failures={("hyprctl", "reload"): "primary reload failed"})
        original_write = installer._atomic_write

        def fail_destination_restore(path, data, mode):
            if path == self.destination and data == b"installed" and self.target.read_bytes() == plan.original:
                raise OSError("restore destination failed")
            return original_write(path, data, mode)

        with mock.patch.object(installer, "_atomic_write", side_effect=fail_destination_restore):
            with self.assertRaisesRegex(installer.InstallError, "restore destination failed"):
                installer.apply_uninstall(plan, runner=runner, confirm=lambda _: True)
        self.assertEqual(self.target.read_bytes(), plan.original)
        self.assertEqual(runner.calls.count(("hyprctl", "reload")), 2)

    def test_backup_race_preserves_competing_regular_file(self):
        backup = self.root / "race.bak"
        original_link = os.link

        def competitor_wins(source, destination, *, follow_symlinks=True):
            Path(destination).write_bytes(b"competitor backup")
            return original_link(source, destination, follow_symlinks=follow_symlinks)

        with mock.patch.object(installer.os, "link", side_effect=competitor_wins):
            installer._backup_if_absent(backup, b"our backup", 0o640, "race backup")

        self.assertEqual(backup.read_bytes(), b"competitor backup")

    def test_backup_race_rejects_competing_symlink(self):
        backup = self.root / "race.bak"
        protected = self.root / "protected"
        protected.write_bytes(b"protected bytes")
        original_link = os.link

        def symlink_wins(source, destination, *, follow_symlinks=True):
            Path(destination).symlink_to(protected)
            return original_link(source, destination, follow_symlinks=follow_symlinks)

        with mock.patch.object(installer.os, "link", side_effect=symlink_wins):
            with self.assertRaisesRegex(installer.InstallError, "symlink"):
                installer._backup_if_absent(backup, b"our backup", 0o640, "race backup")

        self.assertTrue(backup.is_symlink())
        self.assertEqual(protected.read_bytes(), b"protected bytes")

    def test_eof_confirmation_is_controlled_and_writes_nothing(self):
        plan = installer.create_plan(
            target=self.target,
            source=self.source,
            destination=self.destination,
            runner=FakeRunner(),
            candidates=["SUPER + SHIFT + K"],
        )
        before = self.target.read_bytes()

        with mock.patch.object(sys.stdin, "isatty", return_value=True):
            with mock.patch("builtins.input", side_effect=EOFError):
                with self.assertRaisesRegex(installer.InstallError, "confirmation input"):
                    installer.apply_plan(
                        plan,
                        runner=FakeRunner(),
                        confirm=installer._interactive_confirmation,
                    )

        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(self.destination.exists())

    def test_same_line_lua_long_comments_do_not_hide_managed_block(self):
        old = installer.make_block("SUPER + SHIFT + K", self.destination, b"\n")
        new = installer.make_block("SUPER + SHIFT + Q", self.destination, b"\n")

        for comment in (b"--[[ closed ]]\n", b"--[=[ closed ]=]\n"):
            with self.subTest(comment=comment):
                content = comment + old
                replaced = installer.replace_managed_block(content, new)
                self.assertEqual(replaced, comment + new)
                self.assertEqual(installer.replace_managed_block(replaced, new), replaced)

    def test_uninstall_recognizes_block_after_same_line_long_comment(self):
        comment = b"--[=[ ordinary comment ]=]\n"
        block = installer.make_block("SUPER + SHIFT + K", self.destination, b"\n")
        self.target.write_bytes(comment + block)

        plan = installer.create_uninstall_plan(target=self.target)

        self.assertEqual(plan.chord, "SUPER + SHIFT + K")
        self.assertEqual(plan.destination, self.destination)
        self.assertEqual(plan.proposed, comment)


if __name__ == "__main__":
    unittest.main()
