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
    const isFrame = (element) => element.tagName === "IFRAME" || element.tagName === "FRAME";
    // A frame from the same site can be read; another site's frame cannot.
    const frameDocument = (frame) => {
        try {
            return frame.contentDocument;
        } catch {
            return null;
        }
    };
    // Where an element's own viewport sits in the tab, summed over every frame
    // it is nested in, so a point inside a frame can be clicked from the top.
    const frameOffset = (element) => {
        let x = 0;
        let y = 0;
        for (let view = element.ownerDocument.defaultView; view && view !== window; ) {
            const frame = view.frameElement;
            if (!frame) break;
            const rect = frame.getBoundingClientRect();
            const style = getComputedStyle(frame);
            x += rect.left + frame.clientLeft + parseFloat(style.paddingLeft);
            y += rect.top + frame.clientTop + parseFloat(style.paddingTop);
            view = frame.ownerDocument.defaultView;
        }
        return { x, y };
    };
    const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        const offset = frameOffset(element);
        return { left: rect.left + offset.x, top: rect.top + offset.y, right: rect.right + offset.x, bottom: rect.bottom + offset.y, width: rect.width, height: rect.height };
    };
    const elementAt = (x, y) => {
        let found = document.elementFromPoint(x, y);
        while (found && isFrame(found)) {
            const inner = frameDocument(found);
            if (!inner || !inner.documentElement) break;
            const offset = frameOffset(inner.documentElement);
            const deeper = inner.elementFromPoint(x - offset.x, y - offset.y);
            if (!deeper) break;
            found = deeper;
        }
        return found;
    };
    const focused = () => {
        let element = document.activeElement;
        while (element && isFrame(element)) {
            const inner = frameDocument(element);
            if (!inner || !inner.activeElement) break;
            element = inner.activeElement;
        }
        return element;
    };
    const describe = (element) => label(element) || element.tagName.toLowerCase();
    const label = (element) =>
        compact(
            element.getAttribute("aria-label") ||
                (element.labels && element.labels[0] && element.labels[0].innerText) ||
                element.placeholder ||
                element.innerText ||
                element.value ||
                element.title ||
                element.alt ||
                (isFrame(element) && element.src ? `frame from ${new URL(element.src, location.href).host}` : "") ||
                "",
        ).slice(0, 96);
    // Open shadow roots and same-site frames hold the controls on many sites;
    // querySelectorAll on the document alone would miss every one of them.
    // Another site's frame is listed whole, to be clicked into.
    const interactive = (root, out) => {
        for (const element of root.querySelectorAll("*")) {
            if (element.matches(INTERACTIVE)) out.push(element);
            if (element.shadowRoot) interactive(element.shadowRoot, out);
            if (isFrame(element)) {
                const inner = frameDocument(element);
                if (inner) interactive(inner, out);
                else out.push(element);
            }
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
        const rect = rectOf(element);
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const selectContents = (element) => {
        if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
            element.select();
            return element.value.length > 0;
        }
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        const selection = element.ownerDocument.defaultView.getSelection();
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
                if (isFrame(element)) parts.push("(another site's frame: its inside cannot be read; click it or use x,y to reach in)");
                if (!inViewport(rectOf(element))) parts.push("[offscreen]");
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
            const top = elementAt(point.x, point.y);
            const covered = top && !element.contains(top) && !top.contains(element) ? describe(top) : null;
            return { x: point.x, y: point.y, label: label(element), covered };
        },
        focus(index, text) {
            const element = index == null ? focused() : pick(index);
            if (!element || (element === element.ownerDocument.body && !element.isContentEditable)) throw new Error("nothing is focused; pass an element index");
            if (element.tagName === "SELECT") {
                const option = [...element.options].find((option) => option.value === text || compact(option.textContent) === compact(text));
                if (!option) throw new Error(`no option matching "${text}"`);
                element.value = option.value;
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
                return { selected: option.value };
            }
            if (index == null) return { replacing: false };
            element.scrollIntoView({ block: "center", inline: "center" });
            if (isFrame(element)) return { replacing: false, clickFirst: centre(element) };
            element.focus({ preventScroll: true });
            return { replacing: selectContents(element) };
        },
        // WebKit only acts on a bare pointer move while its page is active, so
        // when the real move left nothing hovered the page is told by hand.
        hover(x, y) {
            const target = elementAt(x, y);
            if (!target) return { hovered: null };
            if (target.matches(":hover")) return { hovered: describe(target) };
            const offset = frameOffset(target);
            const init = { bubbles: true, cancelable: true, composed: true, clientX: x - offset.x, clientY: y - offset.y, view: target.ownerDocument.defaultView };
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
            return { hovered: describe(target), note: "Sikemux is in the background, so the page got hover events but CSS :hover styles do not apply" };
        },
        valueOf(index) {
            const element = index == null ? focused() : pick(index);
            if (!element || isFrame(element)) return { value: null };
            const value = "value" in element && typeof element.value === "string" ? element.value : element.innerText;
            return { value: compact(value).slice(0, 400) };
        },
        // A draggable element hands its drag to the system, which a synthesized
        // mouse cannot steer, so these drags are played out as DOM events.
        html5Drag(fromX, fromY, toX, toY) {
            const grabbed = elementAt(fromX, fromY);
            const source = grabbed && grabbed.closest('[draggable="true"], a[href]:not([draggable="false"]), img:not([draggable="false"])');
            if (!source) return { html5: false };
            const target = elementAt(toX, toY);
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
            return { html5: true, dropped: !refused, onto: describe(target) };
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
