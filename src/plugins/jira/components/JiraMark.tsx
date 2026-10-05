/** Jira's mark: three stacked tiles, each pointing to the next. */
export function JiraMark({ size = 16, className, color = "#2684FF" }: { size?: number; className?: string; color?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
            <path
                fill={color}
                d="M22.16 11.1 13.24 2.19 12.37 1.32 5.66 8.03 2.59 11.1a.82.82 0 0 0 0 1.16l6.14 6.14L12.37 22l6.71-6.72.1-.1 2.98-2.97a.82.82 0 0 0 0-1.16zM12.37 14.75 9.3 11.68l3.07-3.07 3.07 3.07z"
            />
        </svg>
    );
}
