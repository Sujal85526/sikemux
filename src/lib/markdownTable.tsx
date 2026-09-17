import { isValidElement, type ReactNode } from "react";

function textOf(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
    return "";
}

/* A markdown table always carries a header row, so a table written without
   column labels arrives with blank cells: drop the row instead of ruling it. */
export function MarkdownTableHead({ children }: { children?: ReactNode }) {
    if (!textOf(children).trim()) return null;
    return <thead>{children}</thead>;
}
