import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { signalProcessTree, stopProcessTree } from "./dev-desktop.mjs";

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
