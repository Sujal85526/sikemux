import argparse
import asyncio
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class SmokePage(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<html><head><title>Sikemux Browser Smoke</title></head><body><button>ready</button></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def wait_for_cdp(path: Path) -> str:
    for _ in range(200):
        try:
            port = path.read_text().splitlines()[0]
            return f"http://127.0.0.1:{port}"
        except (OSError, IndexError):
            time.sleep(0.1)
    raise RuntimeError("Chromium did not expose a CDP endpoint")


async def exercise_sidecar(sidecar: Path, cdp_url: str, state_dir: Path, page_url: str) -> None:
    environment = {
        **os.environ,
        "SIKEMUX_BROWSER_AGENT_ID": "smoke-agent",
        "SIKEMUX_BROWSER_STATE_DIR": str(state_dir),
        "SIKEMUX_BROWSER_CDP_URL": cdp_url,
    }
    parameters = StdioServerParameters(command=str(sidecar), env=environment)
    async with stdio_client(parameters, errlog=sys.stderr) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = {tool.name for tool in (await session.list_tools()).tools}
            required = {"browser_navigate", "browser_get_state", "browser_list_tabs"}
            if not required <= tools:
                raise RuntimeError(f"frozen sidecar is missing tools: {sorted(required - tools)}")
            if "browser_extract_content" in tools:
                raise RuntimeError("frozen sidecar exposes browser_extract_content without an extraction LLM")

            navigate = await session.call_tool("browser_navigate", {"url": page_url})
            if navigate.isError:
                raise RuntimeError(f"browser_navigate failed: {navigate.content}")
            text = ""
            for _ in range(50):
                state = await session.call_tool("browser_get_state", {})
                text = "\n".join(getattr(block, "text", "") for block in state.content)
                if page_url in text and '"text": "ready"' in text:
                    break
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError(f"browser state did not contain the smoke page: {text[:500]}")
            tabs = await session.call_tool("browser_list_tabs", {})
            tab_text = "\n".join(getattr(block, "text", "") for block in tabs.content)
            if page_url not in tab_text:
                raise RuntimeError("owned tab list did not contain the smoke page")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--browser", type=Path, required=True)
    args = parser.parse_args()
    if not args.sidecar.is_file() or not args.browser.is_file():
        raise SystemExit("sidecar or browser executable is missing")

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        profile = root / "profile"
        state = root / "state"
        profile.mkdir()
        state.mkdir()
        server = ThreadingHTTPServer(("127.0.0.1", 0), SmokePage)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        browser = subprocess.Popen(
            [
                str(args.browser),
                "--headless=new",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                f"--user-data-dir={profile}",
                "about:blank",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            cdp_url = wait_for_cdp(profile / "DevToolsActivePort")
            page_url = f"http://127.0.0.1:{server.server_port}/"
            asyncio.run(exercise_sidecar(args.sidecar, cdp_url, state, page_url))
        finally:
            browser.terminate()
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    print("Browser sidecar smoke test passed")


if __name__ == "__main__":
    main()
