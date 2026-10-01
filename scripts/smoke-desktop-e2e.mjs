#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const appExecutable = resolve(
  process.env.SIKEMUX_E2E_APP ??
    join(
      root,
      "src-tauri",
      "target",
      "e2e",
      "debug",
      `sikemux${executableSuffix}`,
    ),
);
const cliExecutable = resolve(
  process.env.SIKEMUX_E2E_CLI ??
    join(
      root,
      "src-tauri",
      "target",
      "release",
      `sikemux-editor${executableSuffix}`,
    ),
);

const exerciseHarnessTasks = process.argv.includes("--tasks");
const exerciseBrowser = process.argv.includes("--browser");

const BROWSER_AGENT_ID = "e2e-browser";
const FIXTURE_TITLE = "Sikemux browser smoke";
const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${FIXTURE_TITLE}</title>
  </head>
  <body>
    <h1>Browser smoke</h1>
    <button id="count" type="button">Count</button>
    <p id="clicks">clicks: 0</p>
    <button id="reveal" type="button">Reveal the secret</button>
    <p id="secret" hidden>Revealed</p>
    <label>Name <input id="name" type="text" /></label>
    <p id="echo"></p>
    <button id="later" type="button">Load later</button>
    <script>
      document.getElementById("later").addEventListener("click", () => {
        setTimeout(() => {
          const note = document.createElement("p");
          note.textContent = "Loaded late";
          document.body.append(note);
        }, 800);
      });
      let clicks = 0;
      document.getElementById("count").addEventListener("click", () => {
        document.getElementById("clicks").textContent = "clicks: " + ++clicks;
      });
      document.getElementById("reveal").addEventListener("click", () => {
        document.getElementById("secret").hidden = false;
      });
      document.getElementById("name").addEventListener("input", (event) => {
        document.getElementById("echo").textContent = event.target.value;
      });
    </script>
  </body>
</html>
`;

const READY_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 70_000;
const PERSIST_TIMEOUT_MS = 10_000;
const MAX_LOG_BYTES = 64 * 1024;

function fail(message, appLog = "") {
  const suffix = appLog.trim() ? `\n\nDesktop output:\n${appLog.trim()}` : "";
  throw new Error(`desktop E2E smoke failed: ${message}${suffix}`);
}

function run(executable, args, env, timeout, argv0) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    ...(argv0 ? { argv0 } : {}),
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function boundedAppend(current, chunk) {
  const combined = `${current}${String(chunk)}`;
  return combined.length <= MAX_LOG_BYTES
    ? combined
    : combined.slice(combined.length - MAX_LOG_BYTES);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(description, timeout, predicate) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await delay(100);
  }
  fail(`${description} did not complete within ${timeout} ms`);
}

async function executableExists(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) fail(`${label} is missing: ${path}`);
}

async function latestStateWriteTime() {
  const candidates = [
    stateDatabase,
    `${stateDatabase}-wal`,
    `${stateDatabase}-shm`,
  ];
  const details = await Promise.all(
    candidates.map((path) => stat(path).catch(() => null)),
  );
  return details.reduce(
    (latest, candidate) => Math.max(latest, candidate?.mtimeMs ?? 0),
    0,
  );
}

async function stopExactChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

const CORE_FRAME = { control: 0, output: 1, snapshot: 2, input: 3 };

function coreFrame(kind, payload) {
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length + 1, 0);
  frame[4] = kind;
  payload.copy(frame, 5);
  return frame;
}

function coreControl(message) {
  return coreFrame(CORE_FRAME.control, Buffer.from(JSON.stringify(message)));
}

// A minimal client of the terminal core's socket protocol, enough to see
// that the app started its own core and that its terminals run there.
function openCore(path) {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = connect(path);
    let buffered = Buffer.alloc(0);
    const frames = [];
    let wake = () => {};
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.length < 4 + length) break;
        frames.push({
          kind: buffered[4],
          payload: buffered.subarray(5, 4 + length),
        });
        buffered = buffered.subarray(4 + length);
      }
      wake();
    });
    socket.once("error", rejectOpen);
    const next = async (accept, timeout = 5_000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const index = frames.findIndex(accept);
        if (index >= 0) return frames.splice(index, 1)[0];
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise((resolveWake) => {
          wake = resolveWake;
          setTimeout(resolveWake, left);
        });
      }
    };
    const control = (frame) =>
      frame.kind === CORE_FRAME.control ? JSON.parse(frame.payload) : null;
    socket.once("connect", async () => {
      socket.write(
        coreControl({ type: "hello", protocol: "sikemux-core", version: 3 }),
      );
      const hello = await next((frame) => control(frame)?.type === "helloAck");
      if (!hello) {
        socket.destroy();
        rejectOpen(new Error("the core did not answer its hello"));
        return;
      }
      let requestId = 0;
      const request = async (body, timeout) => {
        const id = ++requestId;
        socket.write(
          coreControl({ type: "request", requestId: id, request: body }),
        );
        const reply = await next(
          (frame) => control(frame)?.requestId === id,
          timeout,
        );
        return reply && control(reply);
      };
      resolveOpen({
        hello: control(hello),
        request,
        async attach(id) {
          const attachId = ++requestId;
          socket.write(
            coreControl({
              type: "request",
              requestId: attachId,
              request: { op: "attach", id },
            }),
          );
          const reply = await next(
            (frame) =>
              (frame.kind === CORE_FRAME.snapshot &&
                frame.payload.readBigUInt64BE(0) === BigInt(attachId)) ||
              control(frame)?.requestId === attachId,
          );
          return reply?.kind === CORE_FRAME.snapshot;
        },
        async attachReplay(id) {
          const attachId = ++requestId;
          socket.write(
            coreControl({
              type: "request",
              requestId: attachId,
              request: { op: "attach", id },
            }),
          );
          const reply = await next(
            (frame) =>
              frame.kind === CORE_FRAME.snapshot &&
              frame.payload.readBigUInt64BE(0) === BigInt(attachId),
          );
          if (!reply) return "";
          const headerLength = reply.payload.readUInt32BE(16);
          return reply.payload.subarray(20 + headerLength).toString("utf8");
        },
        write(id, text) {
          const header = Buffer.alloc(16);
          header.writeBigUInt64BE(BigInt(++requestId), 0);
          header.writeBigUInt64BE(BigInt(id), 8);
          socket.write(
            coreFrame(
              CORE_FRAME.input,
              Buffer.concat([header, Buffer.from(text)]),
            ),
          );
        },
        async output(id, needle, timeout) {
          let seen = "";
          const deadline = Date.now() + timeout;
          while (!seen.includes(needle) && Date.now() < deadline) {
            const frame = await next(
              (candidate) =>
                candidate.kind === CORE_FRAME.output ||
                candidate.kind === CORE_FRAME.snapshot,
              deadline - Date.now(),
            );
            if (!frame) break;
            if (
              frame.kind === CORE_FRAME.output &&
              frame.payload.readBigUInt64BE(0) === BigInt(id)
            )
              seen += frame.payload.subarray(8).toString("utf8");
          }
          return seen.includes(needle);
        },
        close: () => socket.destroy(),
      });
    });
  });
}

async function stopCore(path) {
  const core = await openCore(path).catch(() => null);
  if (!core) return;
  await core.request({ op: "shutdown", stopAll: true }, 5_000);
  core.close();
}

function serveFixture() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(FIXTURE_PAGE);
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function numberOf(elements, label) {
  const line = elements
    .split("\n")
    .find((candidate) => candidate.endsWith(` ${label}`));
  const index = Number(/^\[(\d+)\]/u.exec(line ?? "")?.[1]);
  if (!Number.isInteger(index))
    fail(`no numbered element "${label}" in:\n${elements}`, desktopLog);
  return index;
}

// The fixture server lives in this process, so a CLI call must not block its event loop.
function runWhileServing(executable, args, env, timeout) {
  return new Promise((resolveRun) => {
    const child = spawn(executable, args, { cwd: root, env, timeout });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolveRun({ error, stdout, stderr }));
    child.on("close", (status, signal) =>
      resolveRun({ status, signal, stdout, stderr }),
    );
  });
}

// Each step is its own CLI process, so element numbers must survive between calls.
async function exerciseBrowserTools(harnessEnv) {
  const env = { ...harnessEnv, SIKEMUX_AGENT_ID: BROWSER_AGENT_ID };
  const tool = async (method, params = {}) => {
    const result = await runWhileServing(
      cliExecutable,
      ["tool", method, JSON.stringify(params)],
      env,
      70_000,
    );
    if (result.error) fail(`${method}: ${result.error.message}`, desktopLog);
    if (result.status !== 0) fail(`${method}: ${result.stderr}`, desktopLog);
    return JSON.parse(result.stdout);
  };
  const evaluate = async (script) =>
    (await tool("browser.evaluate", { script })).result;

  const server = await serveFixture();
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const opened = await tool("browser.navigate", { url });
    if (opened.url !== url || opened.title !== FIXTURE_TITLE)
      fail(`navigate landed on ${opened.url} "${opened.title}"`, desktopLog);

    const { elements } = await tool("browser.state");
    const counted = await tool("browser.click", {
      index: numberOf(elements, "Count"),
    });
    if (counted.label !== "Count")
      fail(`click by index hit "${counted.label}"`, desktopLog);
    const clicks = await evaluate(
      "document.getElementById('clicks').textContent",
    );
    if (clicks !== "clicks: 1")
      fail(`click by index did not reach the page: ${clicks}`, desktopLog);

    const found = await tool("browser.find", { query: "Reveal the secret" });
    const reveal = numberOf(found.elements, "Reveal the secret");
    await tool("browser.click", { text: "Reveal the secret" });
    if ((await evaluate("document.getElementById('secret').hidden")) !== false)
      fail("click by text did not reach the page", desktopLog);
    const again = await tool("browser.click", {
      index: reveal,
      expectLabel: "Reveal the secret",
    });
    if (again.label !== "Reveal the secret")
      fail(`click by a found number hit "${again.label}"`, desktopLog);

    const typed = await tool("browser.type", {
      index: numberOf(elements, "Name"),
      text: "Ada Lovelace",
    });
    if (typed.value !== "Ada Lovelace")
      fail(`type returned ${JSON.stringify(typed.value)}`, desktopLog);
    const echoed = await evaluate(
      "document.getElementById('echo').textContent",
    );
    if (echoed !== "Ada Lovelace")
      fail(`typing did not fire input events: ${echoed}`, desktopLog);

    const shot = await tool("browser.screenshot");
    const image = Buffer.from(shot.data ?? "", "base64");
    if (
      shot.mimeType !== "image/jpeg" ||
      image.length < 1024 ||
      image[0] !== 0xff ||
      image[1] !== 0xd8
    )
      fail(`screenshot is not a JPEG (${image.length} bytes)`, desktopLog);

    const title = await evaluate("document.title");
    if (title !== FIXTURE_TITLE) fail(`evaluate returned ${title}`, desktopLog);

    await tool("browser.click", { selector: "#later" });
    const waited = await tool("browser.wait", {
      text: "Loaded late",
      timeoutMs: 5000,
    });
    if (!waited.met || waited.waitedMs < 100)
      fail(`wait for text returned ${JSON.stringify(waited)}`, desktopLog);
    const missing = await tool("browser.wait", {
      selector: "#never",
      timeoutMs: 400,
    });
    if (missing.met || !missing.failing?.length)
      fail(
        `a wait that cannot be met said ${JSON.stringify(missing)}`,
        desktopLog,
      );

    const box = await evaluate(
      "(() => { const r = document.getElementById('count').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
    );
    const pointed = await tool("browser.click", { x: box.x, y: box.y });
    if (pointed.hit?.label !== "Count")
      fail(`a click by x,y hit ${JSON.stringify(pointed.hit)}`, desktopLog);

    const reloaded = await tool("browser.navigate", {
      go: "reload",
      waitFor: { selector: "#count" },
    });
    if (!reloaded.met) fail("reload did not wait for the page", desktopLog);
    if (
      (await evaluate("document.getElementById('clicks').textContent")) !==
      "clicks: 0"
    )
      fail("reload kept the old page", desktopLog);

    const selected = await tool("browser.press", { key: "Meta+a" });
    if (!selected) fail("Meta+a returned nothing", desktopLog);
    const replaced = await tool("browser.type", {
      selector: "#name",
      text: "Grace Hopper",
    });
    if (replaced.value !== "Grace Hopper" || replaced.warning)
      fail(
        `typing over a field returned ${JSON.stringify(replaced)}`,
        desktopLog,
      );

    const part = await tool("browser.screenshot", { selector: "#count" });
    const partImage = Buffer.from(part.data ?? "", "base64");
    if (
      part.element?.label !== "Count" ||
      partImage.length < 200 ||
      partImage.length >= image.length
    )
      fail(
        `an element screenshot came back as ${partImage.length} bytes for ${JSON.stringify(part.element)}`,
        desktopLog,
      );

    const wide = await tool("browser.viewport", { preset: "desktop" });
    if (wide.viewport?.width !== 1280 || wide.viewport?.height !== 800)
      fail(
        `the desktop preset laid out at ${JSON.stringify(wide.viewport)}`,
        desktopLog,
      );
    if ((await evaluate("innerWidth")) !== 1280)
      fail("the page does not see the desktop width", desktopLog);
    if (typeof wide.visible !== "boolean")
      fail("state has no visible flag", desktopLog);
    await tool("browser.viewport", { preset: "fit" });

    const localFolder = await mkdtemp(join(tmpdir(), "sikemux-local-page-"));
    try {
      const localPage = join(localFolder, "page.html");
      await writeFile(
        localPage,
        "<!doctype html><title>Local smoke</title><p>From disk</p>",
        "utf8",
      );
      const local = await tool("browser.navigate", { url: localPage });
      if (
        local.title !== "Local smoke" ||
        !local.url.startsWith("http://127.0.0.1:")
      )
        fail(
          `a local file opened as ${local.url} "${local.title}"`,
          desktopLog,
        );
    } finally {
      await rm(localFolder, { recursive: true, force: true });
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
  console.log(
    "✓ Browser harness E2E passed: navigate, state, click by number across calls, find, click by text, type, screenshot, evaluate, wait on conditions, click by point, reload, Meta+a and replace, element screenshot, desktop viewport, local file",
  );
}

// Clicks an item in the app's own menu through Accessibility, addressed by
// the process id, so no other app can receive it. False when this machine
// does not let scripts drive menus.
function clickAppMenuItem(pid, title) {
  if (process.platform !== "darwin") return false;
  const script = [
    'tell application "System Events"',
    `  tell (first process whose unix id is ${pid})`,
    `    click (first menu item of menu 1 of menu bar item 2 of menu bar 1 whose name starts with "${title}")`,
    "  end tell",
    "end tell",
  ].join("\n");
  const clicked = run("osascript", ["-e", script], process.env, 10_000);
  if (clicked.status !== 0)
    console.warn(
      `! osascript could not click "${title}": ${(clicked.stderr || clicked.error?.message || "").trim()}`,
    );
  return clicked.status === 0;
}

async function exitOf(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(timeout).then(() => false),
  ]);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stateMentions(text) {
  const contents = await Promise.all(
    [stateDatabase, `${stateDatabase}-wal`].map((path) =>
      readFile(path).catch(() => Buffer.alloc(0)),
    ),
  );
  return contents.some((bytes) => bytes.includes(text));
}

async function coreSession(core, id) {
  const listed = await core.request({ op: "list" }, 5_000);
  return (listed?.response?.sessions ?? []).find(
    (session) => session.id === id,
  );
}

// The same request ⌘Q makes: AppKit asks the app to terminate, so Tauri
// runs its exit hooks.
async function quitDesktop() {
  const quit = run(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${desktop.pid}).terminate`,
    ],
    process.env,
    10_000,
  );
  if (quit.status !== 0) fail(`could not ask the app to quit: ${quit.stderr}`);
  if (!(await exitOf(desktop, 15_000)))
    fail("the app did not quit", desktopLog);
}

// Agents keep reading, stopping and waiting on a task while the window is
// closed: the core answers those calls itself. Calls that need the window say
// so. A command task needs no trust prompt, so this runs unattended.
async function exerciseHarnessWithWindowClosed(harnessEnv) {
  const tool = (method, params = {}) =>
    run(
      cliExecutable,
      ["tool", method, JSON.stringify(params)],
      harnessEnv,
      70_000,
    );
  const json = (result, what) => {
    if (result.status !== 0)
      fail(`${what}: ${result.stderr || result.stdout}`, desktopLog);
    return JSON.parse(result.stdout);
  };
  const started = json(
    tool("task.start", {
      command: `node -e "console.log('harness-' + 6 * 7); setInterval(() => {}, 1000)"`,
      idempotencyKey: "window-closed",
      readyWhen: "harness-42",
      label: "Window closed",
    }),
    "harness command start",
  );
  if (started.status !== "running" || started.ready !== true)
    fail(`the harness command did not start: ${JSON.stringify(started)}`);
  const { cursor } = json(tool("workspace.inspect"), "harness inspect");

  await quitDesktop();
  const status = run(cliExecutable, ["status"], isolatedEnvironment, 2_000);
  if (!/its window is closed/u.test(status.stdout))
    fail(`status did not say the window is closed: ${status.stdout}`);
  const read = json(
    tool("task.read", { executionId: started.executionId, plain: true }),
    "task.read with the window closed",
  );
  if (!read.output.includes("harness-42"))
    fail(`task.read lost the output: ${JSON.stringify(read)}`);
  const stopped = json(
    tool("task.stop", { taskId: started.taskId }),
    "task.stop with the window closed",
  );
  if (stopped.status !== "stopped") fail("the task did not stop");
  const events = json(
    tool("events.wait", {
      cursor,
      timeoutMs: 0,
      executionId: started.executionId,
    }),
    "events.wait with the window closed",
  );
  if (!events.events.some((event) => event.kind === "task.stopped"))
    fail(`events.wait missed the stop: ${JSON.stringify(events)}`);
  const inspected = json(
    tool("workspace.inspect"),
    "workspace.inspect with the window closed",
  );
  if (
    inspected.window !== null ||
    !inspected.note ||
    !inspected.runs.some((run) => run.executionId === started.executionId)
  )
    fail(`inspect with the window closed: ${JSON.stringify(inspected)}`);

  desktop = launchDesktop();
  await waitForBroker(desktop);
  const resumed = json(
    tool("events.wait", { cursor, timeoutMs: 0 }),
    "events.wait after relaunch",
  );
  if (!resumed.events.some((event) => event.kind === "task.stopped"))
    fail("an event cursor did not survive the relaunch");
  console.log(
    "Harness with the window closed passed: task.read, task.stop, events.wait and inspect answered by the core, cursor kept across relaunch",
  );
}

// Quit leaves a terminal running in the core and the next launch shows it in
// the same pane. Runs while that pane is the one on screen.
async function exerciseQuitKeepsTerminals() {
  const core = await openCore(coreSocket).catch((error) =>
    fail(
      `the app did not start its terminal core: ${error.message}`,
      desktopLog,
    ),
  );
  let shell;
  await waitFor("a terminal pane in the core", PERSIST_TIMEOUT_MS, async () => {
    const listed = await core.request({ op: "list" }, 5_000);
    shell = (listed?.response?.sessions ?? []).find(
      (session) =>
        session.kind === "terminal" && session.running && session.paneId,
    );
    return Boolean(shell);
  });
  if (!(await core.attach(shell.id)))
    fail("could not attach to the project terminal", desktopLog);
  core.write(shell.id, "echo kept-$((5*9))\r");
  if (!(await core.output(shell.id, "kept-45", 10_000)))
    fail("the project terminal did not print before quitting", desktopLog);
  core.close();
  await waitFor(
    "the pane's terminal saved in the layout",
    PERSIST_TIMEOUT_MS,
    () => stateMentions(`"ptyId":${shell.id}`),
  );

  await quitDesktop();

  const afterQuit = await openCore(coreSocket).catch(() =>
    fail("the core went away when the app quit", desktopLog),
  );
  const kept = await coreSession(afterQuit, shell.id);
  if (!kept?.running || kept.pid !== shell.pid || !processAlive(shell.pid))
    fail("the terminal did not keep running after Quit", desktopLog);
  afterQuit.close();

  desktop = launchDesktop();
  await waitForBroker(desktop);
  const watcher = await openCore(coreSocket);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const session = await coreSession(watcher, shell.id);
    if (session?.running && session.attached > 0) break;
    if (Date.now() > deadline) {
      const sessions = await watcher.request({ op: "list" }, 5_000);
      fail(
        `the pane did not take its terminal back: ${JSON.stringify(sessions?.response?.sessions)}`,
        desktopLog,
      );
    }
    await delay(100);
  }
  const relisted = await watcher.request({ op: "list" }, 5_000);
  const panes = (relisted?.response?.sessions ?? []).filter(
    (session) => session.kind === "terminal" && session.paneId === shell.paneId,
  );
  if (panes.length !== 1)
    fail(
      `the pane started ${panes.length - 1} new terminal(s) instead of taking its own back`,
      desktopLog,
    );
  const replay = await watcher.attachReplay(shell.id);
  if (!replay.includes("kept-45"))
    fail("the reattached terminal lost its earlier output", desktopLog);
  watcher.close();
  console.log(
    `Quit and relaunch passed: terminal ${shell.id} (pid ${shell.pid}) kept running and its pane took it back with its output`,
  );
  return shell;
}

// Quit and Stop Everything ends what Quit left running, and the core with it.
async function exerciseQuitAndStopEverything(shell) {
  const stopByMenu = clickAppMenuItem(desktop.pid, "Quit and Stop Everything");
  if (!stopByMenu) {
    console.warn(
      "! Could not drive the app menu; stopping the core the way Quit and Stop Everything does",
    );
    await stopCore(coreSocket);
    desktop.kill("SIGTERM");
  }
  if (!(await exitOf(desktop, 15_000)))
    fail("the app did not quit after Quit and Stop Everything", desktopLog);
  await waitFor("the terminal to stop", 10_000, () => !processAlive(shell.pid));
  // The core answers a shutdown before it exits, so give it a moment to go.
  await waitFor("the core to exit", 10_000, async () => {
    const gone = await openCore(coreSocket).catch(() => null);
    gone?.close();
    return !gone;
  });
  console.log(
    `Quit and Stop Everything passed${stopByMenu ? "" : " (by the core, not the menu)"}: terminal ${shell.id} and the core stopped`,
  );
}

await executableExists(appExecutable, "debug desktop executable");
await executableExists(cliExecutable, "release editor CLI");

const temporaryRoot = await mkdtemp(join(tmpdir(), "sikemux-desktop-e2e-"));
const isolatedHome = join(temporaryRoot, "home");
const project = join(temporaryRoot, "project");
const source = join(project, "smoke.ts");
const endpoint = join(temporaryRoot, "cli-endpoint.json");
const coreSocket = join(temporaryRoot, "core.sock");
const stateDatabase = join(
  isolatedHome,
  ".config",
  "sikemux",
  "state.dev.sqlite3",
);
await mkdir(isolatedHome, { recursive: true });
await mkdir(project, { recursive: true });
const initialized = run(
  "git",
  ["init", "--quiet", project],
  process.env,
  5_000,
);
if (initialized.error || initialized.status !== 0) {
  fail(
    `could not initialize the isolated Git project: ${initialized.error?.message ?? initialized.stderr}`,
  );
}
await writeFile(
  source,
  "export const first = 1;\nexport const second = 2;\n",
  "utf8",
);

if (exerciseHarnessTasks) {
  await writeFile(
    join(project, "sikemux.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "server",
          label: "Harness server test",
          command: `node -e "console.log('READY'); setInterval(() => {}, 1000)"`,
          cwd: ".",
          env: {},
        },
        {
          id: "fail",
          label: "Harness failure test",
          command: `node -e "console.log('expected failure'); process.exit(7)"`,
          cwd: ".",
          env: {},
        },
      ],
    }),
  );
}

const isolatedEnvironment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  SIKEMUX_CLI_ENDPOINT: endpoint,
  SIKEMUX_CLI_ENDPOINT_PUBLISH: endpoint,
  SIKEMUX_BIN_PATH: cliExecutable,
  SIKEMUX_CORE_SOCKET: coreSocket,
};
delete isolatedEnvironment.SIKEMUX_APP_EXECUTABLE;

let desktopLog = "";
let desktopSpawnError = "";
function launchDesktop() {
  const child = spawn(appExecutable, [], {
    cwd: project,
    env: isolatedEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => {
    desktopLog = boundedAppend(desktopLog, chunk);
  });
  child.stderr.on("data", (chunk) => {
    desktopLog = boundedAppend(desktopLog, chunk);
  });
  child.on("error", (error) => {
    desktopSpawnError = error.message;
  });
  return child;
}

async function waitForBroker(child) {
  await waitFor(
    "the desktop window behind the CLI endpoint",
    READY_TIMEOUT_MS,
    () => {
      if (desktopSpawnError) fail(desktopSpawnError, desktopLog);
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(
          `desktop exited before becoming ready (${child.exitCode ?? child.signalCode})`,
          desktopLog,
        );
      }
      const status = run(cliExecutable, ["status"], isolatedEnvironment, 2_000);
      return (
        status.status === 0 &&
        /^Sikemux \S+ is running\s*$/u.test(status.stdout)
      );
    },
  );
}

let desktop = launchDesktop();

try {
  await waitForBroker(desktop);

  // The window registers with the core as soon as the app connects to it,
  // before React has necessarily hydrated. Initial persistence is queued only once the WebView is writable,
  // so this is a durable readiness barrier for the renderer-side bridge.
  await waitFor(
    "WebView boot and initial persistence",
    PERSIST_TIMEOUT_MS,
    async () => {
      return (await latestStateWriteTime()) > 0;
    },
  );
  const keptShell = await exerciseQuitKeepsTerminals();
  await waitFor(
    "WebView boot and persistence after relaunch",
    PERSIST_TIMEOUT_MS,
    async () => (await latestStateWriteTime()) > 0,
  );
  const stateWriteBeforeOpen = await latestStateWriteTime();

  // This call returns success only after the core hands the request to the
  // app, the real WebView listener claims it, application state
  // creates/activates an editor pane at the requested location, and the
  // renderer reports the exact target result back through a second Tauri
  // command.
  const opened = run(
    cliExecutable,
    ["open", "--project", project, `${source}:2:3`],
    isolatedEnvironment,
    OPEN_TIMEOUT_MS,
    // The sidecar executable is named `sikemux-editor`, which deliberately
    // defaults to --wait for $EDITOR callers. Exercise ordinary non-waiting
    // `sikemux open` semantics by setting only argv[0], not by renaming or
    // copying the signed sidecar.
    "sikemux",
  );
  if (opened.error) fail(opened.error.message, desktopLog);
  if (opened.signal)
    fail(`editor CLI was terminated by ${opened.signal}`, desktopLog);
  if (opened.status !== 0) {
    fail(
      `editor CLI returned ${opened.status}: ${opened.stderr || opened.stdout}`,
      desktopLog,
    );
  }

  await waitFor(
    "post-open durable state persistence",
    PERSIST_TIMEOUT_MS,
    async () => {
      return (await latestStateWriteTime()) > stateWriteBeforeOpen;
    },
  );

  const core = await openCore(coreSocket).catch((error) =>
    fail(
      `the app did not start its terminal core: ${error.message}`,
      desktopLog,
    ),
  );
  if (!core.hello.build?.commit)
    fail("the terminal core did not report its build", desktopLog);
  let terminals = [];
  await waitFor(
    "a project terminal in the core",
    PERSIST_TIMEOUT_MS,
    async () => {
      const listed = await core.request({ op: "list" }, 5_000);
      terminals = (listed?.response?.sessions ?? []).filter(
        (session) => session.kind === "terminal" && session.running,
      );
      return terminals.length > 0;
    },
  );
  const shell = terminals[0];
  if (!(await core.attach(shell.id)))
    fail("could not attach to the project terminal", desktopLog);
  core.write(shell.id, "echo core-$((6*7))\r");
  if (!(await core.output(shell.id, "core-42", 10_000)))
    fail("the project terminal did not run a command in the core", desktopLog);
  core.close();
  console.log(
    `Terminal core passed: pid ${core.hello.pid}, build ${core.hello.build.commit}, ${terminals.length} terminal(s)`,
  );

  const harnessEnv = { ...isolatedEnvironment, SIKEMUX_PROJECT: project };
  const inspect = run(
    cliExecutable,
    ["tool", "workspace.inspect"],
    harnessEnv,
    10_000,
  );
  if (inspect.status !== 0)
    fail(`harness inspect failed: ${inspect.stderr}`, desktopLog);
  const workspace = JSON.parse(inspect.stdout);
  if (
    workspace.project !== (await realpath(project)) ||
    !workspace.windows.length ||
    !workspace.cursor
  )
    fail("harness returned an incomplete workspace", desktopLog);
  const reveal = run(
    cliExecutable,
    [
      "tool",
      "ui.open",
      JSON.stringify({ kind: "file", path: "smoke.ts", line: 2 }),
    ],
    harnessEnv,
    10_000,
  );
  if (reveal.status !== 0)
    fail(`harness file open failed: ${reveal.stderr}`, desktopLog);
  const events = run(
    cliExecutable,
    [
      "tool",
      "events.wait",
      JSON.stringify({ cursor: workspace.cursor, timeoutMs: 0 }),
    ],
    harnessEnv,
    10_000,
  );
  if (
    events.status !== 0 ||
    !JSON.parse(events.stdout).events.some(
      (event) => event.kind === "ui.opened",
    )
  )
    fail("harness UI event was not delivered", desktopLog);

  await exerciseHarnessWithWindowClosed(harnessEnv);

  if (exerciseHarnessTasks) {
    const tool = (method, params = {}) => {
      const result = run(
        cliExecutable,
        ["tool", method, JSON.stringify(params)],
        harnessEnv,
        70_000,
      );
      if (result.status !== 0) fail(`${method}: ${result.stderr}`, desktopLog);
      return JSON.parse(result.stdout);
    };
    console.log(
      "Waiting for fixture project trust in the isolated Sikemux window...",
    );
    const started = tool("task.start", {
      taskId: "server",
      idempotencyKey: "server-first",
    });
    if (started.status !== "running") fail("server did not start");
    const repeated = tool("task.start", {
      taskId: "server",
      idempotencyKey: "server-first",
    });
    if (started.executionId !== repeated.executionId) fail("duplicate launch");
    let output;
    await waitFor("task output", 5000, () => {
      output = tool("task.read", { executionId: started.executionId });
      return output.output.includes("READY");
    });
    const incremental = tool("task.read", {
      executionId: started.executionId,
      cursor: output.cursor,
    });
    if (incremental.output !== "") fail("output was repeated");
    tool("ui.open", {
      kind: "terminal",
      executionId: started.executionId,
      focus: true,
    });
    const eventCursor = tool("workspace.inspect").cursor;
    const liveWait = new Promise((resolveWait, rejectWait) => {
      const child = spawn(
        cliExecutable,
        [
          "tool",
          "events.wait",
          JSON.stringify({
            cursor: eventCursor,
            timeoutMs: 5000,
            executionId: started.executionId,
          }),
        ],
        { env: harnessEnv, cwd: project },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", rejectWait);
      child.on("exit", (code) => {
        if (code === 0) resolveWait(JSON.parse(output));
        else rejectWait(new Error("event wait failed"));
      });
    });
    const stopped = tool("task.stop", { executionId: started.executionId });
    if (
      !(await liveWait).events.some((event) =>
        ["task.stopping", "task.stopped"].includes(event.kind),
      )
    )
      fail("live event wait missed stop");
    if (stopped.status !== "stopped") fail("task did not stop");
    const retained = tool("task.read", { executionId: started.executionId });
    if (!retained.output.includes("READY")) fail("stopped task lost output");
    const failed = tool("task.start", {
      taskId: "fail",
      idempotencyKey: "fail-first",
    });
    await waitFor(
      "failure status",
      5000,
      () =>
        tool("task.read", { executionId: failed.executionId }).exitCode === 7,
    );
    if (
      tool("task.start", { taskId: "server", idempotencyKey: "server-first" })
        .executionId !== started.executionId
    )
      fail("retry after stop spawned a new process");
    console.log(
      "Harness task E2E passed: trust, launch, deduplication, output cursor, terminal reveal, stop, retained output, exit code",
    );
  }

  if (exerciseBrowser) await exerciseBrowserTools(harnessEnv);

  const afterOpen = run(cliExecutable, ["status"], isolatedEnvironment, 2_000);
  if (afterOpen.status !== 0) {
    fail(
      `desktop stopped responding after the editor flow: ${afterOpen.stderr}`,
      desktopLog,
    );
  }

  await exerciseQuitAndStopEverything(keptShell);

  console.log(
    "✓ Desktop E2E smoke passed: process → core endpoint → Tauri event/commands → WebView editor → SQLite → quit and relaunch",
  );
} finally {
  await stopExactChild(desktop);
  await stopCore(coreSocket);
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
