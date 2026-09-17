"""The agent's browser, as MCP tools. Sikemux itself answers them over the harness
socket and they act on the tabs the person sees in the agent's pane. The one
exception is the guide, which the sidecar serves from the file it ships with."""

import asyncio
import base64
import os
import re
import sys

import mcp.types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

import sikemux_harness

STATE_NOTE = "Returns page state."

BROWSER_METHODS = {
    "browser_navigate": ("browser.navigate", f"Open a URL in the current tab, or a new one with newTab, and wait for it to load. {STATE_NOTE}", {"url": {"type": "string", "maxLength": 8192}, "newTab": {"type": "boolean"}}, ["url"]),
    "browser_state": ("browser.state", "Read the current tab without changing it: url, title, numbered interactive elements, visible text, and open tabs. Numbers expire on the next read.", {}, []),
    "browser_click": ("browser.click", f"Click a numbered element from the latest state. {STATE_NOTE}", {"index": {"type": "integer", "minimum": 0}}, ["index"]),
    "browser_type": ("browser.type", f"Type into a numbered element, or the focused one, replacing its value. submit=true presses Enter. {STATE_NOTE}", {"index": {"type": "integer", "minimum": 0}, "text": {"type": "string", "maxLength": 20000}, "submit": {"type": "boolean"}}, ["text"]),
    "browser_press": ("browser.press", f"Press one key on the focused element, such as Enter, Tab, Escape, or a single character. {STATE_NOTE}", {"key": {"type": "string", "minLength": 1, "maxLength": 24}}, ["key"]),
    "browser_scroll": ("browser.scroll", "Scroll the page, or a numbered scrollable element, by deltaY pixels; negative scrolls up.", {"deltaY": {"type": "number"}, "index": {"type": "integer", "minimum": 0}}, []),
    "browser_extract": ("browser.extract", "Read the page's visible text, or only the parts matching a CSS selector.", {"selector": {"type": "string", "maxLength": 512}}, []),
    "browser_screenshot": ("browser.screenshot", "Capture the visible part of the current tab as a PNG image.", {}, []),
    "browser_wait": ("browser.wait", f"Wait ms milliseconds, then for any load to finish. {STATE_NOTE}", {"ms": {"type": "integer", "minimum": 0, "maximum": 30000}}, []),
    "browser_back": ("browser.back", f"Go back in the current tab's history. {STATE_NOTE}", {}, []),
    "browser_forward": ("browser.forward", f"Go forward in the current tab's history. {STATE_NOTE}", {}, []),
    "browser_list_tabs": ("browser.tabs", "List this agent's browser tabs with their ids.", {}, []),
    "browser_switch_tab": ("browser.tab.switch", f"Make one of this agent's tabs the current one. {STATE_NOTE}", {"tabId": {"type": "string", "maxLength": 128}}, ["tabId"]),
    "browser_close_tab": ("browser.tab.close", "Close one of this agent's tabs.", {"tabId": {"type": "string", "maxLength": 128}}, ["tabId"]),
}


def tool_definitions():
    return sikemux_harness.tool_definitions(BROWSER_METHODS) + sikemux_harness.tool_definitions() + [sikemux_harness.guide_tool()]


def content_for(name, value):
    if name == "browser_screenshot" and isinstance(value, dict) and isinstance(value.get("data"), str):
        caption = f"{value.get('title') or ''} {value.get('url') or ''}".strip()
        return [
            types.ImageContent(type="image", data=value["data"], mimeType=value.get("mimeType", "image/png")),
            types.TextContent(type="text", text=caption or "screenshot"),
        ]
    return [types.TextContent(type="text", text=sikemux_harness.json.dumps(value, ensure_ascii=False))]


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
        if name in BROWSER_METHODS:
            method = BROWSER_METHODS[name][0]
        elif name in sikemux_harness.METHODS:
            method = sikemux_harness.METHODS[name][0]
        else:
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
