"""Security/adapter checks. These do not claim model grounding accuracy."""
import json
from pathlib import Path
import runpy
import unittest

worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'agent_s' / 'worker.py'))

class RestrictedActions(unittest.TestCase):
    def test_read_only_has_no_mutation_tools(self):
        aci = worker['ReadACI'](None)
        with self.assertRaises(ValueError):
            worker['safe_dispatch'](aci, 'agent.click("Pay")', {})

    def test_only_literal_declared_calls(self):
        aci = worker['ReadACI'](None)
        for code in ['__import__("os").system("anything")', 'agent.report(str(1))', 'agent.__class__()',
                     'agent.report("a"); agent.done()', 'agent.report(*["a"])']:
            with self.subTest(code=code), self.assertRaises((ValueError,SyntaxError)):
                worker['safe_dispatch'](aci, code, {})
        self.assertEqual(json.loads(worker['safe_dispatch'](aci,'agent.done()',{})),{'operation':'done'})

    def test_upstream_eval_aliases_are_replaced(self):
        for name in ['common_utils','formatters','upstream_worker']:
            self.assertIs(worker[name].create_pyautogui_code,worker['safe_dispatch'])

if __name__ == '__main__':
    unittest.main()
