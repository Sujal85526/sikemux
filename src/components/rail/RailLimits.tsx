import { useEffect, useState } from "react";
import type { AgentUsage, AgentUsageWindow } from "../../api/agents";
import type { ResourceHandle } from "../../state/resources";
import type { AgentType } from "../../state/types";
import { IconRefresh } from "../Icons";
import { Tooltip } from "../Tooltip";

export type UsageAgentType = "claude" | "codex";

export function isUsageAgent(type: AgentType | null | undefined): type is UsageAgentType {
    return type === "claude" || type === "codex";
}

function usageTone(percent: number): "steady" | "warm" | "hot" {
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

/**
 * How long is left, and nothing else.
 *
 * It used to read "reset 2d 13h". The column is a countdown either way, and the
 * word was the widest thing on a row that now has to share one line with a
 * label, a percentage and a gauge.
 */
function resetCountdown(value: AgentUsageWindow["resetsAt"], now: number): string {
    const reset = resetAtMs(value);
    if (reset == null) return "—";
    const minutes = Math.max(0, Math.ceil((reset - now) / 60_000));
    if (minutes === 0) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days < 7) return `${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
    return new Date(reset).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function resetTitle(value: AgentUsageWindow["resetsAt"]): string {
    const reset = resetAtMs(value);
    return reset == null ? "Reset time unavailable" : `Resets ${new Date(reset).toLocaleString()}`;
}

function planLabel(plan: string): string {
    return plan
        .split(/[_-]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

/**
 * What the plan has left, in one line per window.
 *
 * It was two rows for each of three windows — a name and a countdown on one,
 * a percentage and a gauge on the next — which made it the tallest block in a
 * rail that now has a chat log to fit as well. Everything on the row is short,
 * so the second line was buying nothing.
 */
export function RailLimits({ provider, usage, label }: { provider: UsageAgentType; usage: ResourceHandle<AgentUsage>; label?: string }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    const providerLabel = label ?? (provider === "claude" ? "Claude" : "Codex");
    const windows = usage.data?.windows ?? [];
    const emptyCopy =
        usage.status === "loading"
            ? "reading plan limits…"
            : usage.status === "error"
              ? "Could not read plan limits. Refresh to try again."
              : (usage.data?.unavailableReason ?? "This account did not report plan limits.");

    return (
        <section className={`agent-usage ${provider}`} aria-label={`${providerLabel} plan limits`}>
            <div className="panel-head agent-usage-head">
                <span className="panel-label">Limits</span>
                <span className="panel-rule" />
                {usage.data?.plan && <span className="agent-usage-plan">{planLabel(usage.data.plan)}</span>}
                <Tooltip label={`Refresh ${providerLabel} plan limits`}>
                    <button
                        type="button"
                        className="rail-group-add"
                        aria-label={`Refresh ${providerLabel} plan limits`}
                        disabled={usage.status === "loading"}
                        onClick={() => void usage.refresh()}>
                        <IconRefresh size={11} />
                    </button>
                </Tooltip>
            </div>

            {windows.length > 0 ? (
                windows.map((window, index) => {
                    const percent = Math.max(0, Math.min(100, window.usedPercent));
                    const rounded = Math.round(percent);
                    return (
                        <Tooltip
                            key={`${window.label}:${String(window.resetsAt)}:${index}`}
                            side="left"
                            label={`${window.label}: ${rounded}% used. ${resetTitle(window.resetsAt)}`}>
                            <div className="agent-usage-row" data-tone={usageTone(percent)}>
                                <span className="agent-usage-name">{window.label}</span>
                                <span className="agent-usage-pct">
                                    {rounded}
                                    <i>%</i>
                                </span>
                                <span
                                    className="agent-usage-track"
                                    role="meter"
                                    aria-label={`${window.label} usage`}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={rounded}>
                                    <span className="agent-usage-fill" style={{ width: `${percent}%` }} />
                                </span>
                                <span className="agent-usage-reset">{resetCountdown(window.resetsAt, now)}</span>
                            </div>
                        </Tooltip>
                    );
                })
            ) : (
                <div className="agent-usage-empty" data-loading={usage.status === "loading" ? "true" : "false"}>
                    {emptyCopy}
                </div>
            )}
        </section>
    );
}
