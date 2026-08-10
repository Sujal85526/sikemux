import { invokeCommand as invoke } from "./invoke";

export interface ProjectFilesSnapshot {
    readonly scanId: number;
    readonly files: string[];
}

interface CachedSnapshot {
    readonly generation: number;
    readonly snapshot: ProjectFilesSnapshot;
}

interface InflightSnapshot {
    readonly generation: number;
    readonly promise: Promise<ProjectFilesSnapshot>;
}

const inflight = new Map<string, InflightSnapshot>();
const cache = new Map<string, CachedSnapshot>();
const repoGenerations = new Map<string, number>();
let invalidationSequence = 0;
let globalGeneration = 0;

function generationFor(repo: string): number {
    return Math.max(globalGeneration, repoGenerations.get(repo) ?? 0);
}

function nextInvalidationGeneration(): number {
    if (invalidationSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("file cache generation space exhausted");
    invalidationSequence += 1;
    return invalidationSequence;
}

function assertSnapshot(value: ProjectFilesSnapshot): ProjectFilesSnapshot {
    if (
        !Number.isSafeInteger(value?.scanId) ||
        value.scanId <= 0 ||
        !Array.isArray(value.files) ||
        !value.files.every((path) => typeof path === "string")
    ) {
        throw new TypeError("native project file snapshot is malformed");
    }
    return value;
}

function snapshot(repo: string): Promise<ProjectFilesSnapshot> {
    const generation = generationFor(repo);
    const hit = cache.get(repo);
    if (hit?.generation === generation) return Promise.resolve(hit.snapshot);

    const pending = inflight.get(repo);
    if (pending?.generation === generation) return pending.promise;

    const promise = invoke<ProjectFilesSnapshot>("list_project_files_snapshot", { repo })
        .then(assertSnapshot)
        .then((incoming) => {
            const previous = cache.get(repo)?.snapshot;
            // scanId is process-monotonic. Never let a late request replace a
            // newer snapshot, and preserve array identity when nothing changed.
            const resolved =
                previous && previous.scanId > incoming.scanId
                    ? previous
                    : previous?.scanId === incoming.scanId
                      ? { scanId: incoming.scanId, files: previous.files }
                      : incoming;
            if (generationFor(repo) === generation) cache.set(repo, { generation, snapshot: resolved });
            return resolved;
        })
        .finally(() => {
            if (inflight.get(repo)?.promise === promise) inflight.delete(repo);
        });
    inflight.set(repo, { generation, promise });
    return promise;
}

export const filesApi = {
    snapshot,
    list: (repo: string): Promise<string[]> => snapshot(repo).then((result) => result.files),
    invalidate: (repo?: string) => {
        const generation = nextInvalidationGeneration();
        if (repo) repoGenerations.set(repo, generation);
        else globalGeneration = generation;
    },
};
