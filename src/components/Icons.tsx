// Crisp inline SVG icons — stroke-based, currentColor, 16px grid.
interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 16,
  className,
  children,
  fill = "none",
}: IconProps & { children: React.ReactNode; fill?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// The wordmark: a square carved into four panes — a multiplexer.
export function Logo({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3" />
      <path d="M8 1.6v12.8M1.6 8h12.8" />
    </Svg>
  );
}

export function IconPlus({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function IconSearch({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4 14 14" />
    </Svg>
  );
}

export function IconEditor({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3M9.3 3.4 6.7 12.6" />
    </Svg>
  );
}

export function IconRun({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className} fill="currentColor">
      <path d="M4.7 3.4 12.4 8l-7.7 4.6z" stroke="none" />
    </Svg>
  );
}

export function IconGit({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="4.6" cy="3.6" r="1.7" />
      <circle cx="4.6" cy="12.4" r="1.7" />
      <circle cx="11.4" cy="3.6" r="1.7" />
      <path d="M4.6 5.3v5.4M4.6 6.6c0 3 6.8 1.2 6.8-1.3" />
    </Svg>
  );
}

export function IconAgent({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 1.8c.5 3.3 2.9 5.7 6.2 6.2-3.3.5-5.7 2.9-6.2 6.2-.5-3.3-2.9-5.7-6.2-6.2C5.1 7.5 7.5 5.1 8 1.8Z" />
    </Svg>
  );
}

export function IconWindow({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2.4" />
    </Svg>
  );
}

export function IconCommand({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 4.6 6 8l-3 3.4M7.6 11.4H13" />
    </Svg>
  );
}

export function IconFolder({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2 4.4h4l1.6 2H14v7.2H2z" />
    </Svg>
  );
}

export function IconChevron({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  );
}

export function IconPanelLeft({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.4" />
      <path d="M5.8 2.6v10.8" />
    </Svg>
  );
}

export function IconPanelRight({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2.4" />
      <path d="M10.2 2.6v10.8" />
    </Svg>
  );
}

export function IconZoom({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2.6 6.2V2.6h3.6M13.4 9.8v3.6H9.8M9.8 2.6h3.6v3.6M6.2 13.4H2.6V9.8" />
    </Svg>
  );
}

export function IconBolt({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className} fill="currentColor">
      <path d="M9 1.5 3.6 9H7.3l-.8 5.5L12.4 6.9H8.5z" stroke="none" />
    </Svg>
  );
}

// Picks the glyph for a window by its name.
export function WindowIcon({ name, size }: { name: string; size?: number }) {
  if (name === "nvim") return <IconEditor size={size} />;
  if (name === "run") return <IconRun size={size} />;
  if (name === "git") return <IconGit size={size} />;
  if (name === "agent") return <IconAgent size={size} />;
  return <IconWindow size={size} />;
}
