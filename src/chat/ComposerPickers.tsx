import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AgentIcon, IconChevron } from "../ui/Icons";
import type { ChatAgentType } from "../agents/agentLaunch";
import { agentLabel } from "../agents/catalog";
import { modelProvidersApi, modelWords, type ModelProvider, type ServedModels } from "../api/modelProviders";
import { swallow } from "../state/toast";
import type { Agent, ProviderProfile } from "../state/types";
import PickerMenu, { type AgentChoicesProps, type Choice } from "./PickerMenu";
import { currentLabel, pickerSlots, sessionConfigs, type SessionConfig } from "./sessionConfig";

function Picker({
    name,
    label,
    value,
    options,
    disabled,
    onSelect,
    icon,
    agents,
    payers,
    loading = false,
    onOpen,
    compact = false,
}: {
    name: string;
    label: string;
    value: string;
    options: Choice[];
    disabled: boolean;
    onSelect: (value: string) => void;
    icon?: ReactNode;
    agents?: AgentChoicesProps;
    /** Who pays for the model's turns: the agent's own account or a connected provider. */
    payers?: ReactNode;
    /** Holds the menu open while the control is disabled, with the list waiting on new options. */
    loading?: boolean;
    onOpen?: () => void;
    /** Descriptions stay searchable but go unrendered, so the rows read as one line. */
    compact?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const shown = open && (!disabled || loading);
    const close = () => {
        setOpen(false);
        trigger.current?.focus();
    };

    useEffect(() => {
        if (!open) return;
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener("pointerdown", outside);
        return () => document.removeEventListener("pointerdown", outside);
    }, [open]);

    return (
        <div
            className="chat-picker"
            ref={root}
            onBlur={(event) => {
                // WebKit hands focus to nobody when a button is clicked, so a blur
                // with no new target is a click on our own menu, not a click away.
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}>
            <button
                ref={trigger}
                type="button"
                className="chat-picker-trigger"
                aria-label={name}
                aria-haspopup="listbox"
                aria-expanded={shown}
                disabled={disabled}
                title={label}
                onClick={() => {
                    if (!open) onOpen?.();
                    setOpen(!open);
                    setQuery("");
                    setSelected(0);
                }}>
                {icon}
                <span>{label}</span>
                <IconChevron size={10} />
            </button>
            {shown && (
                <PickerMenu
                    name={name}
                    value={value}
                    options={options}
                    agents={agents}
                    payers={payers}
                    loading={loading}
                    compact={compact}
                    query={query}
                    selected={selected}
                    trigger={trigger}
                    onQuery={setQuery}
                    onSelected={setSelected}
                    onSelect={onSelect}
                    onClose={close}
                />
            )}
        </div>
    );
}

/** A connected provider this agent can run on, with the models it serves. */
interface Route {
    provider: ModelProvider;
    served: ServedModels;
}

/** The providers `agent` can run on, read when asked, since local runners are
    probed and keyed providers asked for their models over the network. */
function useRoutes(agent: Agent): [Route[], () => void] {
    const [routes, setRoutes] = useState<Route[]>([]);
    const load = useCallback(() => {
        void modelProvidersApi
            .list()
            .then((providers) =>
                Promise.all(
                    providers
                        .filter((provider) => provider.connected && provider.agents.includes(agent.type))
                        .map(async (provider) => ({
                            provider,
                            served: provider.models
                                ? { ...provider, models: provider.models }
                                : await modelProvidersApi.models(provider.id).catch(() => ({ ...provider, models: [] })),
                        })),
                ),
            )
            .then((loaded) => setRoutes(loaded.filter((route) => route.served.models.length > 0 || route.provider.id === agent.modelProvider)))
            .catch(swallow("model providers"));
    }, [agent.type, agent.modelProvider]);
    useEffect(() => {
        if (agent.modelProvider) load();
    }, [agent.modelProvider, load]);
    return [routes, load];
}

function payerTitle(provider: ModelProvider): string {
    return provider.kind === "local" ? `Runs on ${provider.label} on this computer` : `Paid with your ${provider.label} key`;
}

function servedLabel(route: Route, model: string): string {
    return [model, ...modelWords(route.served, route.provider.checks, model)].join(" · ");
}

/** Who pays for the chat's turns: the agent's own account, or a provider the
    person connected. Picking a provider moves the chat there, on its coding model. */
function PayerChoices({
    agent,
    profile,
    routes,
    onPick,
}: {
    agent: Agent;
    profile?: ProviderProfile;
    routes: Route[];
    onPick: (route?: Route) => void;
}) {
    const account = profile?.name ?? `${agentLabel(agent.type)} account`;
    return (
        <div className="chat-picker-agents" role="group" aria-label="Paid by">
            <button
                type="button"
                aria-pressed={!agent.modelProvider}
                title={`Paid by your ${account}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => agent.modelProvider && onPick()}>
                <span>{account}</span>
            </button>
            {routes.map((route) => (
                <button
                    type="button"
                    key={route.provider.id}
                    aria-pressed={route.provider.id === agent.modelProvider}
                    title={payerTitle(route.provider)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => route.provider.id !== agent.modelProvider && onPick(route)}>
                    <span>{route.provider.label}</span>
                </button>
            ))}
        </div>
    );
}

export function ComposerPickers({
    agent,
    profile,
    setup,
    disabled,
    agentLocked = false,
    onConfig,
    onAgent,
}: {
    agent: Agent;
    profile?: ProviderProfile;
    setup: Record<string, unknown>;
    disabled: boolean;
    agentLocked?: boolean;
    onAgent: (type: ChatAgentType, profileId?: string, model?: string, modelProvider?: string) => void;
    onConfig: (config: SessionConfig, value: string) => void;
}) {
    const configs = sessionConfigs(setup);
    const agentIcon = <AgentIcon type={agent.type} size={17} className={`agent-glyph ${agent.type}`} />;
    const rowIcon = <AgentIcon type={agent.type} size={15} className={`agent-glyph ${agent.type}`} />;
    const [switching, setSwitching] = useState<Record<string, unknown>>();
    const [routes, loadRoutes] = useRoutes(agent);
    const loading = switching !== undefined && (disabled || switching === setup);
    useEffect(() => {
        if (switching && !loading) setSwitching(undefined);
    }, [switching, loading]);
    const route = routes.find((item) => item.provider.id === agent.modelProvider);
    const relaunch: typeof onAgent = (...choice) => {
        setSwitching(setup);
        onAgent(...choice);
    };
    return (
        <div className="chat-pickers">
            {pickerSlots(configs, agent.type).map(({ id, config }) => {
                const model = id === "model";
                const name = model ? "Model" : "Reasoning effort";
                const current = currentLabel(config) ?? (model ? agent.model || "Model" : agent.effort || "Effort");
                const label = model && route ? `${current} · ${route.provider.label}` : current;
                const listed = config?.options || [];
                const served = model ? (route?.served.models ?? []).filter((value) => !listed.some((option) => option.value === value)) : [];
                const options = [...listed, ...served.map((value) => ({ value, label: route ? servedLabel(route, value) : value }))];
                return (
                    <Picker
                        key={id}
                        name={name}
                        label={label}
                        value={config?.currentValue || ""}
                        options={model ? options.map((option) => ({ ...option, icon: rowIcon })) : options}
                        disabled={disabled || (!options.length && (!model || agentLocked))}
                        icon={model ? agentIcon : undefined}
                        agents={model && !agentLocked ? { agent, profile, onSwitch: (type, profileId) => relaunch(type, profileId) } : undefined}
                        payers={
                            model && !agentLocked && routes.length > 0 ? (
                                <PayerChoices
                                    agent={agent}
                                    profile={profile}
                                    routes={routes}
                                    onPick={(next) =>
                                        relaunch(agent.type as ChatAgentType, profile?.id, next?.served.defaults[agent.type], next?.provider.id)
                                    }
                                />
                            ) : undefined
                        }
                        loading={model && loading}
                        onOpen={
                            model
                                ? () => {
                                      setSwitching(undefined);
                                      loadRoutes();
                                  }
                                : undefined
                        }
                        compact={model}
                        onSelect={(value) => {
                            if (config && value !== config.currentValue) onConfig(config, value);
                        }}
                    />
                );
            })}
        </div>
    );
}
