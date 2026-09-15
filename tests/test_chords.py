import importlib.util
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

    def test_dedupe_preserves_intentional_omarchy_press_release_entries(self):
        press = build.entry("omarchy", "hotkey", "F9", "Mute microphone", "test", "1", context="desktop")
        release = build.entry("omarchy", "hotkey", "F9", "Unmute microphone on release", "test", "1", context="desktop")
        self.assertEqual(len(build.dedupe([press, release])), 2)


if __name__ == "__main__":
    unittest.main()
