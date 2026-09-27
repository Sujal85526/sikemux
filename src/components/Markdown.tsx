import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invokeCommand } from "../api/invoke";
import { swallow } from "../state/toast";

/** Only addresses a browser can open; anything stranger is shown as plain text. */
function safeHref(href: string | undefined): string | null {
    if (!href) return null;
    const trimmed = href.trim();
    return /^https?:\/\//iu.test(trimmed) ? trimmed : null;
}

function ProseLink({ href, children }: { href?: string; children?: ReactNode }) {
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

const COMPONENTS = { a: ProseLink };
const PLUGINS = [remarkGfm];

/**
 * Prose somebody else wrote — a release's notes, a pull request's description,
 * a comment. Rendered rather than shown as the markdown it arrived as, with
 * embedded HTML skipped and links handed to the browser.
 *
 * Parsing the source is the expensive part and the source almost never
 * changes, so a render caused by something else nearby does not redo it.
 */
export const Markdown = memo(function Markdown({ children, className = "prose" }: { children: string; className?: string }) {
    return (
        <div className={className}>
            <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} skipHtml>
                {children}
            </ReactMarkdown>
        </div>
    );
});
