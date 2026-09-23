import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.adapters import claude, codex, hermes, omarchy
from scripts.adapters.common import safety

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


def text(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


class OmarchyAdapterTests(unittest.TestCase):
    def test_source_rows_remain_verbatim_and_overrides_are_separate_records(self):
        rows = omarchy.parse_bindings(
            text("omarchy.bindings.txt"),
            "4.0.3-1",
            overrides_text=text("hypr-bindings.lua"),
            overrides_source="fixture: bindings.lua",
        )
        expected_source = [
            tuple(part.strip() for part in line.split("→", 1))
            for line in text("omarchy.bindings.txt").splitlines()
            if "→" in line
        ]
        source_rows = [
            (row["command"], row["description"])
            for row in rows
            if row["provenance"]["kind"] == "default"
        ]
        self.assertEqual(source_rows, expected_source)
        self.assertEqual(sum(row["command"] == "F9" for row in rows), 2)

        overrides = [row for row in rows if row["provenance"]["kind"] == "override"]
        replacement = next(
            row for row in overrides
            if row["command"] == "SUPER + SPACE" and row["available"]
        )
        self.assertEqual(replacement["description"], "Custom launcher")
        self.assertTrue(any(row["command"] == "SUPER + N" and row["available"] for row in overrides))
        disabled = {row["command"] for row in overrides if not row["available"]}
        self.assertEqual(disabled, {"SUPER + SPACE", "SUPER + SHIFT + B"})

    def test_unreadable_optional_override_is_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            override = Path(directory) / "bindings.lua"
            override.write_text("o.bind('SUPER + X', nil, 'Custom')", encoding="utf-8")
            original_read_text = Path.read_text

            def unreadable_optional(path, *args, **kwargs):
                if path == override:
                    raise OSError("unreadable")
                return original_read_text(path, *args, **kwargs)

            with (
                mock.patch.object(Path, "read_text", unreadable_optional),
                mock.patch.object(omarchy, "run", return_value="SUPER + P → Launcher"),
            ):
                rows = omarchy.collect("4.0.3-1", override)

        self.assertEqual([(row["command"], row["description"]) for row in rows], [("SUPER + P", "Launcher")])


class HermesAdapterTests(unittest.TestCase):
    def test_mutating_command_verbs_are_not_classified_as_green(self):
        for command in (
            "hermes pets select", "hermes project archive", "hermes config set",
            "hermes skills add",
        ):
            with self.subTest(command=command):
                level, destructive = safety(command, "")
                self.assertEqual(level, "amber")
                self.assertFalse(destructive)

    def test_memory_reset_remains_red_and_destructive_in_adapter_output(self):
        from scripts.adapters.common import entry
        reset = entry("hermes", "cli-command", "hermes memory reset", "Reset memory", "fixture", "0.21.3")
        self.assertEqual((reset["safety_level"], reset["destructive"]), ("red", True))

    def test_red_danger_takes_precedence_over_mutating_action_heuristic(self):
        self.assertEqual(safety("hermes sessions delete", ""), ("red", True))

    def test_cloud_command_that_pushes_fixes_is_not_green(self):
        self.assertEqual(
            safety("/autofix-pr", "Spawn a cloud session that watches a PR and pushes fixes"),
            ("amber", False),
        )

    def test_help_registry_and_key_control_sources_are_collected(self):
        rows = []
        rows += hermes.parse_help(text("hermes-help.txt"), "0.21.3")
        rows += hermes.parse_registry(
            text("hermes-commands.py"), "0.21.3", "fixture: commands.py"
        )
        rows += hermes.parse_controls(text("hermes-config.yaml"), "0.21.3")
        review = next(row for row in rows if row["command"] == "/review")
        self.assertEqual(review["aliases"], ["/rv"])
        self.assertIn("cli_only", review["context"])
        voice = next(row for row in rows if row["command"] == "Alt+Space")
        self.assertEqual(voice["provenance"]["kind"], "override")

    def test_unreadable_optional_registry_and_config_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "hermes_cli" / "commands.py"
            registry.parent.mkdir()
            registry.write_text("CommandDef('custom', 'Custom', 'test')", encoding="utf-8")
            config = root / "config.yaml"
            config.write_text("voice:\n  record_key: alt-space\n", encoding="utf-8")
            original_read_text = Path.read_text

            def unreadable_optional(path, *args, **kwargs):
                if path in {registry, config}:
                    raise UnicodeError("invalid encoding")
                return original_read_text(path, *args, **kwargs)

            with (
                mock.patch.object(Path, "read_text", unreadable_optional),
                mock.patch.object(hermes, "run", return_value=""),
            ):
                rows = hermes.collect(
                    "0.21.3", install_dir=root, config_path=config, include_subcommands=False
                )

        self.assertEqual(len(rows), len(hermes.HERMES_KEYS))
        self.assertFalse(any(row["provenance"]["kind"] == "override" for row in rows))


class ClaudeAdapterTests(unittest.TestCase):
    def test_custom_commands_skills_agents_and_keybindings_are_collected(self):
        rows = claude.parse_customizations(FIXTURES / "claude-home", "2.1.272")
        by_command = {row["command"]: row for row in rows}
        self.assertIn("/review", by_command)
        self.assertIn("/deploy", by_command)
        self.assertIn("--agent reviewer", by_command)
        self.assertEqual(by_command["shift+ctrl+p"]["provenance"]["kind"], "override")
        self.assertFalse(by_command["ctrl+d"]["available"])
        self.assertEqual(by_command["ctrl+d"]["provenance"]["status"], "disabled")

    def test_non_collection_keybinding_documents_are_ignored(self):
        documents = (
            "null",
            "42",
            '"shortcut"',
            '{"unsupported": {"Ctrl+X": "action"}}',
            '{"bindings": 42}',
            '{"keybindings": "not-a-collection"}',
        )
        for document in documents:
            with self.subTest(document=document):
                self.assertEqual(
                    claude.parse_keybindings(document, "2.1.272", "fixture: keybindings.json"),
                    [],
                )

    def test_unusable_optional_customization_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills" / "broken" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: broken\n---\n", encoding="utf-8")
            keybindings = root / "keybindings.json"
            keybindings.write_text("{not json", encoding="utf-8")
            original_read_text = Path.read_text

            def unusable_optional(path, *args, **kwargs):
                if path == skill:
                    raise UnicodeError("invalid encoding")
                return original_read_text(path, *args, **kwargs)

            with mock.patch.object(Path, "read_text", unusable_optional):
                rows = claude.parse_customizations(root, "2.1.272")

        self.assertEqual(rows, [])

    def test_docs_table_preserves_inline_code_pipes_in_command_and_description(self):
        commands = """\
## Review
| Command | Purpose |
| --- | --- |
| `/review [low | high]` | Use `foo | bar` safely |
"""

        rows = claude.parse_docs(commands, "", "2.1.272")

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["command"], "/review")
        self.assertEqual(rows[0]["description"], "Use foo | bar safely")

    def test_keyboard_tables_select_columns_by_header_and_append_context(self):
        keys = r"""
### Multiline input
| Method | Shortcut | Context |
| --- | --- | --- |
| Quick escape | `\` + `Enter` | Works in all terminals |

### Mode switching
| Command | Action | From mode |
| --- | --- | --- |
| `Esc` or `Ctrl+[` | Enter NORMAL mode | INSERT, VISUAL |
"""

        rows = claude.parse_docs("", keys, "2.1.272")
        by_description = {row["description"]: row for row in rows}

        quick_escape = by_description["Quick escape"]
        self.assertEqual(quick_escape["command"], r"\ + Enter")
        self.assertIn("Works in all terminals", quick_escape["context"])

        normal_mode = by_description["Enter NORMAL mode"]
        self.assertEqual(normal_mode["command"], "Esc or Ctrl+[")
        self.assertIn("From mode: INSERT, VISUAL", normal_mode["context"])


class CodexAdapterTests(unittest.TestCase):
    def test_help_config_and_keymap_are_collected_without_secrets(self):
        rows = []
        rows += codex.parse_help(text("codex-help.txt"), "0.154.0")
        rows += codex.parse_config(text("codex-config.toml"), "0.154.0", "fixture: config.toml")
        rows += codex.parse_keymap(text("codex-keymap.json"), "0.154.0", "fixture: keymap.json")
        commands = {row["command"]: row for row in rows}
        self.assertIn("codex review", commands)
        self.assertIn('-c model="gpt-5.6"', commands)
        self.assertIn("-c features.web_search=true", commands)
        self.assertFalse(any("api_key" in row["command"] or "must-not-leak" in row["command"] for row in rows))
        self.assertEqual(commands['-c model="gpt-5.6"']["provenance"]["kind"], "override")
        self.assertFalse(commands["ctrl+x"]["available"])

    def test_unusable_optional_config_and_keymap_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.toml"
            config.write_text('model = "gpt-5.6"\n', encoding="utf-8")
            keymap = root / "keymap.json"
            keymap.write_text("{not json", encoding="utf-8")
            original_read_text = Path.read_text

            def unusable_optional(path, *args, **kwargs):
                if path == config:
                    raise OSError("unreadable")
                return original_read_text(path, *args, **kwargs)

            with (
                mock.patch.object(Path, "read_text", unusable_optional),
                mock.patch.object(codex, "run", return_value=""),
            ):
                rows = codex.collect("0.154.0", "", home=root)

        self.assertEqual(rows, [])

    def test_config_omits_unknown_secret_named_scalar_values(self):
        config = '''
model = "gpt-5.6"
PRIVATE_KEY = "super-private-value"
GITHUB_PAT = "ghp_example_secret_value"
Authorization = "Bearer example-secret-value"

[features]
web_search = true
'''

        rows = codex.parse_config(config, "0.154.0", "fixture: adversarial-config.toml")
        serialized = repr(rows)

        self.assertEqual(
            [row["command"] for row in rows],
            ['-c model="gpt-5.6"', "-c features.web_search=true"],
        )
        for sentinel in (
            "super-private-value",
            "ghp_example_secret_value",
            "Bearer example-secret-value",
        ):
            with self.subTest(sentinel=sentinel):
                self.assertNotIn(sentinel, serialized)

    def test_config_omits_unknown_nested_list_and_url_values(self):
        config = '''
model = "gpt-5.6"
unknown_nested = { payload = "nested-secret-value", items = ["list-secret-value"] }
unknown_urls = [
  "https://user:password@example.test/private",
  "https://example.test/callback?token=query-secret-value",
]
'''

        rows = codex.parse_config(config, "0.154.0", "fixture: adversarial-config.toml")
        serialized = repr(rows)

        self.assertEqual([row["command"] for row in rows], ['-c model="gpt-5.6"'])
        for sentinel in (
            "nested-secret-value",
            "list-secret-value",
            "user:password",
            "query-secret-value",
        ):
            with self.subTest(sentinel=sentinel):
                self.assertNotIn(sentinel, serialized)


if __name__ == "__main__":
    unittest.main()
