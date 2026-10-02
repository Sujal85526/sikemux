import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

function postgresBin(): string {
  const which = spawnSync("which", ["postgres"], { encoding: "utf8" });
  if (which.status !== 0) {
    throw new Error(
      "The API tests need Postgres: install it (16 or newer), or set TEST_DATABASE_URL to a server they may create databases on.",
    );
  }
  return dirname(realpathSync(which.stdout.trim()));
}

/**
 * Gives the tests a Postgres they may create databases on: TEST_DATABASE_URL when set (as in CI),
 * otherwise a throwaway server started from the local install and deleted afterwards.
 */
export default async function setup(project: TestProject) {
  const given = process.env.TEST_DATABASE_URL;
  if (given) {
    project.provide("adminUrl", given);
    return;
  }

  const bin = postgresBin();
  const dir = mkdtempSync(join(tmpdir(), "sikemux-api-test-"));
  const data = join(dir, "data");
  const port = await freePort();
  execFileSync(
    join(bin, "initdb"),
    ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8"],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    join(bin, "pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(dir, "log"),
      "-w",
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off`,
      "start",
    ],
    { stdio: "ignore" },
  );
  project.provide(
    "adminUrl",
    `postgresql://postgres@127.0.0.1:${port}/postgres`,
  );

  return () => {
    spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], {
      stdio: "ignore",
    });
    rmSync(dir, { recursive: true, force: true });
  };
}
