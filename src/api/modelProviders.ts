import { invokeCommand as invoke } from "./invoke";

/** `api` bills per token, `plan` is a monthly coding subscription, `local` runs on this computer. */
export type ModelProviderKind = "api" | "plan" | "local";

/** One entry of `src-tauri/model-providers.json`, with what Sikemux knows of it now. */
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
}

export const modelProvidersApi = {
    list: () => invoke<ModelProvider[]>("model_providers"),
    connect: (id: string, key: string) => invoke<void>("model_provider_connect", { id, key }),
    disconnect: (id: string) => invoke<void>("model_provider_disconnect", { id }),
};
