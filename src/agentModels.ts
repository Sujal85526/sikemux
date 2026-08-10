import type { AgentType } from "./state/types";

export interface AgentModelChoice {
    /** Exactly what gets passed to the provider's `--model` flag. */
    value: string;
    label: string;
    detail?: string;
}

/**
 * What each provider's own picker offers for `--model`.
 *
 * `claude --help` documents its aliases ("'fable', 'opus', or 'sonnet' … or a
 * model's full name"); codex takes a bare model id; `pi --model` takes a
 * `provider/id` pattern. Hermes and OpenCode resolve their catalogs from live
 * provider queries on the machine — `hermes model` and `opencode models` own
 * those lists, so Sikemux offers none and leaves the field free.
 *
 * These are suggestions, never a whitelist: the field accepts anything, so a
 * model released tomorrow works without waiting for a Sikemux update.
 */
export const AGENT_MODELS: Readonly<Record<AgentType, readonly AgentModelChoice[]>> = {
    claude: [
        { value: "fable", label: "fable", detail: "alias · newest Fable" },
        { value: "opus", label: "opus", detail: "alias · newest Opus" },
        { value: "sonnet", label: "sonnet", detail: "alias · newest Sonnet" },
        { value: "claude-fable-5", label: "claude-fable-5" },
        { value: "claude-opus-5", label: "claude-opus-5" },
        { value: "claude-opus-4-8", label: "claude-opus-4-8" },
        { value: "claude-sonnet-5", label: "claude-sonnet-5" },
        { value: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
    codex: [
        { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
        { value: "gpt-5.6-terra", label: "gpt-5.6-terra" },
        { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
        { value: "gpt-5.5", label: "gpt-5.5" },
        { value: "gpt-5.4", label: "gpt-5.4" },
        { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
        { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
    ],
    pi: [
        { value: "anthropic/claude-opus-5", label: "claude-opus-5", detail: "anthropic" },
        { value: "anthropic/claude-fable-5", label: "claude-fable-5", detail: "anthropic" },
        { value: "anthropic/claude-sonnet-5", label: "claude-sonnet-5", detail: "anthropic" },
        { value: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5", detail: "anthropic" },
        { value: "openai-codex/gpt-5.6-sol", label: "gpt-5.6-sol", detail: "openai-codex" },
        { value: "openai-codex/gpt-5.5", label: "gpt-5.5", detail: "openai-codex" },
    ],
    hermes: [],
    opencode: [],
};

export function modelChoicesFor(type: AgentType | null): readonly AgentModelChoice[] {
    return type ? AGENT_MODELS[type] : [];
}
