import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("verify_native", Path(__file__).parents[1] / "scripts" / "verify_native.py")
verify_native = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(verify_native)


class TypeQueryTests(unittest.TestCase):
    def test_copy_flow_replaces_query_then_uses_plain_return(self):
        with patch.object(verify_native, "run") as runner, patch.object(verify_native.time, "sleep"):
            verify_native.type_query()
        self.assertEqual([call.args[0] for call in runner.call_args_list], [
            ["wtype", "-k", "Home", "-M", "shift", "-k", "End", "-m", "shift", "-k", "BackSpace"],
            ["wtype", "-d", "35", verify_native.QUERY],
            ["wtype", "-k", "Return"],
        ])

    def test_insert_flow_uses_shift_return_without_plain_return(self):
        with patch.object(verify_native, "run") as runner, patch.object(verify_native.time, "sleep"):
            verify_native.type_query(shift_enter=True)
        calls = [call.args[0] for call in runner.call_args_list]
        self.assertEqual(calls[-1], ["wtype", "-M", "shift", "-k", "Return", "-m", "shift"])
        self.assertNotIn(["wtype", "-k", "Return"], calls)


if __name__ == "__main__":
    unittest.main()
