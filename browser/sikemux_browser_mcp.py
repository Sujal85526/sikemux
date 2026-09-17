"""The agent's browser, as MCP tools. Sikemux itself answers them over the harness
socket and they act on the tabs the person sees in the agent's pane. The one
exception is the guide, which the sidecar serves from the file it ships with.
Every tool is declared in tools.json."""

import asyncio
import json
import os
import re
import sys

import mcp.types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

import sikemux_harness


def tool_definitions():
    return sikemux_harness.tool_definitions() + [sikemux_harness.guide_tool()]


def content_for(name, value):
    if name == "browser_screenshot" and isinstance(value, dict) and isinstance(value.get("data"), str):
        caption = f"{value.get('title') or ''} {value.get('url') or ''}".strip()
        return [
            types.ImageContent(type="image", data=value["data"], mimeType=value.get("mimeType", "image/png")),
            types.TextContent(type="text", text=caption or "screenshot"),
        ]
    return [types.TextContent(type="text", text=json.dumps(value, ensure_ascii=False))]


def build_server(agent_id: str) -> Server:
    if not re.fullmatch(r"[A-Za-z0-9_:-]{1,128}", agent_id):
        raise SystemExit("Invalid SIKEMUX_BROWSER_AGENT_ID")
    server = Server("sikemux-browser", instructions=sikemux_harness.SERVER_INSTRUCTIONS)

    @server.list_tools()
    async def list_tools():
        return tool_definitions()

    @server.call_tool()
    async def call_tool(name: str, arguments: dict | None):
        arguments = arguments or {}
        if name == sikemux_harness.GUIDE_TOOL_NAME:
            return [types.TextContent(type="text", text=sikemux_harness.guide_text())]
        method = sikemux_harness.METHOD_BY_NAME.get(name)
        if method is None:
            raise ValueError(f"Unknown tool: {name}")
        value = await asyncio.to_thread(sikemux_harness.call_harness_method, method, arguments)
        return content_for(name, value)

    return server


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing {name}; launch this MCP through Sikemux")
    return value


async def main() -> None:
    server = build_server(required_env("SIKEMUX_BROWSER_AGENT_ID"))
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
