import { AGENTS } from "./world/workspace";

const tab = (id: string, url: string, title: string, active: boolean) => ({
  id,
  url,
  title,
  active,
  loading: false,
  canGoBack: true,
  canGoForward: false,
  favicon: null,
  acting: false,
});

export const BROWSER_TABS: Record<
  string,
  { tabs: ReturnType<typeof tab>[]; activeTabId: string }
> = {
  [AGENTS.hero.id]: {
    tabs: [
      tab(
        "tab-site",
        "http://localhost:4321/",
        "Sikemux: one window for the whole project",
        true,
      ),
      tab(
        "tab-docs",
        "https://docs.astro.build/en/guides/images/",
        "Images | Docs",
        false,
      ),
    ],
    activeTabId: "tab-site",
  },
};

const PAGES: Record<string, string> = {
  [AGENTS.hero.id]: "/__site/index.html",
};
const frames = new Map<string, HTMLIFrameElement>();

// The real browser is a native view laid over the pane, so its stand-in floats over the page the same way.
export function placeBrowserPage(
  agentId: string,
  bounds: DOMRectInit | null,
): void {
  let frame = frames.get(agentId);
  if (!bounds) {
    if (frame) frame.style.display = "none";
    return;
  }
  if (!frame) {
    frame = document.createElement("iframe");
    frame.src = PAGES[agentId] ?? "about:blank";
    frame.dataset.showcaseBrowser = agentId;
    Object.assign(frame.style, {
      position: "fixed",
      border: "0",
      zIndex: "5",
      background: "#100e16",
    });
    document.body.append(frame);
    frames.set(agentId, frame);
  }
  Object.assign(frame.style, {
    display: "block",
    left: `${bounds.x}px`,
    top: `${bounds.y}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
}
