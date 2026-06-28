import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { awsApi } from "../../api/aws";
import { reportError } from "../../state/toast";
import { VirtualLogList } from "../VirtualLogList";
import { highlightLog } from "./logHighlight";

const MAX_LINES = 5000;
const FLUSH_MS = 50;

interface Props {
    profile: string;
    logGroup: string;
    logStream?: string | null;
    active: boolean;
}

export function AwsLogTailView({ profile, logGroup, logStream, active }: Props) {
    const [lines, setLines] = useState<string[]>([]);
    const [err, setErr] = useState<string | null>(null);
    const [tailId, setTailId] = useState<number | null>(null);
    const [live, setLive] = useState(false);
    const [pinned, setPinned] = useState(true);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let flushTimer: number | undefined;
        const pending: string[] = [];
        const ch = new Channel<string>();
        setLines([]);
        setErr(null);
        setLive(true);
        const flushPending = () => {
            flushTimer = undefined;
            if (cancelled || pending.length === 0) return;
            const batch = pending.splice(0);
            setLines((prev) => {
                const next = prev.concat(batch);
                return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
            });
        };
        ch.onmessage = (line) => {
            if (cancelled) return;
            if (line === "") {
                flushPending();
                setLive(false);
                return;
            }
            pending.push(line);
            if (flushTimer === undefined) flushTimer = window.setTimeout(flushPending, FLUSH_MS);
        };
        let id: number | null = null;
        invoke<number>("aws_logs_tail_start", {
            profile,
            logGroup,
            logStream: logStream ?? null,
            since: "5m",
            onLine: ch,
        })
            .then((newId) => {
                if (cancelled) {
                    void awsApi.logsTailStop(newId);
                    return;
                }
                id = newId;
                setTailId(newId);
            })
            .catch((e) => {
                if (cancelled) return;
                setErr(String(e));
                reportError("logs tail")(e);
            });
        return () => {
            cancelled = true;
            if (flushTimer !== undefined) window.clearTimeout(flushTimer);
            if (id !== null) void awsApi.logsTailStop(id);
            setLive(false);
            setTailId(null);
        };
    }, [profile, logGroup, logStream, active]);

    const onScroll = (el: HTMLDivElement) => {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
        setPinned(atBottom);
    };

    if (err) return <div className="aws-err">{err}</div>;

    return (
        <div className="aws-logs">
            <div className="aws-logs-head">
                <span className="aws-logs-target">
                    <span className="aws-logs-label">group</span>
                    <span className="aws-logs-value">{logGroup}</span>
                </span>
                {logStream && (
                    <span className="aws-logs-target">
                        <span className="aws-logs-label">stream</span>
                        <span className="aws-logs-value">{logStream}</span>
                    </span>
                )}
                <span className={`aws-logs-pill ${live ? "live" : "ended"}`} title={tailId ? `tail #${tailId}` : ""}>
                    <span className="aws-logs-pill-dot" />
                    {live ? "tailing" : "ended"}
                </span>
                {!pinned && (
                    <button
                        className="aws-logs-jump"
                        onClick={() => {
                            setPinned(true);
                        }}>
                        ↓ jump to live
                    </button>
                )}
            </div>

            <VirtualLogList
                items={lines}
                className="aws-logs-body"
                rowClassName="aws-logs-line"
                estimateSize={19}
                follow={pinned}
                onScroll={onScroll}
                allowFollow={(el) => {
                    const sel = window.getSelection();
                    return !(sel && sel.toString() && el.contains(sel.anchorNode));
                }}
                empty={<div className="aws-logs-waiting">no events in the last 5 minutes — waiting for new ones…</div>}
                renderRow={(line) => highlightLog(line)}
            />
        </div>
    );
}
