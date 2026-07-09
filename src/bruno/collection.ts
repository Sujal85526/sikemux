// Load a Bruno collection (or a workspace of collections) from disk.
//
// A Bruno *collection* is a directory with a `bruno.json` / `collection.bru`;
// its environments live in `<collection>/environments/*.bru`. A *workspace* may
// hold several collections (e.g. `collections/api-gateway`, `collections/surepass`).
// We support both: open a single collection, or a workspace folder above many.
// Environments are gathered from every collection (labelled by collection name
// when nested), and a nested `collection.bru` participates in scope inheritance
// just like a `folder.bru`, so per-collection auth / token-refresh scripts apply.

import { fsapi, type DirEntry } from "../api/fs";
import { parseEnv, parseRequest, parseScope } from "./parse";
import type { BruCollection, BruEnv, BruScope, BruTreeNode } from "./types";

const BRU = ".bru";
const ENV_DIR = "environments";
const SEQ_LAST = Number.MAX_SAFE_INTEGER;
const IGNORE_DIRS = new Set([".git", "node_modules", ENV_DIR]);

function baseName(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? p : p.slice(i + 1);
}

function stem(name: string): string {
    return name.endsWith(BRU) ? name.slice(0, -BRU.length) : name;
}

function isCollectionRoot(entries: DirEntry[]): boolean {
    return entries.some((e) => !e.is_dir && (e.name === "bruno.json" || e.name === "collection.bru"));
}

/**
 * Build the folder/request tree. `environments/` dirs are skipped (handled
 * separately). `collPath` tracks the nearest enclosing collection root so each
 * request can be scoped to its collection's environments.
 */
async function buildTree(entries: DirEntry[], collPath: string): Promise<BruTreeNode[]> {
    const nodes: BruTreeNode[] = [];
    for (const e of entries) {
        if (e.is_dir) {
            if (IGNORE_DIRS.has(e.name)) continue;
            const children = await fsapi.readDir(e.path);
            // A folder's scope comes from folder.bru, or a nested collection.bru.
            const scopeFile = children.find((c) => !c.is_dir && (c.name === "folder.bru" || c.name === "collection.bru"));
            const scope: BruScope | null = scopeFile ? parseScope(await fsapi.readFile(scopeFile.path), e.name) : null;
            const childColl = isCollectionRoot(children) ? e.path : collPath;
            const childNodes = await buildTree(children, childColl);
            // Skip empty structural dirs (e.g. a bare `collections/` wrapper with nothing useful).
            if (childNodes.length === 0 && !scope) continue;
            nodes.push({
                type: "folder",
                name: scope?.meta.name || e.name,
                path: e.path,
                seq: scope?.meta.seq ?? SEQ_LAST,
                scope,
                children: childNodes,
            });
        } else if (e.name.endsWith(BRU) && e.name !== "collection.bru" && e.name !== "folder.bru") {
            const request = parseRequest(await fsapi.readFile(e.path));
            nodes.push({
                type: "request",
                name: request.meta.name || stem(e.name),
                path: e.path,
                seq: request.meta.seq ?? SEQ_LAST,
                method: request.method,
                collectionPath: collPath,
                request,
            });
        }
    }
    nodes.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
    return nodes;
}

/**
 * Recursively gather environments from every `environments/` dir, tagging each
 * with the collection root it belongs to (so the UI can scope the env dropdown
 * to the open request's collection).
 */
async function collectEnvs(dirPath: string, entries: DirEntry[], collPath: string): Promise<BruEnv[]> {
    const out: BruEnv[] = [];
    const here = isCollectionRoot(entries) ? dirPath : collPath;
    for (const e of entries) {
        if (!e.is_dir) continue;
        if (e.name === ENV_DIR) {
            for (const f of await fsapi.readDir(e.path)) {
                if (!f.is_dir && f.name.endsWith(BRU)) {
                    out.push(parseEnv(await fsapi.readFile(f.path), stem(f.name), here, baseName(here || dirPath)));
                }
            }
        } else if (!IGNORE_DIRS.has(e.name)) {
            out.push(...(await collectEnvs(e.path, await fsapi.readDir(e.path), here)));
        }
    }
    return out;
}

export async function loadCollection(rootPath: string): Promise<BruCollection> {
    const entries = await fsapi.readDir(rootPath);

    const collectionBru = entries.find((e) => !e.is_dir && e.name === "collection.bru");
    const config: BruScope | null = collectionBru ? parseScope(await fsapi.readFile(collectionBru.path), baseName(rootPath)) : null;

    const rootColl = isCollectionRoot(entries) ? rootPath : "";
    const envs = await collectEnvs(rootPath, entries, rootColl);
    envs.sort((a, b) => a.collectionName.localeCompare(b.collectionName) || a.name.localeCompare(b.name));

    const tree = await buildTree(entries, rootColl);
    return { rootPath, name: config?.meta.name || baseName(rootPath), config, envs, tree };
}
