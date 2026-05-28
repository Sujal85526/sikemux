import { useEffect } from "react";
import { useResourceEnabled, type ResourceHandle } from "../../state/resources";
import { billingMonthsR, ec2InstancesR, lambdaFnsR, s3BucketsR, sqsQueuesR } from "../../state/resources.defs";
import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
import type { Ec2Instance, LambdaFn, S3Bucket, SqsQueue } from "../../api/aws";
import { type ReactNode } from "react";
import { IconChevron } from "../Icons";
import { AwsRefresh } from "./AwsRefresh";

// Generic frame: loading / error / empty / data.
function Frame<T>({
    handle,
    loading,
    emptyText,
    children,
}: {
    handle: ResourceHandle<T[]>;
    loading: string;
    emptyText: string;
    children: (data: T[]) => ReactNode;
}) {
    if (handle.data === undefined) {
        if (handle.status === "error" && handle.error) return <div className="aws-err">{handle.error}</div>;
        return <div className="aws-loading">{loading}</div>;
    }
    if (handle.data.length === 0) return <div className="aws-empty">{emptyText}</div>;
    return <>{children(handle.data)}</>;
}

// ============================================================
// EC2
// ============================================================
export function AwsEc2View({ profile, active }: { profile: string; active: boolean }) {
    const handle = useResourceEnabled(active, ec2InstancesR, profile);
    return (
        <div className="aws-view">
            <AwsRefresh handle={handle} />
            <Frame handle={handle} loading="loading instances…" emptyText="no results">
                {(data) => (
                    <table className="aws-table">
                        <thead>
                            <tr>
                                <th className="aws-col-name">Instance</th>
                                <th>Type</th>
                                <th>State</th>
                                <th>Private IP</th>
                                <th>Public IP</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map((i: Ec2Instance) => (
                                <tr key={i.instance_id} className="aws-row">
                                    <td className="aws-col-name">
                                        {i.name ?? i.instance_id}
                                        {i.name && <span className="aws-sub-id">{i.instance_id}</span>}
                                    </td>
                                    <td>{i.instance_type ?? "—"}</td>
                                    <td>
                                        <span className={`aws-status aws-status-${i.state === "running" ? "ok" : "off"}`}>{i.state ?? "—"}</span>
                                    </td>
                                    <td>{i.private_ip ?? "—"}</td>
                                    <td>{i.public_ip ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Frame>
        </div>
    );
}

// ============================================================
// Lambda
// ============================================================
export function AwsLambdaView({ profile, active }: { profile: string; active: boolean }) {
    const handle = useResourceEnabled(active, lambdaFnsR, profile);
    return (
        <div className="aws-view">
            <AwsRefresh handle={handle} />
            <Frame handle={handle} loading="loading functions…" emptyText="no results">
                {(data) => (
                    <table className="aws-table">
                        <thead>
                            <tr>
                                <th className="aws-col-name">Function</th>
                                <th>Runtime</th>
                                <th>Memory</th>
                                <th>Timeout</th>
                                <th>Last Modified</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map((f: LambdaFn) => (
                                <tr key={f.name} className="aws-row">
                                    <td className="aws-col-name">{f.name}</td>
                                    <td>{f.runtime ?? "—"}</td>
                                    <td>{f.memory_size ? `${f.memory_size} MB` : "—"}</td>
                                    <td>{f.timeout ? `${f.timeout}s` : "—"}</td>
                                    <td>{f.last_modified?.replace(/\..*$/, "") ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Frame>
        </div>
    );
}

// ============================================================
// SQS
// ============================================================
export function AwsSqsView({ profile, active }: { profile: string; active: boolean }) {
    const handle = useResourceEnabled(active, sqsQueuesR, profile);
    return (
        <div className="aws-view">
            <AwsRefresh handle={handle} />
            <Frame handle={handle} loading="loading queues…" emptyText="no results">
                {(data) => (
                    <table className="aws-table">
                        <thead>
                            <tr>
                                <th className="aws-col-name">Queue</th>
                                <th>URL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map((q: SqsQueue) => (
                                <tr key={q.url} className="aws-row">
                                    <td className="aws-col-name">{q.name}</td>
                                    <td className="aws-sub-id">{q.url}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Frame>
        </div>
    );
}

// ============================================================
// Billing — 6-month timeline with expandable rows
// ============================================================
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonth(periodStart: string): string {
    const [y, m] = periodStart.split("-");
    const idx = parseInt(m, 10) - 1;
    if (idx < 0 || idx > 11) return periodStart;
    return `${MONTH_NAMES[idx]} ${y.slice(2)}`;
}

function formatAmount(amount: string | number, unit: string): string {
    const raw = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(raw)) return `${unit} ${amount}`;
    // Collapse the rounded-to-zero negative weirdness ($-0.00) — CE returns
    // tiny floating-point residuals from credit math.
    const n = Math.abs(raw) < 0.005 ? 0 : raw;
    const symbol = unit === "USD" ? "$" : `${unit} `;
    const sign = n < 0 ? "-" : "";
    const body = Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `${sign}${symbol}${body}`;
}

// Split a service-cost list into positive charges and negative credits.
// CE returns credits (refunds, RI rebates, savings plan amortization) as
// negative entries; netting them silently into the total is what made the
// big number show $-0.00 even though real charges were ~$43.
function splitCharges(by_service: { amount: string }[]): {
    gross: number;
    credits: number;
    net: number;
} {
    let gross = 0;
    let credits = 0;
    for (const s of by_service) {
        const n = Number(s.amount);
        if (!Number.isFinite(n)) continue;
        if (n >= 0) gross += n;
        else credits += n; // negative
    }
    return { gross, credits, net: gross + credits };
}

export function AwsBillingView({ profile, active }: { profile: string; active: boolean }) {
    const handle = useResourceEnabled(active, billingMonthsR, profile, 5);
    const expanded = useStore((s) => s.expandedBillingMonth[profile] ?? null);
    const data = handle.data;

    // Auto-expand the current month on first load.
    useEffect(() => {
        if (!data || expanded !== null) return;
        const cur = data.find((m) => m.is_current);
        if (cur) cmd.setBillingExpandedMonth(profile, cur.period_start);
    }, [data, expanded, profile]);

    if (!data) {
        if (handle.status === "error" && handle.error)
            return (
                <div className="aws-view">
                    <AwsRefresh handle={handle} />
                    <div className="aws-err">{handle.error}</div>
                </div>
            );
        return (
            <div className="aws-view">
                <AwsRefresh handle={handle} />
                <div className="aws-loading">loading costs…</div>
            </div>
        );
    }
    if (data.length === 0)
        return (
            <div className="aws-view">
                <AwsRefresh handle={handle} />
                <div className="aws-empty">no billing data</div>
            </div>
        );

    const months = data;
    // Use GROSS for the chart + headline. Credits shown separately.
    const splits = months.map((m) => splitCharges(m.by_service));
    const grosses = splits.map((s) => s.gross);
    const maxGross = Math.max(...grosses, 1);
    const currentIdx = months.findIndex((m) => m.is_current);
    const current = (currentIdx >= 0 ? months[currentIdx] : null) ?? months[months.length - 1];
    const currentSplit = currentIdx >= 0 ? splits[currentIdx] : splits[splits.length - 1];
    const avg = grosses.reduce((a, b) => a + b, 0) / months.length;

    return (
        <div className="aws-view aws-billing">
            <AwsRefresh handle={handle} />
            <div className="aws-billing-hero">
                <div className="aws-billing-hero-main">
                    <div className="aws-billing-period">{formatMonth(current.period_start)} · gross charges</div>
                    <div className="aws-billing-total">
                        <span className="aws-billing-amount">{formatAmount(currentSplit.gross, current.unit)}</span>
                    </div>
                </div>
                <div className="aws-billing-hero-stats">
                    {Math.abs(currentSplit.credits) > 0.005 && (
                        <>
                            <div className="aws-billing-stat credit">
                                <div className="aws-billing-stat-label">credits</div>
                                <div className="aws-billing-stat-value">{formatAmount(currentSplit.credits, current.unit)}</div>
                            </div>
                            <div className="aws-billing-stat">
                                <div className="aws-billing-stat-label">net</div>
                                <div className="aws-billing-stat-value">{formatAmount(currentSplit.net, current.unit)}</div>
                            </div>
                        </>
                    )}
                    <div className="aws-billing-stat">
                        <div className="aws-billing-stat-label">{months.length}mo avg</div>
                        <div className="aws-billing-stat-value">{formatAmount(avg, current.unit)}</div>
                    </div>
                </div>
            </div>

            <div className="aws-billing-timeline">
                {months.map((m, i) => {
                    const isOpen = expanded === m.period_start;
                    const split = splits[i];
                    const pct = (split.gross / maxGross) * 100;
                    const prev = i > 0 ? splits[i - 1].gross : null;
                    const delta = prev != null && prev > 0 ? ((split.gross - prev) / prev) * 100 : null;
                    const hasCredits = Math.abs(split.credits) > 0.005;
                    return (
                        <div key={m.period_start} className={`aws-bill-month${isOpen ? " open" : ""}${m.is_current ? " current" : ""}`}>
                            <button
                                className="aws-bill-month-head"
                                onClick={() => cmd.setBillingExpandedMonth(profile, isOpen ? null : m.period_start)}>
                                <span className="aws-bill-chev">
                                    <IconChevron size={11} />
                                </span>
                                <span className="aws-bill-month-name">
                                    {formatMonth(m.period_start)}
                                    {m.is_current && <span className="aws-bill-now">MTD</span>}
                                </span>
                                <span className="aws-bill-bar">
                                    <span className="aws-bill-bar-fill" style={{ width: `${pct}%` }} />
                                </span>
                                {delta !== null && Math.abs(delta) >= 1 && (
                                    <span className={`aws-bill-delta ${delta > 0 ? "up" : "down"}`}>
                                        {delta > 0 ? "▲" : "▼"}
                                        {Math.abs(delta).toFixed(0)}%
                                    </span>
                                )}
                                <span className="aws-bill-amount">{formatAmount(split.gross, m.unit)}</span>
                            </button>
                            {isOpen && (
                                <div className={`aws-bill-services${hasCredits ? " split" : ""}`}>
                                    {/* Left column — positive charges */}
                                    <div className="aws-bill-col">
                                        <div className="aws-bill-col-head">Charges</div>
                                        {m.by_service
                                            .filter((s) => Number(s.amount) > 0.005)
                                            .map((s) => (
                                                <div className="aws-bill-svc" key={`c-${s.service}`}>
                                                    <span className="aws-bill-svc-name">{s.service}</span>
                                                    <span className="aws-bill-svc-bar">
                                                        <span
                                                            className="aws-bill-svc-bar-fill"
                                                            style={{
                                                                width: `${(Number(s.amount) / Math.max(split.gross, 1)) * 100}%`,
                                                            }}
                                                        />
                                                    </span>
                                                    <span className="aws-bill-svc-amount">{formatAmount(s.amount, s.unit)}</span>
                                                </div>
                                            ))}
                                        {m.by_service.length === 0 && <div className="aws-bill-empty">no charges this month</div>}
                                    </div>

                                    {/* Right column — credits & refunds (only when present) */}
                                    {hasCredits && (
                                        <div className="aws-bill-col">
                                            <div className="aws-bill-col-head">Credits &amp; refunds</div>
                                            {m.by_service
                                                .filter((s) => Number(s.amount) < -0.005)
                                                .sort((a, b) => Number(a.amount) - Number(b.amount))
                                                .map((s) => (
                                                    <div className="aws-bill-svc credit" key={`r-${s.service}`}>
                                                        <span className="aws-bill-svc-name">{s.service}</span>
                                                        <span className="aws-bill-svc-bar">
                                                            <span
                                                                className="aws-bill-svc-bar-fill credit"
                                                                style={{
                                                                    width: `${Math.min(
                                                                        (Math.abs(Number(s.amount)) / Math.max(Math.abs(split.credits), 1)) * 100,
                                                                        100,
                                                                    )}%`,
                                                                }}
                                                            />
                                                        </span>
                                                        <span className="aws-bill-svc-amount credit">{formatAmount(s.amount, s.unit)}</span>
                                                    </div>
                                                ))}
                                            <div className="aws-bill-svc total">
                                                <span className="aws-bill-svc-name">Net for month</span>
                                                <span className="aws-bill-svc-bar" />
                                                <span className="aws-bill-svc-amount">{formatAmount(split.net, m.unit)}</span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ============================================================
// S3
// ============================================================
export function AwsS3View({ profile, active }: { profile: string; active: boolean }) {
    const handle = useResourceEnabled(active, s3BucketsR, profile);
    return (
        <div className="aws-view">
            <AwsRefresh handle={handle} />
            <Frame handle={handle} loading="loading buckets…" emptyText="no results">
                {(data) => (
                    <table className="aws-table">
                        <thead>
                            <tr>
                                <th className="aws-col-name">Bucket</th>
                                <th>Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map((b: S3Bucket) => (
                                <tr key={b.name} className="aws-row">
                                    <td className="aws-col-name">{b.name}</td>
                                    <td>{b.created_at?.replace(/\..*$/, "") ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Frame>
        </div>
    );
}
