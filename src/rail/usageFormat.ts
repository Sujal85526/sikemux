import type { AgentUsage, AgentUsageWindow } from "../api/agents";

export function usagePeak(usage: AgentUsage | undefined): number | undefined {
    if (!usage?.windows.length) return undefined;
    return Math.max(...usage.windows.map((window) => Math.max(0, Math.min(100, window.usedPercent))));
}

export function usageTone(percent: number): "steady" | "warm" | "hot" {
    if (percent >= 90) return "hot";
    if (percent >= 70) return "warm";
    return "steady";
}

function resetAtMs(value: AgentUsageWindow["resetsAt"]): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value * 1000 : null;
    if (typeof value !== "string" || !value) return null;
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

export function resetCountdown(value: AgentUsageWindow["resetsAt"], now: number): string {
    const reset = resetAtMs(value);
    if (reset == null) return "reset unknown";
    const minutes = Math.max(0, Math.ceil((reset - now) / 60_000));
    if (minutes === 0) return "resetting now";
    if (minutes < 60) return `reset ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return `reset ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days < 7) return `reset ${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
    return `reset ${new Date(reset).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function resetTitle(value: AgentUsageWindow["resetsAt"]): string {
    const reset = resetAtMs(value);
    return reset == null ? "Reset time unavailable" : `Resets ${new Date(reset).toLocaleString()}`;
}

export function planLabel(plan: string): string {
    return plan
        .split(/[_-]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
