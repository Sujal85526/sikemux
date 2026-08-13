import { permissionCopyForType, supportedPermissionModes } from "../agentLaunch";
import type { AgentPermissionMode, AgentType } from "../state/types";
import { Dropdown } from "./Dropdown";
import { IconShield, IconShieldBolt } from "./Icons";
import "../styles/agent-permission.css";

export function AgentPermissionSelector({
    type,
    value,
    onChange,
    className,
    disabled,
    disabledTitle,
    align,
    menuWidth = 260,
    shortcut,
}: {
    type: AgentType;
    value: AgentPermissionMode;
    onChange: (mode: AgentPermissionMode) => void;
    className?: string;
    disabled?: boolean;
    disabledTitle?: string;
    align?: "left" | "right";
    menuWidth?: number;
    shortcut?: string;
}) {
    const copy = permissionCopyForType(type, value);
    const yolo = value === "bypass";

    return (
        <Dropdown
            icon={yolo ? <IconShieldBolt size={12} /> : <IconShield size={12} />}
            trailing={shortcut ? <kbd className="agent-permission-shortcut">{shortcut}</kbd> : undefined}
            className={["agent-permission-select", copy.tone, yolo ? "is-yolo" : "", className ?? ""].filter(Boolean).join(" ")}
            title={disabled && disabledTitle ? disabledTitle : `Safety: ${copy.label}. ${copy.detail}`}
            label="Safety"
            value={value}
            disabled={disabled}
            align={align}
            menuWidth={menuWidth}
            options={supportedPermissionModes(type).map((mode) => {
                const option = permissionCopyForType(type, mode);
                return {
                    value: mode,
                    label: option.label,
                    detail: option.detail,
                    className: `agent-permission-option ${option.tone}${mode === "bypass" ? " is-yolo" : ""}`,
                };
            })}
            onChange={(next) => onChange(next as AgentPermissionMode)}
        />
    );
}
