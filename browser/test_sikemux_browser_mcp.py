import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from mcp.types import ListToolsRequest

from sikemux_browser_mcp import HIDDEN_TOOLS, SikemuxBrowserServer


class SikemuxBrowserServerTests(unittest.TestCase):
    def server(self, agent_id: str, state_dir: Path) -> SikemuxBrowserServer:
        os.environ.update(
            SIKEMUX_BROWSER_AGENT_ID=agent_id,
            SIKEMUX_BROWSER_STATE_DIR=str(state_dir),
            SIKEMUX_BROWSER_CDP_URL="http://127.0.0.1:1",
        )
        return SikemuxBrowserServer()

    def test_registry_isolates_agent_tabs(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            first = self.server("agent-one", state_dir)
            second = self.server("agent-two", state_dir)

            first._register_target("target-one")
            second._register_target("target-two")

            self.assertEqual(first._owned_target_ids(), {"target-one"})
            self.assertEqual(second._owned_target_ids(), {"target-two"})
            with self.assertRaises(ValueError):
                first._resolve_owned_tab("two")

    def test_tool_list_exposes_only_scoped_direct_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            server = self.server("agent-one", Path(directory))

            async def list_tools():
                handler = server.server.request_handlers[ListToolsRequest]
                result = await handler(ListToolsRequest(method="tools/list"))
                return {tool.name for tool in result.root.tools}

            tools = asyncio.run(list_tools())
            self.assertFalse(tools & HIDDEN_TOOLS)
            self.assertIn("browser_get_state", tools)
            self.assertIn("browser_switch_tab", tools)

    def test_rejects_agent_ids_that_can_escape_state_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(SystemExit):
                self.server("../agent", Path(directory))


if __name__ == "__main__":
    unittest.main()
