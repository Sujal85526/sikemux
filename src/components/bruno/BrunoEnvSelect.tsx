import * as cmd from "../../state/commands";
import type { BruEnv } from "../../bruno/types";
import { IconShield } from "../Icons";
import { BrunoSelect, type BrunoOption } from "./BrunoControls";

interface Props {
    sessionId: string;
    collectionPath: string;
    envs: BruEnv[];
    showCollection: boolean;
    selected: string | null;
    secretNames: string[];
    secretVars: Record<string, string>;
    secretsOpen: boolean;
}

const NO_ENV = "__none__";

export function BrunoEnvSelect({ sessionId, collectionPath, envs, showCollection, selected, secretNames, secretVars, secretsOpen }: Props) {
    const options: BrunoOption[] = [
        { value: NO_ENV, label: "No environment" },
        ...envs.map((env) => ({ value: env.id, label: showCollection ? `${env.collectionName}/${env.name}` : env.name })),
    ];

    return (
        <div className="bruno-env">
            <BrunoSelect
                value={selected ?? NO_ENV}
                options={options}
                onChange={(v) => cmd.brunoSelectEnv(sessionId, collectionPath, v === NO_ENV ? null : v)}
                className="bruno-env-dd"
                title="Environment"
                align="right"
                menuWidth={200}
            />
            {secretNames.length > 0 && (
                <button className={`bruno-secrets-btn${secretsOpen ? " active" : ""}`} title="Secret variables" onClick={() => cmd.brunoToggleSecrets(sessionId)}>
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
