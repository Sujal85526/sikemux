import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mergeConfig, type PluginOption } from "vite";
import base from "../vite.config";
import { DEMO_PROJECTS } from "./world/projects";

const LOCAL_ROOTS: Record<string, string> = {
  sikemux: resolve(import.meta.dirname, ".."),
  "sikemux-front": join(homedir(), "projects/personal/sikemux-front"),
  "moodboard-studio": join(homedir(), "projects/personal/moodboard-studio"),
};

const MAX_FILE_BYTES = 400_000;
const HIDDEN_FOLDERS = new Set([
  ".claude",
  ".scratch",
  "scratch",
  "graphify-out",
  "coverage",
]);

interface ProjectFiles {
  root: string;
  files: Set<string>;
  dirs: Map<string, { name: string; isDir: boolean }[]>;
}

function localRoot(
  demoPath: string,
): { project: ProjectFiles; relative: string } | null {
  for (const project of DEMO_PROJECTS) {
    if (demoPath !== project.path && !demoPath.startsWith(`${project.path}/`))
      continue;
    return {
      project: projectFiles(project.name),
      relative: demoPath.slice(project.path.length + 1),
    };
  }
  return null;
}

const indexed = new Map<string, ProjectFiles>();

// Only tracked files are visible, so secrets, scratch folders and other people's work in progress never reach a screenshot.
function projectFiles(name: string): ProjectFiles {
  const cached = indexed.get(name);
  if (cached) return cached;
  const root = LOCAL_ROOTS[name];
  const listed = execFileSync("git", ["ls-files", "--cached"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  })
    .split("\n")
    .filter(
      (path) =>
        path &&
        !path
          .split("/")
          .some((part) => part.startsWith(".env") || HIDDEN_FOLDERS.has(part)),
    );
  const files = new Set(listed);
  const dirs = new Map<string, { name: string; isDir: boolean }[]>();
  const add = (dir: string, entry: string, isDir: boolean) => {
    const entries = dirs.get(dir) ?? [];
    if (!entries.some((existing) => existing.name === entry))
      entries.push({ name: entry, isDir });
    dirs.set(dir, entries);
  };
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      add(
        parts.slice(0, depth).join("/"),
        parts[depth],
        depth < parts.length - 1,
      );
    }
  }
  const project = { root, files, dirs };
  indexed.set(name, project);
  return project;
}

function readDir(demoPath: string) {
  const found = localRoot(demoPath);
  const entries = found?.project.dirs.get(found.relative) ?? null;
  if (!found || !entries)
    return { path: demoPath, entries: [], error: "not found" };
  return {
    path: demoPath,
    entries: entries.map((entry) => ({
      name: entry.name,
      path: `${demoPath}/${entry.name}`,
      is_dir: entry.isDir,
    })),
    error: null,
  };
}

function readFile(demoPath: string): string | null {
  const found = localRoot(demoPath);
  if (!found || !found.project.files.has(found.relative)) return null;
  const path = join(found.project.root, found.relative);
  if (statSync(path).size > MAX_FILE_BYTES) return null;
  return readFileSync(path, "utf8");
}

function shortAge(relative: string): string {
  const [amount, unit] = relative.split(" ");
  const letter = unit.startsWith("mo") ? "mo" : unit[0];
  return `${amount}${letter} ago`;
}

function gitLog(name: string, count: number) {
  const format = ["%H", "%P", "%an", "%ar", "%s", "%D"].join("%x1f");
  const out = execFileSync("git", ["log", `-n${count}`, `--format=${format}`], {
    cwd: LOCAL_ROOTS[name],
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const [full, parents, author, age, subject, decorations] =
        line.split("\x1f");
      const refs = decorations
        .split(", ")
        .filter(Boolean)
        .map((ref) => ref.replace(/^HEAD -> /, ""))
        .filter((ref) => ref !== "origin/HEAD");
      if (index === 0) refs.unshift("HEAD");
      return {
        hash: full.slice(0, 7),
        full_hash: full,
        parents: parents.split(" ").filter(Boolean),
        author,
        author_email: "",
        date: shortAge(age),
        subject,
        refs,
        unpushed: index < 2,
      };
    });
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

const SITE_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  woff2: "font/woff2",
  json: "application/json",
};

const SITE_ROOT_FILES = new Set(["/codex.svg", "/bruno.svg", "/favicon.svg"]);

// The landing page stands in for whatever an agent's browser tab has open.
function landingPage(): PluginOption {
  const dist = join(LOCAL_ROOTS["sikemux-front"], "dist");
  return {
    name: "sikemux-showcase-site",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = decodeURIComponent((request.url ?? "/").split("?")[0]);
        const sitePath = url.startsWith("/__site/")
          ? url.slice("/__site".length)
          : url.startsWith("/_astro/") || SITE_ROOT_FILES.has(url)
            ? url
            : null;
        if (sitePath === null) return next();
        const path = resolve(dist, `.${sitePath}`);
        if (!path.startsWith(dist))
          return send(response, 403, { error: "outside the site" });
        try {
          const file = statSync(path).isDirectory()
            ? join(path, "index.html")
            : path;
          response.setHeader(
            "Content-Type",
            SITE_TYPES[file.split(".").pop() ?? ""] ??
              "application/octet-stream",
          );
          response.end(readFileSync(file));
        } catch {
          send(response, 404, { error: "not in the site build" });
        }
      });
    },
  };
}

function demoFileSystem(): PluginOption {
  return {
    name: "sikemux-showcase-fs",
    configureServer(server) {
      server.middlewares.use("/__showcase", async (request, response) => {
        try {
          const input = await body(request);
          switch (request.url) {
            case "/read_dirs":
              return send(
                response,
                200,
                (input.paths as string[]).map(readDir),
              );
            case "/read_file": {
              const content = readFile(input.path as string);
              return content === null
                ? send(response, 404, {
                    error: "No such file or directory (os error 2)",
                  })
                : send(response, 200, content);
            }
            case "/list_files": {
              const found = localRoot(input.repo as string);
              return send(
                response,
                200,
                found ? [...found.project.files].sort() : [],
              );
            }
            case "/git_log":
              return send(
                response,
                200,
                gitLog(input.project as string, Number(input.count ?? 60)),
              );
            default:
              return send(response, 404, {
                error: "unknown showcase endpoint",
              });
          }
        } catch (error) {
          return send(response, 500, { error: String(error) });
        }
      });
    },
  };
}

export default mergeConfig(base, {
  plugins: [demoFileSystem(), landingPage()],
  server: { port: 1471, strictPort: true },
  // Headless Chrome's WebGL context scales xterm's glyphs twice at 2x; the DOM renderer draws the same cells.
  define: { "import.meta.env.VITE_TERMINAL_WEBGL": JSON.stringify("0") },
});
