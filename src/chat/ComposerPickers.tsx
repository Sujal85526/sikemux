import { useEffect, useRef, useState, type ReactNode } from "react";
import { AgentIcon, IconChevron } from "../ui/Icons";
import type { ChatAgentType } from "../agents/agentLaunch";
import type { Agent, ProviderProfile } from "../state/types";
import type { AgentChoicesProps, Choice } from "./PickerMenu";
import { PickerMenu } from "./chatParts";
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
                <PickerMenu.Part
                    name={name}
                    value={value}
                    options={options}
                    agents={agents}
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
    onAgent: (type: ChatAgentType, profileId?: string) => void;
    onConfig: (config: SessionConfig, value: string) => void;
}) {
    const configs = sessionConfigs(setup);
    const agentIcon = <AgentIcon type={agent.type} size={17} className={`agent-glyph ${agent.type}`} />;
    const rowIcon = <AgentIcon type={agent.type} size={15} className={`agent-glyph ${agent.type}`} />;
    const [switching, setSwitching] = useState<Record<string, unknown>>();
    const loading = switching !== undefined && (disabled || switching === setup);
    useEffect(() => {
        if (switching && !loading) setSwitching(undefined);
    }, [switching, loading]);
    return (
        <div className="chat-pickers">
            {pickerSlots(configs, agent.type).map(({ id, config }) => {
                const model = id === "model";
                const name = model ? "Model" : "Reasoning effort";
                const label = currentLabel(config) ?? (model ? agent.model || "Model" : agent.effort || "Effort");
                const options = config?.options || [];
                return (
                    <Picker
                        key={id}
                        name={name}
                        label={label}
                        value={config?.currentValue || ""}
                        options={model ? options.map((option) => ({ ...option, icon: rowIcon })) : options}
                        disabled={disabled || (!options.length && (!model || agentLocked))}
                        icon={model ? agentIcon : undefined}
                        agents={
                            model && !agentLocked
                                ? {
                                      agent,
                                      profile,
                                      onSwitch: (type, profileId) => {
                                          setSwitching(setup);
                                          onAgent(type, profileId);
                                      },
                                  }
                                : undefined
                        }
                        loading={model && loading}
                        onOpen={model ? () => setSwitching(undefined) : undefined}
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
