import { useCallback, useEffect, useState } from "react";
import { errorText } from "../lib/format";
import { modelProvidersApi, type ModelProvider, type ModelProviderKind } from "../api/modelProviders";
import { portsApi } from "../api/ports";
import { reportError } from "../state/toast";
import { SettingsRow, SettingsRows, SettingsSection } from "./SettingsLayout";

const KEYED_SECTIONS: { kind: ModelProviderKind; title: string; sub: string }[] = [
    {
        kind: "plan",
        title: "Coding plans",
        sub: "Monthly subscriptions made for coding agents. OpenCode, Pi and OMP list a plan's models once its key is saved here. Keys stay in your Keychain.",
    },
    {
        kind: "api",
        title: "Model providers",
        sub: "Hosted models you pay the provider for by the token. OpenCode, Pi and OMP list a provider's models once its key is saved here. Keys stay in your Keychain.",
    },
];

const openSignUp = (provider: ModelProvider) => void portsApi.openExternal(provider.signUpUrl).catch(reportError("Open link"));

export function ModelProvidersSection() {
    const [providers, setProviders] = useState<ModelProvider[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
    const [checking, setChecking] = useState(false);

    const refresh = useCallback(() => modelProvidersApi.list().then(setProviders).catch(reportError("Model providers")), []);
    useEffect(() => {
        void refresh();
    }, [refresh]);

    const change = async (id: string, work: () => Promise<void>) => {
        setBusy(id);
        setFailure(null);
        try {
            await work();
            setEditing(null);
            setKey("");
            await refresh();
        } catch (error) {
            setFailure({ id, message: errorText(error) });
        } finally {
            setBusy(null);
        }
    };

    const edit = (id: string | null) => {
        setEditing(id);
        setKey("");
        setFailure(null);
    };

    const checkAgain = async () => {
        setChecking(true);
        await refresh();
        setChecking(false);
    };

    const keyedRow = (provider: ModelProvider) => {
        const isEditing = editing === provider.id;
        const isBusy = busy === provider.id;
        const failed = failure?.id === provider.id ? failure.message : null;
        return (
            <SettingsRow
                key={provider.id}
                label={provider.label}
                wide={isEditing}
                desc={
                    failed ? (
                        <span className="model-provider-failure">{failed}</span>
                    ) : provider.connected ? (
                        "Connected. Agents started from now on can use it."
                    ) : undefined
                }>
                {provider.connected ? (
                    <button
                        className="settings-btn danger"
                        type="button"
                        disabled={isBusy}
                        onClick={() => void change(provider.id, () => modelProvidersApi.disconnect(provider.id))}>
                        Disconnect
                    </button>
                ) : isEditing ? (
                    <form
                        className="model-provider-key"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void change(provider.id, () => modelProvidersApi.connect(provider.id, key));
                        }}>
                        <input
                            className="settings-input mono"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={`${provider.label} API key`}
                            placeholder="Paste the API key"
                            autoFocus
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Escape") edit(null);
                            }}
                        />
                        <button className="settings-btn" type="button" disabled={isBusy} onClick={() => edit(null)}>
                            Cancel
                        </button>
                        <button className="settings-btn primary" type="submit" disabled={isBusy || !key.trim()} aria-busy={isBusy || undefined}>
                            {isBusy ? "Checking…" : "Connect"}
                        </button>
                    </form>
                ) : (
                    <>
                        <button className="settings-btn" type="button" onClick={() => openSignUp(provider)}>
                            Get a key
                        </button>
                        <button className="settings-btn" type="button" onClick={() => edit(provider.id)}>
                            Add key
                        </button>
                    </>
                )}
            </SettingsRow>
        );
    };

    const localRow = (provider: ModelProvider) => (
        <SettingsRow key={provider.id} label={provider.label} desc={<RunnerState provider={provider} />}>
            {!provider.connected && (
                <button className="settings-btn" type="button" onClick={() => openSignUp(provider)}>
                    Download
                </button>
            )}
            <button className="settings-btn" type="button" disabled={checking} aria-busy={checking || undefined} onClick={() => void checkAgain()}>
                {checking ? "Checking…" : "Check again"}
            </button>
        </SettingsRow>
    );

    const ofKind = (kind: ModelProviderKind) => providers.filter((provider) => provider.kind === kind);
    const local = ofKind("local");
    const running = local.filter((provider) => provider.connected).length;
    return (
        <>
            {KEYED_SECTIONS.map(({ kind, title, sub }) => {
                const rows = ofKind(kind);
                const connectedCount = rows.filter((provider) => provider.connected).length;
                return (
                    <SettingsSection key={kind} title={title} meta={connectedCount ? `${connectedCount} connected` : undefined} sub={sub}>
                        <SettingsRows>{rows.map(keyedRow)}</SettingsRows>
                    </SettingsSection>
                );
            })}
            <SettingsSection
                title="Local models"
                meta={running ? `${running} running` : undefined}
                sub="Models served on this computer by Ollama or LM Studio. They need no key, and nothing leaves this computer.">
                <SettingsRows>{local.map(localRow)}</SettingsRows>
            </SettingsSection>
        </>
    );
}

function RunnerState({ provider }: { provider: ModelProvider }) {
    if (!provider.connected) return <>Nothing is answering at {new URL(provider.openai).host}.</>;
    const models = provider.models ?? [];
    if (!models.length) return <>Running, with no models downloaded yet.</>;
    return (
        <>
            Running with <span className="model-provider-models">{models.join(", ")}</span>
        </>
    );
}
