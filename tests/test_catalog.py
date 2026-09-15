import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.adapters import claude, codex, hermes, omarchy

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load("build_catalog", ROOT / "scripts" / "build_catalog.py")
query = load("operator_key", ROOT / "scripts" / "operator_key.py")


class CatalogTests(unittest.TestCase):
    def test_review_classification(self):
        self.assertEqual(build.classify("/review", "Review working tree"), "review-and-verify")

    def test_danger_classification(self):
        self.assertEqual(build.safety("/delete", "Delete session"), ("red", True))

    def test_read_only_review_is_green_even_when_description_mentions_fixing(self):
        self.assertEqual(
            build.safety("/code-review", "Review changes; optionally pass --fix"),
            ("green", False),
        )

    def test_search_prefers_command_match(self):
        exact = build.entry("codex", "slash-command", "/review", "Review code", "test", "1")
        loose = build.entry("codex", "slash-command", "/status", "Review status", "test", "1")
        self.assertGreater(query.score(exact, ["review"]), query.score(loose, ["review"]))

    def test_dedupe_keeps_one_identity(self):
        first = build.entry("hermes", "hotkey", "Ctrl+C", "Interrupt", "official: docs", "1", context="terminal")
        second = build.entry("hermes", "hotkey", "Ctrl+C", "Interrupt locally", "local: source", "1", context="terminal")
        rows = build.dedupe([first, second])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source"], "local: source")

    def test_markdown_table_pipe_inside_code_is_not_a_column(self):
        row = "| `/review [low | medium | high]` | Review a change |"
        cells = build.split_markdown_cells(row)
        self.assertEqual(cells, ["`/review [low | medium | high]`", "Review a change"])

    def test_minimal_fixture_satisfies_catalog_contract(self):
        fixture = json.loads(
            (ROOT / "tests" / "fixtures" / "catalog.minimal.json").read_text(encoding="utf-8")
        )
        self.assertEqual(build.validate_catalog(fixture), [])

    def test_catalog_contract_rejects_missing_fields_and_unknown_enum_values(self):
        fixture = json.loads(
            (ROOT / "tests" / "fixtures" / "catalog.minimal.json").read_text(encoding="utf-8")
        )
        del fixture["entries"][0]["description"]
        fixture["entries"][0]["safety_level"] = "purple"
        errors = build.validate_catalog(fixture)
        self.assertTrue(any("description is required" in error for error in errors), errors)
        self.assertTrue(any("safety_level must be one of" in error for error in errors), errors)

    def test_generated_catalog_preserves_every_omarchy_binding(self):
        source = subprocess.check_output(
            ["omarchy", "menu", "keybindings", "--print"], text=True
        )
        expected = [
            tuple(part.strip() for part in line.split("→", 1))
            for line in source.splitlines()
            if "→" in line
        ]
        catalog = json.loads((ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
        actual = [
            (row["command"], row["description"])
            for row in catalog["entries"]
            if row["product"] == "omarchy" and row["provenance"]["kind"] == "default"
        ]
        self.assertEqual(actual, expected)

    def test_build_document_integrates_adapters_schema_and_conflicts(self):
        versions = {
            "omarchy": "4.0.3-1",
            "hermes": "0.21.3",
            "claude-code": "2.1.272",
            "codex": "0.154.0",
        }
        omarchy_rows = omarchy.parse_bindings(
            (ROOT / "tests" / "fixtures" / "omarchy.bindings.txt").read_text(encoding="utf-8"),
            versions["omarchy"],
        )
        hermes_rows = hermes.parse_controls("", versions["hermes"])
        claude_rows = claude.parse_keybindings(
            '[{"context":"Claude Code interactive terminal","bindings":{"Ctrl+B":"voice"}}]',
            versions["claude-code"],
            "fixture: claude-keybindings.json",
        )
        codex_rows = codex.parse_keymap(
            '{"bindings":[{"key":"Ctrl+B","action":"toggle"}]}',
            versions["codex"],
            "fixture: codex-keymap.json",
        )

        with (
            mock.patch.object(build.omarchy_adapter, "collect", return_value=omarchy_rows) as omarchy_collect,
            mock.patch.object(build.hermes_adapter, "collect", return_value=hermes_rows) as hermes_collect,
            mock.patch.object(build.claude_adapter, "collect", return_value=claude_rows) as claude_collect,
            mock.patch.object(build.codex_adapter, "collect", return_value=codex_rows) as codex_collect,
            mock.patch.object(build, "fetch", return_value=""),
        ):
            document = build.build_document(offline=True, versions=versions)

        for collector in (omarchy_collect, hermes_collect, claude_collect, codex_collect):
            collector.assert_called_once()
        self.assertEqual(build.validate_catalog(document), [])
        self.assertTrue(document["conflicts"])
        self.assertTrue(all("canonical_chord" in row and "provenance" in row for row in document["entries"]))
        self.assertTrue(any(row["source"].startswith("fixture:") for row in document["entries"]))

    def test_main_rejects_invalid_catalog_without_replacing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "catalog.json"
            original = '{"known":"valid previous output"}\n'
            output.write_text(original, encoding="utf-8")
            with mock.patch.object(build, "build_document", return_value={"invalid": True}):
                result = build.main(["--offline", "--output", str(output)])
            self.assertNotEqual(result, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
