import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TauriCapabilityTests(unittest.TestCase):
    def test_frontend_close_permission_is_minimal(self):
        capability = json.loads(
            (ROOT / "src-tauri" / "capabilities" / "default.json").read_text()
        )

        permissions = capability["permissions"]
        self.assertIn("core:window:allow-close", permissions)
        self.assertNotIn("core:window:allow-hide", permissions)


if __name__ == "__main__":
    unittest.main()
