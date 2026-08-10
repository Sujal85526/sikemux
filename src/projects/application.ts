import { invokeCommand } from "../api/invoke";
import { LocalProjectBackend, ProjectBackendRegistry, createProjectLocation, type ProjectBackendCallOptions, type ProjectLocation } from "./backend";

export const LOCAL_PROJECT_FILE_SNAPSHOT_OPERATION = "files.snapshot";

/**
 * Production composition root for project transports. Local filesystem
 * snapshots are routed through the same capability boundary that a trusted
 * remote backend must implement; unregistered schemes fail closed.
 */
export const projectBackends = new ProjectBackendRegistry();

const localProjectBackend = new LocalProjectBackend({
    files: (location, request, options) => {
        if (request.operation !== LOCAL_PROJECT_FILE_SNAPSHOT_OPERATION) {
            throw new TypeError(`Unsupported local project file operation: ${request.operation}`);
        }
        if (Object.hasOwn(request, "input")) {
            throw new TypeError("Local project file snapshots do not accept request input");
        }
        return invokeCommand("list_project_files_snapshot", { repo: location.path }, invokeOptions(options));
    },
});

projectBackends.registerTrusted(localProjectBackend);

function invokeOptions(options: ProjectBackendCallOptions): ProjectBackendCallOptions | undefined {
    return options.signal === undefined ? undefined : { signal: options.signal };
}

export function localProjectLocation(path: string): ProjectLocation {
    return createProjectLocation({ scheme: "local", path });
}

export function loadProjectFilesSnapshot(path: string, options?: ProjectBackendCallOptions): Promise<unknown> {
    return projectBackends.files(localProjectLocation(path), { operation: LOCAL_PROJECT_FILE_SNAPSHOT_OPERATION }, options);
}
