"""The agent tool surface. Every tool is declared once in tools.json; this module
serves those declarations over MCP and relays each call to Sikemux over the
harness socket. scripts/generate-agent-tools.mjs reads the same file to emit the
native method lists, so the two sides cannot drift apart."""

import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import uuid

import mcp.types as types


MANIFEST_FILE_NAME = "tools.json"
GUIDE_TOOL_NAME = "sikemux_guide"
GUIDE_SUMMARY = "Read this before your first task launch or browser click: cursors, idempotency, UI opens, and the tab model."
SERVER_INSTRUCTIONS = f"Sikemux drives the person's open project and this agent's browser tabs. Call {GUIDE_TOOL_NAME} before the first task launch or browser click."


def bundled_path(name: str) -> Path:
    """PyInstaller unpacks bundled files under a temporary root it names in sys._MEIPASS."""
    root = getattr(sys, "_MEIPASS", None) or Path(__file__).parent
    return Path(root) / name


MANIFEST = json.loads(bundled_path(MANIFEST_FILE_NAME).read_text(encoding="utf-8"))
TOOLS = MANIFEST["tools"]
GUIDE_FILE_NAME = MANIFEST["guide"]
METHOD_BY_NAME = {tool["name"]: tool["method"] for tool in TOOLS}


def guide_text() -> str:
    return bundled_path(GUIDE_FILE_NAME).read_text(encoding="utf-8")


def guide_tool() -> types.Tool:
    return types.Tool(name=GUIDE_TOOL_NAME, description=GUIDE_SUMMARY, inputSchema={"type": "object", "properties": {}, "required": [], "additionalProperties": False})


def tool_definitions(tools=None):
    return [
        types.Tool(
            name=tool["name"],
            description=tool["description"],
            inputSchema={"type": "object", "properties": tool["properties"], "required": tool["required"], "additionalProperties": False},
        )
        for tool in (TOOLS if tools is None else tools)
    ]


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
    return json.dumps(call_harness_method(METHOD_BY_NAME[name], arguments), ensure_ascii=False)


async def execute(name, arguments):
    return await asyncio.to_thread(call_harness, name, arguments)
