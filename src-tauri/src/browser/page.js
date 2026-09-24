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
    const selectContents = (element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.select();
            return element.value.length > 0;
        }
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return compact(element.textContent).length > 0;
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
        point(index) {
            const element = pick(index);
            element.scrollIntoView({ block: "center", inline: "center" });
            const point = centre(element);
            const top = document.elementFromPoint(point.x, point.y);
            const covered = top && !element.contains(top) && !top.contains(element) ? label(top) || top.tagName.toLowerCase() : null;
            return { x: point.x, y: point.y, label: label(element), covered };
        },
        focus(index, text) {
            const element = index == null ? document.activeElement : pick(index);
            if (!element || (element === document.body && !element.isContentEditable)) throw new Error("nothing is focused; pass an element index");
            if (element instanceof HTMLSelectElement) {
                const option = [...element.options].find((option) => option.value === text || compact(option.textContent) === compact(text));
                if (!option) throw new Error(`no option matching "${text}"`);
                element.value = option.value;
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
                return { selected: option.value };
            }
            if (index == null) return { replacing: false };
            element.scrollIntoView({ block: "center", inline: "center" });
            element.focus({ preventScroll: true });
            return { replacing: selectContents(element) };
        },
        // WebKit only acts on a bare pointer move while its page is active, so
        // when the real move left nothing hovered the page is told by hand.
        hover(x, y) {
            const target = document.elementFromPoint(x, y);
            if (!target) return { hovered: null };
            if (target.matches(":hover")) return { hovered: label(target) || target.tagName.toLowerCase() };
            const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
            const entered = { ...init, bubbles: false, cancelable: false };
            const path = [];
            for (let node = target; node; node = node.parentElement) path.unshift(node);
            target.dispatchEvent(new PointerEvent("pointerover", init));
            target.dispatchEvent(new MouseEvent("mouseover", init));
            for (const node of path) {
                node.dispatchEvent(new PointerEvent("pointerenter", entered));
                node.dispatchEvent(new MouseEvent("mouseenter", entered));
            }
            target.dispatchEvent(new PointerEvent("pointermove", init));
            target.dispatchEvent(new MouseEvent("mousemove", init));
            return { hovered: label(target) || target.tagName.toLowerCase(), note: "Sikemux is in the background, so the page got hover events but CSS :hover styles do not apply" };
        },
        valueOf(index) {
            const element = index == null ? document.activeElement : pick(index);
            if (!element) return { value: null };
            const value = "value" in element && typeof element.value === "string" ? element.value : element.innerText;
            return { value: compact(value).slice(0, 400) };
        },
        // A draggable element hands its drag to the system, which a synthesized
        // mouse cannot steer, so these drags are played out as DOM events.
        html5Drag(fromX, fromY, toX, toY) {
            const grabbed = document.elementFromPoint(fromX, fromY);
            const source = grabbed && grabbed.closest('[draggable="true"], a[href]:not([draggable="false"]), img:not([draggable="false"])');
            if (!source) return { html5: false };
            const target = document.elementFromPoint(toX, toY);
            if (!target) throw new Error("nothing is under the drop point");
            const data = new DataTransfer();
            const fire = (element, type, x, y) => {
                const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: data };
                const event = typeof DragEvent === "function" ? new DragEvent(type, init) : new MouseEvent(type, init);
                if (!event.dataTransfer) Object.defineProperty(event, "dataTransfer", { value: data });
                return element.dispatchEvent(event);
            };
            if (!fire(source, "dragstart", fromX, fromY)) return { html5: true, dropped: false, note: "the page cancelled the drag" };
            fire(target, "dragenter", toX, toY);
            const refused = fire(target, "dragover", toX, toY);
            if (!refused) fire(target, "drop", toX, toY);
            fire(source, "dragend", toX, toY);
            return { html5: true, dropped: !refused, onto: label(target) || target.tagName.toLowerCase() };
        },
        scroll(deltaY, index) {
            const target = index == null ? null : pick(index);
            if (target) target.scrollBy({ top: deltaY, behavior: "instant" });
            else scrollBy({ top: deltaY, behavior: "instant" });
            return { y: Math.round(target ? target.scrollTop : scrollY) };
        },
        network(limit, filter) {
            const recorder = window.__sikemuxNet;
            if (!recorder) return { recording: false, note: "this tab has not recorded anything; reload the page and retry the action" };
            const all = recorder.entries();
            const needle = filter ? String(filter).toLowerCase() : "";
            const matched = needle ? all.filter((entry) => entry.url.toLowerCase().includes(needle)) : all;
            const keep = Math.max(1, Math.min(100, Number(limit) || 20));
            return { recording: true, url: location.href, recorded: all.length, matched: matched.length, calls: matched.slice(-keep) };
        },
        console(limit, errorsOnly) {
            const recorder = window.__sikemuxConsole;
            if (!recorder) return { recording: false, note: "this tab has not recorded anything; reload the page and retry the action" };
            const all = recorder.entries();
            const matched = errorsOnly ? all.filter((entry) => entry.level !== "log" && entry.level !== "info" && entry.level !== "debug") : all;
            const keep = Math.max(1, Math.min(200, Number(limit) || 50));
            return { recording: true, url: location.href, recorded: all.length, matched: matched.length, messages: matched.slice(-keep) };
        },
        extract(selector) {
            const roots = selector ? [...document.querySelectorAll(selector)] : [document.body];
            if (selector && roots.length === 0) throw new Error(`nothing matches "${selector}"`);
            const text = compact(roots.map((root) => root?.innerText || "").join("\n\n"));
            return { url: location.href, title: document.title, text: text.length > 40000 ? `${text.slice(0, 40000)}…` : text, matches: roots.length };
        },
    };
})();
