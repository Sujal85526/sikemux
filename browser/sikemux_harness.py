import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import uuid

import mcp.types as types


METHODS = {
    "sikemux_workspace_inspect": ("workspace.inspect", "Inspect this agent's open project, panes, configured tasks, runs, and event cursor.", {}, []),
    "sikemux_task_start": ("task.start", "Start a configured project task in a managed terminal.", {"taskId": {"type": "string"}, "idempotencyKey": {"type": "string", "maxLength": 128}}, ["taskId", "idempotencyKey"]),
    "sikemux_task_read": ("task.read", "Read task status and new terminal output by byte cursor.", {"executionId": {"type": "string"}, "cursor": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 4, "maximum": 8192}}, ["executionId"]),
    "sikemux_task_stop": ("task.stop", "Stop the exact managed task execution and its process tree.", {"executionId": {"type": "string"}}, ["executionId"]),
    "sikemux_ui_open": ("ui.open", "Open a project file, diff, task terminal, or the configured preview.", {"kind": {"enum": ["file", "diff", "terminal", "preview"]}, "path": {"type": "string"}, "line": {"type": "integer", "minimum": 1}, "executionId": {"type": "string"}, "focus": {"type": "boolean"}}, ["kind"]),
    "sikemux_events_wait": ("events.wait", "Wait for project task or UI events after an event cursor.", {"cursor": {"type": "string"}, "timeoutMs": {"type": "integer", "minimum": 0, "maximum": 30000}, "executionId": {"type": "string"}}, ["cursor"]),
}

GUIDE_TOOL_NAME = "sikemux_guide"
GUIDE_FILE_NAME = "SIKEMUX_GUIDE.md"
GUIDE_SUMMARY = "Read this before your first task launch or browser click: cursors, idempotency, UI opens, and the tab model."
SERVER_INSTRUCTIONS = f"Sikemux drives the person's open project and this agent's browser tabs. Call {GUIDE_TOOL_NAME} before the first task launch or browser click."


def guide_path() -> Path:
    """PyInstaller unpacks bundled files under a temporary root it names in sys._MEIPASS."""
    root = getattr(sys, "_MEIPASS", None) or Path(__file__).parent
    return Path(root) / GUIDE_FILE_NAME


def guide_text() -> str:
    return guide_path().read_text(encoding="utf-8")


def guide_tool() -> types.Tool:
    return types.Tool(name=GUIDE_TOOL_NAME, description=GUIDE_SUMMARY, inputSchema={"type": "object", "properties": {}, "required": [], "additionalProperties": False})


def tool_definitions(methods=METHODS):
    return [types.Tool(name=name, description=description, inputSchema={"type": "object", "properties": properties, "required": required, "additionalProperties": False}) for name, (_, description, properties, required) in methods.items()]


def call_harness_method(method, arguments):
    endpoint_path = os.environ.get("SIKEMUX_CLI_ENDPOINT")
    if not endpoint_path:
        raise RuntimeError("Missing SIKEMUX_CLI_ENDPOINT; launch this MCP from Sikemux")
    endpoint = json.loads(Path(endpoint_path).read_text())
    request = {"command": "harness", "protocol": endpoint["protocol"], "token": endpoint["token"], "request": {
        "id": str(uuid.uuid4()), "project": os.environ.get("SIKEMUX_PROJECT") or str(Path.cwd()),
        "agentId": os.environ.get("SIKEMUX_BROWSER_AGENT_ID") or os.environ.get("SIKEMUX_AGENT_ID"),
        "method": method, "params": arguments,
    }}
    frame = json.dumps(request).encode() + b"\n"
    if len(frame) > 65536:
        raise ValueError("Harness request exceeds 64 KiB")
    with socket.create_connection(("127.0.0.1", endpoint["port"]), timeout=5) as connection:
        connection.settimeout(70)
        connection.sendall(frame)
        with connection.makefile("rb") as reader:
            response = reader.readline(4 * 1024 * 1024 + 1)
    if len(response) > 4 * 1024 * 1024 or not response.endswith(b"\n"):
        raise RuntimeError("Invalid or oversized harness response")
    result = json.loads(response)
    if result.get("status") == "error":
        raise RuntimeError(result.get("message", "Harness request failed"))
    if result.get("status") != "result":
        raise RuntimeError("Unexpected harness response")
    return result["value"]


def call_harness(name, arguments):
    return json.dumps(call_harness_method(METHODS[name][0], arguments), ensure_ascii=False)


async def execute(name, arguments):
    return await asyncio.to_thread(call_harness, name, arguments)
