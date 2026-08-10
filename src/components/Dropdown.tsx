import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconCheck, IconChevron } from "./Icons";
import "../styles/dropdown.css";

export interface DropdownOption {
    value: string;
    label: string;
    /** Secondary line under the label — the model id behind an alias, a safety detail. */
    detail?: string;
    /** Extra class applied to the label (e.g. method colour). */
    className?: string;
}

/**
 * The app's dropdown: sharp button, scrim, floating menu. Used everywhere a
 * native <select> would otherwise drag its platform chrome into the UI.
 */
export function Dropdown({
    value,
    options,
    onChange,
    label,
    icon,
    className,
    title,
    disabled,
    align = "left",
    menuWidth,
}: {
    value: string;
    options: readonly DropdownOption[];
    onChange: (value: string) => void;
    /** Accessible name for the control; falls back to `title`. */
    label?: string;
    /** Leading glyph rendered inside the button. */
    icon?: ReactNode;
    className?: string;
    title?: string;
    disabled?: boolean;
    align?: "left" | "right";
    menuWidth?: number;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const active = options.find((o) => o.value === value);

    // Escape closes the menu without letting the key reach the pane behind it,
    // which would otherwise dismiss the whole page.
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            rootRef.current?.querySelector<HTMLButtonElement>(".dd-btn")?.focus();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [open]);

    return (
        <div className="dd" ref={rootRef}>
            <button
                type="button"
                className={`dd-btn${className ? ` ${className}` : ""}`}
                title={title}
                aria-label={label ?? title}
                aria-haspopup="listbox"
                aria-expanded={open}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}>
                {icon && (
                    <span className="dd-icon" aria-hidden="true">
                        {icon}
                    </span>
                )}
                <span className={`dd-val${active?.className ? ` ${active.className}` : ""}`}>{active?.label ?? value}</span>
                <IconChevron size={9} className="dd-chev" />
            </button>
            {open && (
                <>
                    <div className="dd-scrim" onClick={() => setOpen(false)} />
                    <div
                        className={`dd-menu${align === "right" ? " right" : ""}`}
                        role="listbox"
                        aria-label={label ?? title}
                        style={menuWidth ? { minWidth: menuWidth } : undefined}>
                        {options.map((o) => (
                            <button
                                key={o.value}
                                type="button"
                                role="option"
                                aria-selected={o.value === value}
                                className={`dd-item${o.value === value ? " active" : ""}`}
                                onClick={() => {
                                    onChange(o.value);
                                    setOpen(false);
                                }}>
                                <span className="dd-check">{o.value === value && <IconCheck size={11} />}</span>
                                <span className={`dd-item-label${o.className ? ` ${o.className}` : ""}`}>
                                    {o.label}
                                    {o.detail && <small>{o.detail}</small>}
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
