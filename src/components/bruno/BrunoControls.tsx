import { useState } from "react";
import { IconChevron, IconCheck } from "../Icons";

export interface BrunoOption {
    value: string;
    label: string;
    /** extra class applied to the label (e.g. method colour) */
    className?: string;
}

/**
 * Sharp custom dropdown matching the app chrome (scrim + floating menu).
 * Replaces the native <select> so it inherits the mono / sharp aesthetic.
 */
export function BrunoSelect({
    value,
    options,
    onChange,
    className,
    title,
    align = "left",
    menuWidth,
}: {
    value: string;
    options: BrunoOption[];
    onChange: (value: string) => void;
    className?: string;
    title?: string;
    align?: "left" | "right";
    menuWidth?: number;
}) {
    const [open, setOpen] = useState(false);
    const active = options.find((o) => o.value === value);
    return (
        <div className="bruno-dd">
            <button
                type="button"
                className={`bruno-dd-btn${className ? ` ${className}` : ""}`}
                title={title}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}>
                <span className={`bruno-dd-val${active?.className ? ` ${active.className}` : ""}`}>{active?.label ?? value}</span>
                <IconChevron size={9} className="bruno-dd-chev" />
            </button>
            {open && (
                <>
                    <div className="bruno-dd-scrim" onClick={() => setOpen(false)} />
                    <div
                        className={`bruno-dd-menu${align === "right" ? " right" : ""}`}
                        role="listbox"
                        aria-label={title ?? "Select value"}
                        style={menuWidth ? { minWidth: menuWidth } : undefined}>
                        {options.map((o) => (
                            <button
                                key={o.value}
                                type="button"
                                role="option"
                                aria-selected={o.value === value}
                                className={`bruno-dd-item${o.value === value ? " active" : ""}`}
                                onClick={() => {
                                    onChange(o.value);
                                    setOpen(false);
                                }}>
                                <span className="bruno-dd-check">{o.value === value && <IconCheck size={11} />}</span>
                                <span className={`bruno-dd-item-label${o.className ? ` ${o.className}` : ""}`}>{o.label}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

/** Sharp custom checkbox. */
export function BrunoCheck({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            className={`bruno-check${checked ? " on" : ""}`}
            title={title}
            onClick={() => onChange(!checked)}>
            {checked && <IconCheck size={10} />}
        </button>
    );
}
