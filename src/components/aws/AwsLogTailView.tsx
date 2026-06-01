import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { awsApi } from "../../api/aws";
import { reportError } from "../../state/toast";
import { highlightLog } from "./logHighlight";

const MAX_LINES = 5000;

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
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        const ch = new Channel<string>();
        setLines([]);
        setErr(null);
        setLive(true);
        ch.onmessage = (line) => {
            if (cancelled) return;
            if (line === "") {
                setLive(false);
                return;
            }
            setLines((prev) => {
                const next = prev.length >= MAX_LINES ? prev.slice(-MAX_LINES + 1) : prev;
                return [...next, line];
            });
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
                setErr(String(e));
                reportError("logs tail")(e);
            });
        return () => {
            cancelled = true;
            if (id !== null) void awsApi.logsTailStop(id);
            setLive(false);
            setTailId(null);
        };
    }, [profile, logGroup, logStream, active]);

    useEffect(() => {
        if (!pinned) return;
        const sel = window.getSelection();
        if (sel && sel.toString() && containerRef.current?.contains(sel.anchorNode)) {
            return;
        }
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines, pinned]);

    const onScroll = () => {
        const el = containerRef.current;
        if (!el) return;
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
                            const el = containerRef.current;
                            if (el) el.scrollTop = el.scrollHeight;
                        }}>
                        ↓ jump to live
                    </button>
                )}
            </div>

            <div className="aws-logs-body" ref={containerRef} onScroll={onScroll}>
                {lines.length === 0 && <div className="aws-logs-waiting">no events in the last 5 minutes — waiting for new ones…</div>}
                {lines.map((l, i) => (
                    <div className="aws-logs-line" key={i}>
                        {highlightLog(l)}
                    </div>
                ))}
            </div>
        </div>
    );
}
