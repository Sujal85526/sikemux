import { invokeCommand as invoke } from "./invoke";

/** `api` bills per token, `plan` is a monthly coding subscription, `local` runs on this computer. */
export type ModelProviderKind = "api" | "plan" | "local";

/** One entry of `src-tauri/crates/sikemux-core/model-providers.json`, with what Sikemux knows of it now. */
export interface ModelProvider {
    id: string;
    label: string;
    kind: ModelProviderKind;
    /** Where the person makes a key, or downloads a local runner. */
    signUpUrl: string;
    /** Base URL of its OpenAI-compatible API. */
    openai: string;
    /** A keyed provider has its key saved; a local runner is answering. */
    connected: boolean;
    /** What a running local runner has installed. */
    models?: string[];
    /** The agents a chat can run on it in place of their makers' accounts. */
    agents: string[];
    /** The coding model its own docs recommend, and an agent's own where its guide differs. */
    model?: string;
    agentModels?: Record<string, string>;
    /** Whether each model checked so far calls tools the way agents need. */
    checks: Record<string, ModelCheck>;
}

export interface ModelCheck {
    works: boolean;
    /** Unix milliseconds. */
    at: number;
    detail?: string;
}

/** What helpers run on: workers started without a model named, and Claude Code's subagents. */
export interface ModelHelper {
    agent: string;
    provider?: string;
    model?: string;
}

/** The model a new chat of `agent` starts on there, before the first it serves. */
export const codingModel = (provider: ModelProvider, agent: string, served: string[] = []): string | undefined =>
    provider.agentModels?.[agent] ?? provider.model ?? served[0];

/** Checks are kept by the model's API name, without Claude Code's long-context suffix. */
export const checkOf = (provider: ModelProvider, model: string): ModelCheck | undefined => provider.checks[model.replace(/\[1m\]$/, "")];

export const checkWords = (check: ModelCheck): string => (check.works ? "works with agents" : "tool calls failed");

export const modelProvidersApi = {
    list: () => invoke<ModelProvider[]>("model_providers"),
    /** What a connected keyed provider serves, read with its key. */
    models: (id: string) => invoke<string[]>("model_provider_models", { id }),
    connect: (id: string, key: string) => invoke<void>("model_provider_connect", { id, key }),
    disconnect: (id: string) => invoke<void>("model_provider_disconnect", { id }),
    /** Asks the provider now whether the model calls tools the way agents need. */
    check: (id: string, model: string) => invoke<ModelCheck>("model_provider_check", { id, model }),
    helper: () => invoke<ModelHelper | null>("model_helper"),
    setHelper: (helper: ModelHelper | null) => invoke<void>("model_helper_set", { helper }),
};
