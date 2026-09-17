// Runs inside a browser tab on behalf of the agent. Elements the agent may
// act on are numbered by `state` and looked up by that number afterwards.
(() => {
    if (window.__sikemux) return;
    const INTERACTIVE =
        'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"], [role="textbox"], [role="combobox"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
    const MAX_TEXT = 8000;

    const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const shown = (element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        const style = getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    const inViewport = (rect) => rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    const label = (element) =>
        compact(
            element.getAttribute("aria-label") ||
                (element.labels && element.labels[0] && element.labels[0].innerText) ||
                element.placeholder ||
                element.innerText ||
                element.value ||
                element.title ||
                element.alt ||
                "",
        ).slice(0, 96);
    // Open shadow roots hold the controls on many modern sites; querySelectorAll
    // alone would miss every one of them.
    const interactive = (root, out) => {
        for (const element of root.querySelectorAll("*")) {
            if (element.matches(INTERACTIVE)) out.push(element);
            if (element.shadowRoot) interactive(element.shadowRoot, out);
        }
        return out;
    };
    const refs = () => window.__sikemuxRefs || [];
    const pick = (index) => {
        const element = refs()[index];
        if (!element || !element.isConnected) throw new Error(`no element [${index}]; call browser_state again`);
        return element;
    };
    const centre = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const mouse = (element, type, point) =>
        element.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, button: 0, buttons: type === "mouseup" ? 0 : 1 }),
        );
    const pointer = (element, type, point) =>
        element.dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1 }),
        );
    const keyInit = (key) => {
        const named = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };
        const code = named[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        return { key, code: key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
    };
    const setValue = (element, text) => {
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
        const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(element, text);
        else if (element.isContentEditable) element.textContent = text;
        else element.value = text;
    };

    window.__sikemux = {
        state() {
            const list = [];
            const elements = [];
            for (const element of interactive(document, [])) {
                if (!shown(element)) continue;
                const index = elements.push(element) - 1;
                const tag = element.tagName.toLowerCase();
                const parts = [`[${index}]`, `<${tag}${element.type ? ` type=${element.type}` : ""}${element.name ? ` name=${compact(element.name)}` : ""}>`];
                const text = label(element);
                if (text) parts.push(text);
                if (tag === "a") parts.push(`(${compact(element.getAttribute("href")).slice(0, 80)})`);
                if (element.checked) parts.push("[checked]");
                if (element.disabled) parts.push("[disabled]");
                if (!inViewport(element.getBoundingClientRect())) parts.push("[offscreen]");
                list.push(parts.join(" "));
            }
            window.__sikemuxRefs = elements;
            const text = compact(document.body ? document.body.innerText : "");
            return {
                url: location.href,
                title: document.title,
                elements: list.join("\n"),
                text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
                scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
            };
        },
        click(index) {
            const element = pick(index);
            element.scrollIntoView({ block: "center", inline: "center" });
            const point = centre(element);
            const target = document.elementFromPoint(point.x, point.y) || element;
            const actual = target.contains(element) || element.contains(target) ? target : element;
            pointer(actual, "pointerdown", point);
            mouse(actual, "mousedown", point);
            if (typeof element.focus === "function") element.focus({ preventScroll: true });
            pointer(actual, "pointerup", point);
            mouse(actual, "mouseup", point);
            actual.click();
            return { clicked: label(element), url: location.href };
        },
        type(index, text, submit) {
            const element = index == null ? document.activeElement : pick(index);
            if (!element || element === document.body) throw new Error("nothing is focused; pass an element index");
            element.focus({ preventScroll: true });
            if (element instanceof HTMLSelectElement) {
                const option = [...element.options].find((option) => option.value === text || compact(option.textContent) === compact(text));
                if (!option) throw new Error(`no option matching "${text}"`);
                element.value = option.value;
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
                return { selected: option.value };
            }
            element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
            setValue(element, text);
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            if (submit) this.press("Enter");
            return { typed: text.length, submitted: Boolean(submit) };
        },
        press(key) {
            const element = document.activeElement || document.body;
            const init = keyInit(key);
            const down = element.dispatchEvent(new KeyboardEvent("keydown", init));
            const pressed = key.length === 1 || key === "Enter" ? element.dispatchEvent(new KeyboardEvent("keypress", init)) : true;
            element.dispatchEvent(new KeyboardEvent("keyup", init));
            if (key === "Enter" && down && pressed) {
                const form = element.form || element.closest?.("form");
                if (form && !(element instanceof HTMLTextAreaElement)) {
                    if (typeof form.requestSubmit === "function") form.requestSubmit();
                    else form.submit();
                    return { pressed: key, submitted: true };
                }
            }
            return { pressed: key, submitted: false };
        },
        scroll(deltaY, index) {
            const target = index == null ? null : pick(index);
            if (target) target.scrollBy({ top: deltaY, behavior: "instant" });
            else scrollBy({ top: deltaY, behavior: "instant" });
            return { y: Math.round(target ? target.scrollTop : scrollY) };
        },
        extract(selector) {
            const roots = selector ? [...document.querySelectorAll(selector)] : [document.body];
            if (selector && roots.length === 0) throw new Error(`nothing matches "${selector}"`);
            const text = compact(roots.map((root) => root?.innerText || "").join("\n\n"));
            return { url: location.href, title: document.title, text: text.length > 40000 ? `${text.slice(0, 40000)}…` : text, matches: roots.length };
        },
    };
})();
