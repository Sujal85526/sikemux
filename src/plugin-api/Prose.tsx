import { memo, type ReactNode } from "react";
import { invokeCommand } from "../api/invoke";
import { Markdown as MarkdownText, MARKDOWN_GFM, type MarkdownComponents } from "../markdown/Markdown";
import { swallow } from "../state/toast";

/** Only addresses a browser can open; anything stranger is shown as plain text. */
function safeHref(href: string): string | null {
    const trimmed = href.trim();
    return /^https?:\/\//iu.test(trimmed) ? trimmed : null;
}

function ProseLink({ href, children }: { href: string; children: ReactNode }) {
    const target = safeHref(href);
    if (!target) return <>{children}</>;
    return (
        <a
            href={target}
            onClick={(event) => {
                // The webview must not navigate away from the app.
                event.preventDefault();
                void invokeCommand<void>("open_url", { url: target, app: null, shortcut: null }).catch(swallow("open the link"));
            }}>
            {children}
        </a>
    );
}

const COMPONENTS: MarkdownComponents = { link: ProseLink };

/**
 * Prose somebody else wrote, such as a release's notes or a comment, drawn by
 * the app's own markdown reader with embedded HTML left out and links handed
 * to the browser.
 */
export const Markdown = memo(function Markdown({ children, className = "prose" }: { children: string; className?: string }) {
    return (
        <div className={className}>
            <MarkdownText text={children} options={MARKDOWN_GFM} components={COMPONENTS} />
        </div>
    );
});
