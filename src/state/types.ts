// Barrel re-export. Imports anywhere in the codebase still write
// `import type { Window, Agent, ... } from "../state/types"`.
// The actual types live in:
//
//   types/domain.ts     — persisted entities (sessions, windows, agents, ...)
//   types/view.ts       — ephemeral pane/session view state (modal, focus, ...)
//   types/persisted.ts  — wire shape for state.json (versioned)
//
// Splitting them keeps the persistence contract small and obvious: when
// `PersistedSnapshot` changes shape, only `persisted.ts` + its consumers
// (`persist.ts`) move.

export * from "./types/domain";
export * from "./types/view";
export * from "./types/persisted";
