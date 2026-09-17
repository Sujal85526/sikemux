"""Frozen-binary smoke test: the sidecar must start, list its tools, and relay a
browser call to a stand-in for the app over the harness socket."""

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

STATE = {"url": "https://example.com", "title": "Sikemux Browser Smoke", "elements": "[0] <button> ready", "text": "ready", "tabs": []}


def serve_once(listener: socket.socket, seen: list) -> None:
    connection, _ = listener.accept()
    with connection, connection.makefile("rb") as stream:
        seen.append(json.loads(stream.readline()))
        connection.sendall(json.dumps({"status": "result", "value": STATE}).encode() + b"\n")


def run_agent_smoke(command: list[str], environment: dict[str, str], label: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"{label} browser smoke failed: {(result.stderr or result.stdout).strip()[:1000]}")
    return result


def exercise_agent_hosts(args, environment: dict[str, str]) -> None:
    if args.pi and args.pi_extension:
        result = run_agent_smoke(
            [str(args.pi), "--extension", str(args.pi_extension), "--list-models", "sikemux-no-model-match"],
            {**environment, "SIKEMUX_BROWSER_MCP_COMMAND": str(args.sidecar), "SIKEMUX_BROWSER_MCP_ARGS": "[]"},
            "Pi",
        )
        if "sikemux-browser" in result.stderr:
            raise RuntimeError(f"Pi extension reported a browser error: {result.stderr.strip()[:500]}")


async def exercise_sidecar(sidecar: Path, environment: dict[str, str]) -> None:
    async with stdio_client(StdioServerParameters(command=str(sidecar), args=[], env=environment)) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            names = {tool.name for tool in (await session.list_tools()).tools}
            for expected in ("browser_navigate", "browser_state", "browser_click", "browser_screenshot", "sikemux_workspace_inspect", "sikemux_guide"):
                if expected not in names:
                    raise RuntimeError(f"sidecar does not expose {expected}")
            guide = await session.call_tool("sikemux_guide", {})
            if guide.isError or "Working inside Sikemux" not in guide.content[0].text:
                raise RuntimeError(f"the frozen sidecar does not carry its guide: {guide.content}")
            result = await session.call_tool("browser_navigate", {"url": "https://example.com"})
            if result.isError or json.loads(result.content[0].text) != STATE:
                raise RuntimeError(f"sidecar relayed the wrong answer: {result.content}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--pi", type=Path)
    parser.add_argument("--pi-extension", type=Path)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as directory, socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        listener.settimeout(30)
        endpoint = Path(directory) / "endpoint.json"
        endpoint.write_text(json.dumps({"protocol": 1, "token": "smoke-token", "port": listener.getsockname()[1]}))
        seen: list = []
        thread = threading.Thread(target=serve_once, args=(listener, seen), daemon=True)
        thread.start()
        environment = {
            **os.environ,
            "SIKEMUX_CLI_ENDPOINT": str(endpoint),
            "SIKEMUX_PROJECT": directory,
            "SIKEMUX_BROWSER_AGENT_ID": "agent-smoke",
        }
        asyncio.run(exercise_sidecar(args.sidecar, environment))
        thread.join(timeout=5)
        if not seen or seen[0]["request"]["method"] != "browser.navigate" or seen[0]["request"]["agentId"] != "agent-smoke":
            raise RuntimeError(f"the app did not receive the browser call: {seen}")
        exercise_agent_hosts(args, environment)
    print("✓ browser sidecar smoke passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the build wants one line, not a trace
        print(f"browser sidecar smoke failed: {error}", file=sys.stderr)
        sys.exit(1)
