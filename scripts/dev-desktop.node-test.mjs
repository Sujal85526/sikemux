import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findBundledBrowser,
  readRecordedPid,
  reapLeftoverBrowser,
  signalProcessTree,
  stopRecordedBrowser,
  stopProcessTree,
} from "./dev-desktop.mjs";

test("readRecordedPid accepts only a safe process id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sikemux-dev-pid-test-"));
  const pidFile = join(directory, "browser.pid");
  try {
    await writeFile(pidFile, "4242\n");
    assert.equal(await readRecordedPid(pidFile), 4242);
    await writeFile(pidFile, "not-a-pid\n");
    assert.equal(await readRecordedPid(pidFile), null);
    await writeFile(pidFile, "1\n");
    assert.equal(await readRecordedPid(pidFile), null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test(
  "stopRecordedBrowser terminates the recorded process group",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sikemux-dev-tree-test-"));
    const pidFile = join(directory, "browser.pid");
    const child = spawn(
      "/bin/sh",
      ["-c", "trap '' TERM; while :; do sleep 1; done"],
      { detached: true, stdio: "ignore" },
    );
    const exited = new Promise((resolveExit) =>
      child.once("exit", resolveExit),
    );
    try {
      await writeFile(pidFile, `${child.pid}\n`);
      assert.equal(await stopRecordedBrowser(pidFile), true);
      await exited;
      assert.equal(await readRecordedPid(pidFile), null);
      assert.equal(signalProcessTree(child.pid, "SIGKILL"), false);
    } finally {
      signalProcessTree(child.pid, "SIGKILL");
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  "launcher cleanup stops descendants after their parent exits",
  { skip: process.platform === "win32" },
  async () => {
    const parent = spawn("/bin/sh", ["-c", "sleep 60 & exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise((resolveExit) => parent.once("exit", resolveExit));
    try {
      process.kill(-parent.pid, 0);
      await stopProcessTree(parent.pid);
      assert.equal(signalProcessTree(parent.pid, "SIGTERM"), false);
    } finally {
      signalProcessTree(parent.pid, "SIGKILL");
    }
  },
);

test(
  "reapLeftoverBrowser kills a leftover that still names the profile",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sikemux-dev-reap-test-"));
    const pidFile = join(directory, "browser.pid");
    const child = spawn(
      "/bin/sh",
      ["-c", "exec -a com.nodelike.sikemux.dev-browser sleep 60"],
      { detached: true, stdio: "ignore" },
    );
    const exited = new Promise((resolveExit) =>
      child.once("exit", resolveExit),
    );
    try {
      await writeFile(pidFile, `${child.pid}\n`);
      assert.equal(
        await reapLeftoverBrowser(pidFile, "com.nodelike.sikemux"),
        true,
      );
      await exited;
      assert.equal(await readRecordedPid(pidFile), null);
      assert.equal(signalProcessTree(child.pid, "SIGKILL"), false);
    } finally {
      signalProcessTree(child.pid, "SIGKILL");
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  "reapLeftoverBrowser spares a reused pid that is not our browser",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sikemux-dev-spare-test-"));
    const pidFile = join(directory, "browser.pid");
    const child = spawn(
      "/bin/sh",
      ["-c", "trap '' TERM; while :; do sleep 1; done"],
      { detached: true, stdio: "ignore" },
    );
    try {
      await writeFile(pidFile, `${child.pid}\n`);
      assert.equal(
        await reapLeftoverBrowser(pidFile, "com.nodelike.sikemux"),
        true,
      );
      assert.equal(await readRecordedPid(pidFile), null);
      // The unrelated process is left running because it is not our browser.
      assert.equal(signalProcessTree(child.pid, "SIGTERM"), true);
    } finally {
      signalProcessTree(child.pid, "SIGKILL");
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test("findBundledBrowser locates the Chrome for Testing executable", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "sikemux-dev-runtime-"));
  const macExecutableDir = join(
    runtime,
    "chromium-1234",
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
  );
  try {
    await mkdir(macExecutableDir, { recursive: true });
    const executable = join(macExecutableDir, "Google Chrome for Testing");
    await writeFile(executable, "");
    assert.equal(findBundledBrowser(runtime), executable);
    assert.equal(findBundledBrowser(join(runtime, "absent")), null);
  } finally {
    await rm(runtime, { force: true, recursive: true });
  }
});
