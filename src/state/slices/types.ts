import type { StateCreator } from "zustand";
import type { WorkspaceStore } from "../workspace";

// Each slice receives `set` / `get` typed against the FULL combined store so
// it can read or patch other slices' state when needed.
export type Slice<T> = StateCreator<WorkspaceStore, [], [], T>;
