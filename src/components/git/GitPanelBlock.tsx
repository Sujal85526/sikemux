import type { ReactNode } from "react";
import { Badge, Panel, PanelBody, PanelHeader, type PanelAction } from "../Panel";

export type { PanelAction };

/**
 * A git stack panel. Thin wrapper over the shared panel so the git pane keeps
 * its own naming for badges (a `/query` filter and a selection range) while the
 * surface, header and body come from the app vocabulary.
 */
export function GitPanelBlock({
    n,
    label,
    focused,
    onFocus,
    flex,
    extra,
    rangeBadge,
    filterBadge,
    actions,
    children,
}: {
    n: number;
    label: string;
    focused: boolean;
    onFocus: () => void;
    flex: number;
    extra?: ReactNode;
    rangeBadge?: string | null;
    filterBadge?: string | null;
    actions?: PanelAction[];
    children: ReactNode;
}) {
    return (
        <Panel focused={focused} flex={flex} className="git-panel">
            <PanelHeader
                index={n}
                label={label}
                badges={[filterBadge && <Badge tone="accent">/{filterBadge}</Badge>, rangeBadge && <Badge tone="warn">{rangeBadge}</Badge>]}
                actions={actions}
                extra={extra}
                onFocus={onFocus}
            />
            <PanelBody>{children}</PanelBody>
        </Panel>
    );
}
