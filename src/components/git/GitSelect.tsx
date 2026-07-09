import { useState } from "react";
import { IconChevron } from "../Icons";

export function GitSelect({
    value,
    label,
    options,
    onSelect,
    title,
    width,
}: {
    value: string;
    label: string;
    options: { value: string; label: string }[];
    onSelect: (value: string) => void;
    title?: string;
    width?: number;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className="git-dd">
            <button
                type="button"
                className="git-dd-btn"
                style={width ? { width } : undefined}
                title={title}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}>
                <span className="git-dd-val">{label}</span>
                <IconChevron size={9} className="git-dd-chev" />
            </button>
            {open && (
                <>
                    <div className="git-dd-scrim" onClick={() => setOpen(false)} />
                    <div className="git-dd-menu" role="listbox" aria-label={title ?? label}>
                        {options.map((o) => (
                            <button
                                key={o.value}
                                type="button"
                                role="option"
                                aria-selected={o.value === value}
                                className={`git-dd-item${o.value === value ? " active" : ""}`}
                                onClick={() => {
                                    onSelect(o.value);
                                    setOpen(false);
                                }}>
                                <span className="git-dd-check">{o.value === value ? "✓" : ""}</span>
                                <span className="git-dd-item-label">{o.label}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
