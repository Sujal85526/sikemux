import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
}

export interface FileBlob {
    mime: string;
    data: string;
    size: number;
}

export const fsapi = {
    readDir: (path: string) => invoke<DirEntry[]>("read_dir", { path }),
    readFile: (path: string) => invoke<string>("read_file", { path }),
    readTextFileLimited: (path: string) => invoke<string>("read_text_file_limited", { path }),
    readFileBase64: (path: string) => invoke<FileBlob>("read_file_base64", { path }),
    writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
    writeFileNew: (path: string, content: string) => invoke<void>("write_file_new", { path, content }),
    createFile: (path: string) => invoke<void>("create_file", { path }),
    createDir: (path: string) => invoke<void>("create_dir", { path }),
    copyIntoDir: (src: string, dir: string) => invoke<string>("copy_into_dir", { src, dir }),
    rename: (src: string, dest: string) => invoke<void>("rename_path", { src, dest }),
    revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
    deletePath: (path: string) => invoke<void>("delete_path", { path }),
};
