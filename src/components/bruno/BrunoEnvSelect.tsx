import * as cmd from "../../state/commands";
import type { BruEnv } from "../../bruno/types";
import { IconChevron, IconShield } from "../Icons";

interface Props {
    sessionId: string;
    envs: BruEnv[];
    showCollection: boolean;
    selected: string | null;
    secretNames: string[];
    secretVars: Record<string, string>;
    secretsOpen: boolean;
}

export function BrunoEnvSelect({ sessionId, envs, showCollection, selected, secretNames, secretVars, secretsOpen }: Props) {
    const active = selected ? envs.find((e) => e.id === selected) : undefined;
    const label = active ? (showCollection ? `${active.collectionName}/${active.name}` : active.name) : "No environment";

    return (
        <div className="bruno-env">
            <button type="button" className="dd-btn bruno-env-dd" title="Environment (⌥E)" onClick={() => cmd.openBrunoEnvPalette()}>
                <span className="dd-val">{label}</span>
                <IconChevron size={9} className="dd-chev" />
            </button>
            {secretNames.length > 0 && (
                <button
                    className={`bruno-secrets-btn${secretsOpen ? " active" : ""}`}
                    title="Secret variables"
                    onClick={() => cmd.brunoToggleSecrets(sessionId)}>
                    <IconShield size={12} />
                    secrets
                </button>
            )}
            {secretsOpen && secretNames.length > 0 && (
                <div className="bruno-secrets-pop">
                    <div className="bruno-secrets-head">Secret variables{selected ? ` · ${selected}` : ""}</div>
                    {secretNames.map((name) => (
                        <label key={name} className="bruno-secret-row">
                            <span className="bruno-secret-name">{name}</span>
                            <input
                                type="password"
                                className="bruno-input"
                                value={secretVars[name] ?? ""}
                                placeholder="not set"
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(e) => cmd.brunoSetSecret(sessionId, name, e.target.value)}
                            />
                        </label>
                    ))}
                    <div className="bruno-secrets-foot">stored locally on this machine, not written to .bru files</div>
                </div>
            )}
        </div>
    );
}
