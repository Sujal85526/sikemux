import asyncio
import json
import os
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp.types import CallToolRequest, CallToolRequestParams, ListToolsRequest

import sikemux_harness
from sikemux_browser_mcp import build_server, content_for, tool_definitions


class FakeSikemux:
    """Answers harness frames the way the app's CLI broker does."""

    def __init__(self, reply):
        self.reply = reply
        self.received = []
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(4)
        self.listener.settimeout(15)
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            with connection, connection.makefile("rb") as stream:
                request = json.loads(stream.readline())
                self.received.append(request)
                connection.sendall(json.dumps(self.reply(request)).encode() + b"\n")

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory()
        endpoint = Path(self.directory.name) / "endpoint.json"
        endpoint.write_text(json.dumps({"protocol": 1, "token": "test-token", "port": self.listener.getsockname()[1]}))
        self.thread.start()
        self.environment = patch.dict(os.environ, {"SIKEMUX_CLI_ENDPOINT": str(endpoint), "SIKEMUX_PROJECT": "/project", "SIKEMUX_BROWSER_AGENT_ID": "agent-one"})
        self.environment.start()
        return self

    def __exit__(self, *_):
        self.environment.stop()
        self.listener.close()
        self.directory.cleanup()


def run_tool(server, name, arguments):
    async def call():
        handler = server.request_handlers[CallToolRequest]
        result = await handler(CallToolRequest(method="tools/call", params=CallToolRequestParams(name=name, arguments=arguments)))
        return result.root

    return asyncio.run(call())


class SikemuxBrowserServerTests(unittest.TestCase):
    def test_every_served_tool_comes_from_the_manifest(self):
        names = [tool.name for tool in tool_definitions()]
        self.assertEqual(len(names), len(set(names)), "a tool is declared twice in tools.json")
        for expected in ("browser_navigate", "sikemux_workspace_inspect", "sikemux_guide"):
            self.assertIn(expected, names)
        for name in names:
            if name != sikemux_harness.GUIDE_TOOL_NAME:
                self.assertIn(name, sikemux_harness.METHOD_BY_NAME, f"{name} has no harness method")
        for tool in tool_definitions():
            self.assertFalse(tool.inputSchema["additionalProperties"])

    def test_browser_tools_are_answered_by_sikemux_for_this_agent(self):
        state = {"url": "https://example.com", "title": "Example", "elements": "[0] <a> Sign in", "text": "hello", "tabs": []}
        with FakeSikemux(lambda request: {"status": "result", "value": state}) as app:
            server = build_server("agent-one")
            result = run_tool(server, "browser_navigate", {"url": "example.com"})
            self.assertFalse(result.isError)
            self.assertEqual(json.loads(result.content[0].text), state)
            request = app.received[0]["request"]
            self.assertEqual(request["method"], "browser.navigate")
            self.assertEqual(request["params"], {"url": "example.com"})
            self.assertEqual(request["agentId"], "agent-one")
            self.assertEqual(app.received[0]["token"], "test-token")

    def test_the_guide_is_served_without_asking_the_app(self):
        server = build_server("agent-one")
        with patch.dict(os.environ, {}, clear=True):
            result = run_tool(server, "sikemux_guide", {})
        self.assertFalse(result.isError)
        self.assertIn("Working inside Sikemux", result.content[0].text)
        self.assertIn("Element numbers expire", result.content[0].text)

    def test_schemas_stay_lean_so_prose_lives_in_the_guide(self):
        tools = tool_definitions()
        prose = sum(len(tool.description or "") for tool in tools)
        self.assertLessEqual(prose, 1800, "tool descriptions are paid on every request; explain it in SIKEMUX_GUIDE.md instead")
        for tool in tools:
            self.assertLessEqual(len(tool.description or ""), 160, f"{tool.name} description belongs in the guide")

    def test_a_screenshot_comes_back_as_an_image(self):
        content = content_for("browser_screenshot", {"data": "aGk=", "mimeType": "image/png", "title": "Example", "url": "https://example.com"})
        self.assertEqual(content[0].type, "image")
        self.assertEqual(content[0].data, "aGk=")
        self.assertEqual(content[1].text, "Example https://example.com")

    def test_an_app_error_reaches_the_agent_as_a_tool_error(self):
        with FakeSikemux(lambda request: {"status": "error", "message": "no browser tab is open"}):
            server = build_server("agent-one")
            result = run_tool(server, "browser_click", {"index": 3})
            self.assertTrue(result.isError)
            self.assertIn("no browser tab is open", result.content[0].text)

    def test_unknown_tools_and_bad_agent_ids_are_refused(self):
        with self.assertRaises(SystemExit):
            build_server("../escape")
        server = build_server("agent-one")
        result = run_tool(server, "browser_evil", {})
        self.assertTrue(result.isError)


if __name__ == "__main__":
    unittest.main()
