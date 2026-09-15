import importlib.util
import json
import subprocess
import unittest
from pathlib import Path

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

    def test_generated_catalog_preserves_every_omarchy_binding(self):
        source = subprocess.check_output(
            ["omarchy", "menu", "keybindings", "--print"], text=True
        )
        expected = sum("→" in line for line in source.splitlines())
        catalog = json.loads((ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
        actual = sum(row["product"] == "omarchy" for row in catalog["entries"])
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
