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
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen((current) => !current);
                }}>
                <span className="git-dd-val">{label}</span>
                <IconChevron size={9} className="git-dd-chev" />
            </button>
            {open && (
                <>
                    <div className="git-dd-scrim" onClick={() => setOpen(false)} />
                    <div className="git-dd-menu" role="listbox" aria-label={title ?? label}>
                        {options.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                role="option"
                                aria-selected={option.value === value}
                                className={`git-dd-item${option.value === value ? " active" : ""}`}
                                onClick={() => {
                                    onSelect(option.value);
                                    setOpen(false);
                                }}>
                                <span className="git-dd-check">{option.value === value ? "✓" : ""}</span>
                                <span className="git-dd-item-label">{option.label}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
