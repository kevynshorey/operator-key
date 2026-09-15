import copy
import importlib.util
import itertools
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


chords = load("chords", ROOT / "scripts" / "chords.py")
build = load("build_catalog_chords", ROOT / "scripts" / "build_catalog.py")


class ChordTests(unittest.TestCase):
    def test_omarchy_modifier_order_is_canonical(self):
        self.assertEqual(
            chords.canonicalize_chord("SUPER SHIFT CTRL + SPACE"),
            "ctrl+shift+super+space",
        )

    def test_terminal_plus_delimited_modifier_order_is_canonical(self):
        self.assertEqual(
            chords.canonicalize_chord("Shift+Ctrl+P"),
            chords.canonicalize_chord("CTRL SHIFT P"),
        )
        self.assertEqual(chords.canonicalize_chord("Shift+Ctrl+P"), "ctrl+shift+p")

    def test_canonicalization_preserves_alternatives_and_key_sequences(self):
        self.assertEqual(
            chords.canonicalize_chord("Alt+Enter / Ctrl+Enter / Ctrl+J"),
            "alt+enter / ctrl+enter / ctrl+j",
        )
        self.assertEqual(chords.canonicalize_chord("Ctrl+X Ctrl+E"), "ctrl+x ctrl+e")

    def test_canonicalization_normalizes_documented_alternative_syntax(self):
        cases = {
            "Ctrl+_ or Ctrl+Shift+-": "ctrl+_ / ctrl+shift+-",
            "Option+P (macOS) or Alt+P (Windows/Linux)": "alt+p / alt+p",
            "{ / }": "{ / }",
            "q, Ctrl+C, Esc": "q / ctrl+c / esc",
        }
        for display, expected in cases.items():
            with self.subTest(display=display):
                self.assertEqual(chords.canonicalize_chord(display), expected)

    def test_canonicalization_does_not_split_compact_vim_expressions_or_paths(self):
        self.assertEqual(chords.canonicalize_chord("h/j/k/l"), "h/j/k/l")
        self.assertEqual(chords.canonicalize_chord("/tmp/operator-key"), "/tmp/operator-key")

    def test_canonicalization_handles_a_backslash_plus_enter_combo(self):
        self.assertEqual(chords.canonicalize_chord(r"\ + Enter"), r"\+enter")

    def test_conflicts_are_keyed_by_canonical_chord_and_overlapping_context(self):
        rows = [
            {"id": "a", "product": "hermes", "interface": "hotkey", "command": "Ctrl+Shift+P", "context": "Hermes interactive terminal"},
            {"id": "b", "product": "claude-code", "interface": "hotkey", "command": "SHIFT CTRL P", "context": "Claude Code interactive terminal"},
            {"id": "c", "product": "omarchy", "interface": "hotkey", "command": "SUPER + P", "context": "Omarchy/Hyprland desktop"},
        ]

        conflicts = chords.annotate_conflicts(rows)

        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["canonical_chord"], "ctrl+shift+p")
        self.assertEqual(conflicts[0]["entry_ids"], ["a", "b"])
        self.assertEqual(rows[0]["command"], "Ctrl+Shift+P")
        self.assertEqual(rows[0]["conflict_ids"], [conflicts[0]["id"]])
        self.assertEqual(rows[2]["conflict_ids"], [])

    def test_alternative_chords_conflict_with_each_single_chord(self):
        rows = [
            {"id": "alternatives", "product": "claude-code", "interface": "hotkey", "command": "q, Ctrl+C, Esc", "context": "Claude Code interactive terminal"},
            {"id": "interrupt", "product": "claude-code", "interface": "hotkey", "command": "Ctrl+C", "context": "Claude Code interactive terminal"},
            {"id": "escape", "product": "claude-code", "interface": "hotkey", "command": "Esc", "context": "Claude Code interactive terminal"},
        ]

        conflicts = chords.annotate_conflicts(rows)

        self.assertEqual({item["canonical_chord"] for item in conflicts}, {"ctrl+c", "esc"})
        self.assertEqual(len(rows[0]["conflict_ids"]), 2)

    def test_conflicts_and_row_conflict_ids_are_independent_of_input_order(self):
        source = [
            {"id": "multi", "interface": "hotkey", "command": "Ctrl+Z / Ctrl+A", "context": "terminal"},
            {"id": "alpha", "interface": "hotkey", "command": "Ctrl+A", "context": "terminal"},
            {"id": "zulu", "interface": "hotkey", "command": "Ctrl+Z", "context": "terminal"},
            {"id": "desktop-a", "interface": "hotkey", "command": "Ctrl+A", "context": "desktop"},
            {"id": "desktop-b", "interface": "hotkey", "command": "Ctrl+A", "context": "desktop"},
        ]
        expected = None
        for permutation in itertools.permutations(source):
            rows = copy.deepcopy(list(permutation))
            conflicts = chords.annotate_conflicts(rows)
            result = (conflicts, {row["id"]: row["conflict_ids"] for row in rows})
            if expected is None:
                expected = result
            else:
                self.assertEqual(result, expected)

    def test_dedupe_preserves_intentional_omarchy_press_release_entries(self):
        press = build.entry("omarchy", "hotkey", "F9", "Mute microphone", "test", "1", context="desktop")
        release = build.entry("omarchy", "hotkey", "F9", "Unmute microphone on release", "test", "1", context="desktop")
        self.assertEqual(len(build.dedupe([press, release])), 2)


if __name__ == "__main__":
    unittest.main()
