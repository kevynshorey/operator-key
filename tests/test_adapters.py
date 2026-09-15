import unittest
from pathlib import Path

from scripts.adapters import claude, codex, hermes, omarchy

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


class HermesAdapterTests(unittest.TestCase):
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
