#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
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

await executableExists(appExecutable, "debug desktop executable");
await executableExists(cliExecutable, "release editor CLI");

const temporaryRoot = await mkdtemp(join(tmpdir(), "sikemux-desktop-e2e-"));
const isolatedHome = join(temporaryRoot, "home");
const project = join(temporaryRoot, "project");
const source = join(project, "smoke.ts");
const endpoint = join(temporaryRoot, "cli-endpoint.json");
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
};
delete isolatedEnvironment.SIKEMUX_APP_EXECUTABLE;

let desktopLog = "";
let desktopSpawnError = "";
const desktop = spawn(appExecutable, [], {
  cwd: project,
  env: isolatedEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
desktop.stdout.on("data", (chunk) => {
  desktopLog = boundedAppend(desktopLog, chunk);
});
desktop.stderr.on("data", (chunk) => {
  desktopLog = boundedAppend(desktopLog, chunk);
});
desktop.on("error", (error) => {
  desktopSpawnError = error.message;
});

try {
  await waitFor("authenticated desktop CLI broker", READY_TIMEOUT_MS, () => {
    if (desktopSpawnError) fail(desktopSpawnError, desktopLog);
    if (desktop.exitCode !== null || desktop.signalCode !== null) {
      fail(
        `desktop exited before becoming ready (${desktop.exitCode ?? desktop.signalCode})`,
        desktopLog,
      );
    }
    const status = run(cliExecutable, ["status"], isolatedEnvironment, 2_000);
    return (
      status.status === 0 && /^Sikemux \S+ is running\s*$/u.test(status.stdout)
    );
  });

  // The native broker starts during Tauri setup, before React has necessarily
  // hydrated. Initial persistence is queued only once the WebView is writable,
  // so this is a durable readiness barrier for the renderer-side bridge.
  await waitFor(
    "WebView boot and initial persistence",
    PERSIST_TIMEOUT_MS,
    async () => {
      return (await latestStateWriteTime()) > 0;
    },
  );
  const stateWriteBeforeOpen = await latestStateWriteTime();

  // This call returns success only after the native broker emits the request,
  // the real WebView listener claims it, application state creates/activates
  // an editor pane at the requested location, and the renderer reports the
  // exact target result back through a second Tauri command.
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

  console.log(
    "✓ Desktop E2E smoke passed: process → broker → Tauri event/commands → WebView editor → SQLite",
  );
} finally {
  await stopExactChild(desktop);
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
