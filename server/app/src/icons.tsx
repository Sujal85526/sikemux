import type { ReactNode } from "react";

function Stroke({
  size = 16,
  children,
}: {
  size?: number;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -30 420 420"
      fill="currentColor"
      aria-hidden="true"
    >
      <polygon points="257,72 331,29 331,114" />
      <polygon points="98,199 172,241 98,284" />
      <path d="M108 54C100 72 96 90 98 104C100 119 106 133 121 144C129 151 139 158 151 164L286 223C297 228 306 236 313 245C317 250 320 255 321 259C327 246 331 229 331 209C330 201 328 194 324 189C319 181 314 175 308 169C300 162 290 155 278 149L143 90C137 87 132 84 128 80C122 76 117 71 108 54Z" />
    </svg>
  );
}

export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 009 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71A5.41 5.41 0 013.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.04l3-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.98 8.98 0 009 0 9 9 0 00.96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

export function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

export function LaptopIcon({ size }: { size?: number }) {
  return (
    <Stroke size={size}>
      <rect x="3" y="3.2" width="10" height="7.3" rx="1.2" />
      <path d="M1.6 12.6h12.8" />
    </Stroke>
  );
}

export function PhoneIcon({ size }: { size?: number }) {
  return (
    <Stroke size={size}>
      <rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.6" />
      <path d="M7.2 11.8h1.6" />
    </Stroke>
  );
}

export function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <Stroke size={18}>
      <path d="M1.6 8s2.3-4 6.4-4 6.4 4 6.4 4-2.3 4-6.4 4S1.6 8 1.6 8Z" />
      <circle cx="8" cy="8" r="1.8" />
      {crossed ? <path d="M2.4 2.4l11.2 11.2" /> : null}
    </Stroke>
  );
}

export function BackIcon() {
  return (
    <Stroke size={16}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </Stroke>
  );
}
