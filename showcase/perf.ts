import type { DiffRow, GitStatus } from "../src/api/git";
import type { ShowcaseBackend } from "./backend";

/*
 * Times the git screen the way a person meets it: opening it, switching to
 * and from it, and scrolling its review, on a repository with as many dirty
 * files as asked for. Open /showcase/perf.html in a WebKit tab and call
 * `perf.run()`; serve it in production mode, since React's development build
 * is several times slower.
 */

interface Showcase {
  backend: ShowcaseBackend;
  cmd: { selectSession(id: string): void; selectWindowId(id: string): void };
}

const SESSION = "s-sikemux";
const GIT = "w-sikemux-git";
const OTHERS = ["w-sikemux-term", "w-sikemux-files"];
const FRAME_MS = 1000 / 120;

const showcase = () => (window as unknown as { showcase: Showcase }).showcase;
const sleep = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

function quantile(values: number[], at: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0,
  );
}

/** Every frame's length while `during` runs and for `ms` after it. */
async function frames(ms: number, during?: () => void): Promise<number[]> {
  const lengths: number[] = [];
  let last = performance.now();
  let watching = true;
  const tick = () => {
    const now = performance.now();
    lengths.push(now - last);
    last = now;
    if (watching) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await sleep(30);
  lengths.length = 0;
  during?.();
  await sleep(ms);
  watching = false;
  return lengths;
}

/** How far the frames ran past a 120Hz budget in all, and the longest of them. */
function jank(lengths: number[]) {
  return {
    overBudgetMs: Math.round(
      lengths.reduce((sum, length) => sum + Math.max(0, length - FRAME_MS), 0),
    ),
    longestMs: Math.round(Math.max(0, ...lengths)),
  };
}

async function scroll(by: number, count: number, from: number) {
  const list = document.querySelector<HTMLElement>(".merge-review-list");
  if (!list) throw new Error("the review list is not on screen");
  list.scrollTop = from;
  await sleep(600);
  const lengths: number[] = [];
  let last = performance.now();
  await new Promise<void>((done) => {
    let step = 0;
    const tick = () => {
      const now = performance.now();
      lengths.push(now - last);
      last = now;
      list.scrollTop += by;
      if (++step < count) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  const settled = lengths.slice(2);
  return {
    p50Ms: quantile(settled, 0.5),
    p90Ms: quantile(settled, 0.9),
    p99Ms: quantile(settled, 0.99),
    longestMs: quantile(settled, 1),
    framesOver17Ms: settled.filter((length) => length > 16.7).length,
  };
}

/** Diffs built from the files themselves, a line in seven added and one in nine removed, so they colour like real code. */
function serveDiffs(backend: ShowcaseBackend): void {
  backend.on("git_file_diff", async ({ repo, path }) => {
    const response = await fetch("/__showcase/read_file", {
      method: "POST",
      body: JSON.stringify({ path: `${repo}/${path}` }),
    });
    const text: unknown = response.ok ? await response.json() : "";
    const rows: DiffRow[] = [];
    (typeof text === "string" ? text : "")
      .split("\n")
      .forEach((line, index) => {
        if (index % 9 === 4) rows.push([2, index + 1, `${line} // before`]);
        rows.push([index % 7 === 3 ? 1 : 0, index + 1, line]);
      });
    return rows;
  });
}

async function dirty(count: number): Promise<void> {
  const { GIT_STATUS } = await import("./world/git");
  const repo = Object.keys(GIT_STATUS)[0];
  const response = await fetch("/__showcase/list_files", {
    method: "POST",
    body: JSON.stringify({ repo }),
  });
  const files = ((await response.json()) as string[])
    .filter((path) => /\.(tsx?|rs|css|md)$/.test(path))
    .slice(0, count);
  const status: GitStatus = GIT_STATUS[repo];
  status.files = files.map((path, index) => ({
    path,
    index: index % 5 === 0 ? "M" : " ",
    worktree: index % 5 === 0 ? " " : "M",
  }));
}

async function run({
  dirtyFiles = 1500,
  switches = 3,
}: { dirtyFiles?: number; switches?: number } = {}) {
  const { backend, cmd } = showcase();
  serveDiffs(backend);
  await dirty(dirtyFiles);
  cmd.selectSession(SESSION);
  cmd.selectWindowId(OTHERS[0]);
  await sleep(1000);

  const idle = jank(await frames(1000));
  const open = jank(await frames(3000, () => cmd.selectWindowId(GIT)));
  const switching: ReturnType<typeof jank>[] = [];
  for (let round = 0; round < switches; round++) {
    for (const other of OTHERS) {
      switching.push(jank(await frames(1000, () => cmd.selectWindowId(other))));
      switching.push(jank(await frames(1000, () => cmd.selectWindowId(GIT))));
    }
  }
  const result = {
    dirtyFiles,
    idle,
    open,
    switch: {
      overBudgetMs: quantile(
        switching.map((one) => one.overBudgetMs),
        0.5,
      ),
      longestMs: quantile(
        switching.map((one) => one.longestMs),
        0.5,
      ),
      worstMs: Math.max(...switching.map((one) => one.longestMs)),
    },
    scroll: await scroll(40, 240, 0),
    fling: await scroll(150, 240, 100_000),
    scrollAgain: await scroll(40, 240, 0),
  };
  console.table(result);
  return result;
}

Object.assign(window, { perf: { run } });
