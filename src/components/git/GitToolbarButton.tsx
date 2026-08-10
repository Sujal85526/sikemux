import type { ReactNode } from "react";

export function GitToolbarButton({
    ariaControls,
    ariaExpanded,
    children,
    className,
    count,
    icon,
    kbd,
    onClick,
    title,
}: {
    ariaControls?: string;
    ariaExpanded?: boolean;
    children?: ReactNode;
    className?: string;
    count?: number;
    icon: ReactNode;
    kbd?: string;
    onClick: () => void;
    title: string;
}) {
    return (
        <button
            className={`git-tbtn${className ? ` ${className}` : ""}`}
            type="button"
            aria-controls={ariaControls}
            aria-expanded={ariaExpanded}
            onClick={onClick}
            title={title}>
            {icon}
            {!!count && count > 0 && <span className="git-tbtn-count">{count}</span>}
            {children}
            {kbd && <kbd className="git-kbd">{kbd}</kbd>}
        </button>
    );
}
