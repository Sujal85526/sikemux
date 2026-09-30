import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { browserApi, type AddressSuggestions } from "../api/browser";
import { setNativeViewHoles } from "../state/nativeViews";
import { IconLock, IconSearch } from "../ui/Icons";
import { SiteIcon } from "../ui/SiteIcon";

interface Row {
    url: string;
    title: string;
    detail: string;
    icon: string | null;
    search: boolean;
}

interface Place {
    left: number;
    top: number;
    width: number;
}

/** What the address bar shows while nobody is editing it: the site alone. */
function siteOf(url: string): { host: string; secure: boolean } | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return { host: parsed.host.replace(/^www\./, ""), secure: parsed.protocol === "https:" };
    } catch {
        return null;
    }
}

function rowsFor(typed: string, found: AddressSuggestions | null, suffix: string): Row[] {
    if (!found || !typed.trim()) return [];
    const searchRow: Row = { url: found.searchUrl, title: typed, detail: "Google Search", icon: null, search: true };
    const rows: Row[] = [];
    if (found.completion && suffix) {
        const { url, title, icon } = found.completion;
        rows.push({ url, title, detail: typed + suffix, icon, search: false });
    } else if (found.searches) {
        rows.push(searchRow);
    } else {
        rows.push({ url: typed, title: typed, detail: "", icon: null, search: false });
    }
    for (const page of found.pages)
        rows.push({ url: page.url, title: page.title || page.address, detail: page.address, icon: page.icon, search: false });
    if (!rows[0].search && found.searches) rows.push(searchRow);
    return rows;
}

/** Bolds each typed word where it appears, the way the bar found the row. */
function Marked({ text, words }: { text: string; words: string[] }) {
    if (!words.length) return <>{text}</>;
    const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    return <>{text.split(pattern).map((part, index) => (index % 2 ? <b key={index}>{part}</b> : part))}</>;
}

/**
 * The address field, which finishes a remembered site in place as it is typed
 * and lists the pages that match below it.
 */
export function AddressBar({ tabId, pageAddress, onGo }: { tabId: string | undefined; pageAddress: string; onGo: (url: string) => void }) {
    const listId = useId();
    const fieldRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const menuRef = useRef<HTMLUListElement>(null);
    const asked = useRef(0);
    /* The bar follows the page until someone starts typing in it, and goes back
       to following once they are done. Pages move on their own — a click inside
       a web app changes the address — and that must not eat a half-typed one. */
    const [typed, setTyped] = useState<string | null>(null);
    const [found, setFound] = useState<AddressSuggestions | null>(null);
    /* Only typing forward is finished for you; deleting the finished part must
       not bring it straight back. */
    const [completing, setCompleting] = useState(false);
    const [selected, setSelected] = useState(0);
    const [place, setPlace] = useState<Place | null>(null);

    const completion = found?.completion?.address ?? "";
    const suffix =
        completing && typed && completion.length > typed.length && completion.toLowerCase().startsWith(typed.toLowerCase())
            ? completion.slice(typed.length)
            : "";
    const rows = typed === null ? [] : rowsFor(typed, found, suffix);
    const open = rows.length > 1 || !!suffix;
    const choice = open ? rows[selected] : undefined;
    const words = (typed ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const site = typed === null ? siteOf(pageAddress) : null;
    const value =
        typed === null ? pageAddress : selected > 0 && choice ? (choice.search ? choice.title : choice.detail || choice.url) : typed + suffix;

    const reset = useCallback(() => {
        asked.current += 1;
        setTyped(null);
        setFound(null);
        setSelected(0);
    }, []);

    useEffect(() => {
        asked.current += 1;
        setTyped(null);
        setFound(null);
        setSelected(0);
    }, [tabId]);

    const edit = (text: string, forward: boolean) => {
        setTyped(text);
        setCompleting(forward);
        setSelected(0);
        const ask = ++asked.current;
        if (!text.trim()) return setFound(null);
        void browserApi
            .suggest(text)
            .then((next) => {
                if (ask === asked.current) setFound(next);
            })
            .catch(() => {});
    };

    const go = (url: string) => {
        reset();
        onGo(url);
    };

    useLayoutEffect(() => {
        if (suffix && selected === 0) inputRef.current?.setSelectionRange(value.length - suffix.length, value.length);
    }, [suffix, selected, value]);

    useLayoutEffect(() => {
        const field = fieldRef.current;
        if (!open || !field) return setPlace(null);
        const rect = field.getBoundingClientRect();
        const next = { left: rect.left, top: rect.bottom + 4, width: rect.width };
        setPlace((previous) =>
            previous && previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next,
        );
    }, [open, rows.length]);

    /* The page under the list is a native view that paints over the app, so it
       gives up the list's box for as long as the list is open. */
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!menu || !place) return setNativeViewHoles(menuRef, []);
        const radius = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 0;
        setNativeViewHoles(menuRef, [{ x: place.left, y: place.top, width: menu.offsetWidth, height: menu.offsetHeight, radius }]);
    }, [place, rows.length]);
    useEffect(() => () => setNativeViewHoles(menuRef, []), []);

    /* The field's own blur misses some ways of going elsewhere: a click on
       something that takes no focus, and a click on the page, which is a view of
       its own and only shows up as the window losing focus. */
    useEffect(() => {
        if (!open) return;
        const inside = (target: EventTarget | null) =>
            target instanceof Node && (!!fieldRef.current?.contains(target) || !!menuRef.current?.contains(target));
        const leave = () => {
            inputRef.current?.blur();
            reset();
        };
        const leaveUnlessInside = (event: Event) => {
            if (!inside(event.target)) leave();
        };
        document.addEventListener("pointerdown", leaveUnlessInside, true);
        document.addEventListener("focusin", leaveUnlessInside);
        window.addEventListener("blur", leave);
        return () => {
            document.removeEventListener("pointerdown", leaveUnlessInside, true);
            document.removeEventListener("focusin", leaveUnlessInside);
            window.removeEventListener("blur", leave);
        };
    }, [open, reset]);

    return (
        <div ref={fieldRef} className="browser-address-field">
            <input
                ref={inputRef}
                className="browser-address"
                aria-label="Address and search"
                aria-autocomplete="both"
                aria-controls={open ? listId : undefined}
                aria-activedescendant={open ? `${listId}-${selected}` : undefined}
                value={value}
                placeholder="Search or enter address"
                spellCheck={false}
                autoComplete="off"
                onFocus={(event) => event.currentTarget.select()}
                onBlur={reset}
                onChange={(event) => {
                    const input = event.currentTarget;
                    const kind = (event.nativeEvent as InputEvent).inputType ?? "";
                    edit(input.value, !kind.startsWith("delete") && input.selectionStart === input.value.length);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.currentTarget.blur();
                    } else if (event.key === "Enter") {
                        event.preventDefault();
                        go(choice?.url ?? value);
                    } else if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        setSelected((index) => Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))));
                    }
                }}
            />
            {site && (
                <span className="browser-address-site" aria-hidden="true">
                    {site.secure && <IconLock size={11} />}
                    <span>{site.host}</span>
                </span>
            )}
            {open &&
                place &&
                createPortal(
                    <ul
                        ref={menuRef}
                        id={listId}
                        className="address-suggestions"
                        role="listbox"
                        aria-label="Suggestions"
                        style={{ left: place.left, top: place.top, width: place.width }}>
                        {rows.map((row, index) => (
                            <li
                                key={`${row.search}-${row.url}`}
                                id={`${listId}-${index}`}
                                role="option"
                                aria-selected={index === selected}
                                className={index === selected ? "selected" : undefined}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => go(row.url)}>
                                <span className="address-suggestion-icon">{row.search ? <IconSearch size={13} /> : <SiteIcon src={row.icon} />}</span>
                                <span className="address-suggestion-text">
                                    <span className="address-suggestion-title">
                                        <Marked text={row.title} words={words} />
                                    </span>
                                    {row.detail && (
                                        <span className="address-suggestion-detail">
                                            {" — "}
                                            {row.search ? row.detail : <Marked text={row.detail} words={words} />}
                                        </span>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>,
                    document.body,
                )}
        </div>
    );
}
