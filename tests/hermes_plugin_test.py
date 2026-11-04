import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("axys_plugin", Path(__file__).parents[1] / "hermes/plugins/axys/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

class Tests(unittest.TestCase):
    def test_registration_and_tool_policy(self):
        class Context:
            def __init__(self): self.tools = []; self.hooks = []
            def register_tool(self, **kw): self.tools.append(kw)
            def register_hook(self, name, handler): self.hooks.append((name, handler))
        ctx = Context()
        plugin.register(ctx)
        self.assertEqual([x["name"] for x in ctx.tools], ["axys_continue"])
        self.assertEqual(ctx.tools[0]["schema"]["parameters"]["properties"]["action"]["enum"], ["intake", "draft", "status", "prepare"])
        media = ctx.tools[0]["schema"]["parameters"]["properties"]["payload"]["properties"]["media"]
        self.assertEqual(media["maxItems"], 12)
        session = types.ModuleType("gateway.session_context")
        session.get_session_env = lambda key, default="": "whatsapp_cloud" if key == "HERMES_SESSION_PLATFORM" else default
        sys.modules["gateway.session_context"] = session
        self.assertEqual(plugin.block_tools("terminal")["action"], "block")
        self.assertIsNone(plugin.block_tools("axys_continue"))

    def test_missing_runtime_returns_safe_error(self):
        result = json.loads(plugin.handle({"action": "publish", "payload": {}}))
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("Bearer", result["customerMessage"])

if __name__ == "__main__": unittest.main()
