import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TreeContextMenu, type CtxItem } from "./FileTree";
import { IconClose } from "./Icons";

/**
 * One normalized tab. Every tab strip in the app (editor files, agents,
 * terminals, Bruno requests) describes its tabs as these, so selection,
 * closing, the dirty dot, accessories and the right-click menu all behave
 * identically. A new group only has to map its state into `TabDescriptor[]`.
 */
export interface TabDescriptor {
    /** Stable identity — used as the React key and passed to onSelect/onClose. */
    id: string;
    label: string;
    /** Leading glyph/badge rendered before the label (FileIcon, agent glyph, method badge…). */
    icon?: ReactNode;
    /** Show the unsaved-changes dot. */
    dirty?: boolean;
    active?: boolean;
    /** Defaults to whether `onClose` is provided; set false to pin a tab open. */
    closable?: boolean;
    title?: string;
    /** Extra control rendered just before the close button (e.g. a per-tab status badge). */
    accessory?: ReactNode;
}

export type TabVariant = "editor" | "agent" | "bruno";

interface TabBarProps {
    variant: TabVariant;
    tabs: TabDescriptor[];
    onSelect: (id: string) => void;
    onClose?: (id: string) => void;
    /** Build the right-click menu for a tab. Omit to disable the context menu. */
    buildMenu?: (id: string) => CtxItem[];
    onAdd?: () => void;
    addIcon?: ReactNode;
    addTitle?: string;
    style?: CSSProperties;
}

export function TabBar({ variant, tabs, onSelect, onClose, buildMenu, onAdd, addIcon, addTitle, style }: TabBarProps) {
    const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
    const menuItems = menu && buildMenu ? buildMenu(menu.id) : null;

    return (
        <div className={`tabbar v-${variant}`} style={style} role="tablist">
            {tabs.map((t) => {
                const closable = t.closable ?? !!onClose;
                return (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={t.active ?? false}
                        title={t.title}
                        className={`tab${t.active ? " active" : ""}`}
                        onClick={() => onSelect(t.id)}
                        onContextMenu={
                            buildMenu
                                ? (e) => {
                                      e.preventDefault();
                                      setMenu({ x: e.clientX, y: e.clientY, id: t.id });
                                  }
                                : undefined
                        }>
                        {t.icon}
                        <span className="tab-label">{t.label}</span>
                        {t.dirty && <span className="tab-dot" />}
                        {t.accessory}
                        {closable && onClose && (
                            <span
                                className="tab-x"
                                title="Close"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose(t.id);
                                }}>
                                <IconClose size={11} />
                            </span>
                        )}
                    </button>
                );
            })}
            {onAdd && (
                <button type="button" className="tab-add" title={addTitle} onClick={onAdd}>
                    {addIcon}
                </button>
            )}
            {menu && menuItems && <TreeContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
        </div>
    );
}
