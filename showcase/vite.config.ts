import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  const listed = !existsSync(root)
    ? ""
    : execFileSync("git", ["ls-files", "--cached"], {
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
              .some(
                (part) => part.startsWith(".env") || HIDDEN_FOLDERS.has(part),
              ),
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
  if (!existsSync(LOCAL_ROOTS[name])) return [];
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
  plugins: [demoFileSystem()],
  server: { port: 1471, strictPort: true },
  // Headless Chrome's WebGL context scales xterm's glyphs twice at 2x; the DOM renderer draws the same cells.
  define: { "import.meta.env.VITE_TERMINAL_WEBGL": JSON.stringify("0") },
});
