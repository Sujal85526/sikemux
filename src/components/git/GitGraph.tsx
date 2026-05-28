import { useLayoutEffect, useMemo, useRef } from "react";
import type { GitCommit } from "../../api/git";

// ---- geometry ----
// Row height is constant whether the panel is focused or not (lazygit keeps
// rows fixed and just shows more of them) so the canvas math stays simple.
const ROW_H = 30;
const LANE_W = 14; // horizontal gap between lanes
const X0 = 14; // x of lane 0's centre
const NODE_R = 4;
const GUTTER_PAD = 18; // breathing room between the deepest lane and the text

const gutterWidth = (maxLanes: number) => X0 + Math.max(0, maxLanes - 1) * LANE_W + GUTTER_PAD;
const laneX = (lane: number) => X0 + lane * LANE_W;

// ---- lane layout ----
// Classic git-graph lane assignment. We never shuffle a live lane sideways,
// so pass-through lanes stay at a constant x (clean vertical lines) and only
// branch/merge points curve. Colour is keyed on lane index — the same trick
// gitk/lazygit use — so a branch keeps its colour for its whole life.
interface RowLayout {
    lane: number;
    colorIdx: number;
    isHead: boolean;
    merges: { fromLane: number; color: number }[]; // top edge → node (a child line landing on this commit)
    through: { lane: number; color: number }[]; // straight verticals passing this row
    branches: { toLane: number; color: number }[]; // node → bottom edge (this commit's parents)
}

function computeGraph(commits: GitCommit[]): { rows: RowLayout[]; maxLanes: number } {
    const visible = new Set(commits.map((c) => c.full_hash));
    const lanes: (string | null)[] = []; // lanes[i] = full hash that lane i is currently waiting for
    const rows: RowLayout[] = [];
    let maxLanes = 0;

    const pad = (to: number) => {
        while (lanes.length <= to) lanes.push(null);
    };
    const firstFree = () => {
        const i = lanes.indexOf(null);
        if (i !== -1) return i;
        lanes.push(null);
        return lanes.length - 1;
    };

    for (const c of commits) {
        // Lanes already waiting for this commit = its children merging in.
        const expecting: number[] = [];
        for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.full_hash) expecting.push(j);

        const commitLane = expecting.length > 0 ? expecting[0] : firstFree();
        pad(commitLane);

        // A fresh tip has no children above it, so no top-half line.
        const merges = expecting.map((j) => ({ fromLane: j, color: j }));

        const through: { lane: number; color: number }[] = [];
        for (let j = 0; j < lanes.length; j++) {
            if (j === commitLane || lanes[j] === null || lanes[j] === c.full_hash) continue;
            through.push({ lane: j, color: j });
        }

        // Every lane that landed on this commit is now consumed.
        for (const j of expecting) lanes[j] = null;
        lanes[commitLane] = null;

        const branches: { toLane: number; color: number }[] = [];
        const parents = c.parents.filter((p) => visible.has(p));
        if (parents.length > 0) {
            const p0 = parents[0];
            const existing0 = lanes.indexOf(p0);
            if (existing0 !== -1) {
                // First parent already has a lane → this commit's lane ends and
                // curves into it (a merge that closes a branch).
                branches.push({ toLane: existing0, color: existing0 });
            } else {
                lanes[commitLane] = p0;
                branches.push({ toLane: commitLane, color: commitLane });
            }
            for (let pi = 1; pi < parents.length; pi++) {
                const p = parents[pi];
                let k = lanes.indexOf(p);
                if (k === -1) {
                    k = firstFree();
                    lanes[k] = p;
                }
                branches.push({ toLane: k, color: k });
            }
        }

        rows.push({
            lane: commitLane,
            colorIdx: commitLane,
            isHead: c.refs.includes("HEAD"),
            merges,
            through,
            branches,
        });

        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
        maxLanes = Math.max(maxLanes, lanes.length, commitLane + 1);
    }

    return { rows, maxLanes: Math.max(1, maxLanes) };
}

// ---- author chip ----
function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function authorColor(key: string): string {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 62% 64%)`;
}

// ---- palette (read live off the canvas so it tracks the active theme) ----
function readVar(el: HTMLElement, name: string): string {
    return getComputedStyle(el).getPropertyValue(name).trim();
}
function readPalette(el: HTMLElement): string[] {
    // Lane 0 (the main line) takes the accent; the rest cycle through the
    // theme's signal colours. `--blue` isn't a theme token here, so it's a
    // literal — keeps branch lanes distinct without overloading one hue.
    const themed = ["--acc", "--live", "--cmd", "--warn", "--danger"].map((n) => readVar(el, n)).filter(Boolean);
    const extra = ["#7cc5ff", "#ffd166", "#9b8cff"];
    const all = [...themed, ...extra];
    return all.length ? all : ["#a277ff", "#61ffca", "#ff6ac1", "#ffca85", "#7cc5ff", "#ff6767"];
}

function draw(canvas: HTMLCanvasElement, rows: RowLayout[], maxLanes: number, selectedIndex: number) {
    const dpr = window.devicePixelRatio || 1;
    const w = gutterWidth(maxLanes);
    const h = Math.max(1, rows.length * ROW_H);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";

    const palette = readPalette(canvas);
    const voidColor = readVar(canvas, "--void") || "#0c0b10";
    const col = (i: number) => palette[i % palette.length];
    // Control-point offset for the cubic — a soft S that reads as a clean
    // branch/merge without overshooting into neighbouring lanes.
    const cp = ROW_H * 0.42;

    // Pass 1 — edges (so nodes always sit on top of the lines).
    ctx.lineWidth = 1.8;
    rows.forEach((r, i) => {
        const yTop = i * ROW_H;
        const yMid = yTop + ROW_H / 2;
        const yBot = yTop + ROW_H;
        const nodeX = laneX(r.lane);

        for (const t of r.through) {
            ctx.strokeStyle = col(t.color);
            ctx.beginPath();
            ctx.moveTo(laneX(t.lane), yTop);
            ctx.lineTo(laneX(t.lane), yBot);
            ctx.stroke();
        }
        for (const m of r.merges) {
            const fx = laneX(m.fromLane);
            ctx.strokeStyle = col(m.color);
            ctx.beginPath();
            ctx.moveTo(fx, yTop);
            if (m.fromLane === r.lane) ctx.lineTo(nodeX, yMid);
            else ctx.bezierCurveTo(fx, yTop + cp, nodeX, yMid - cp, nodeX, yMid);
            ctx.stroke();
        }
        for (const b of r.branches) {
            const tx = laneX(b.toLane);
            ctx.strokeStyle = col(b.color);
            ctx.beginPath();
            ctx.moveTo(nodeX, yMid);
            if (b.toLane === r.lane) ctx.lineTo(tx, yBot);
            else ctx.bezierCurveTo(nodeX, yMid + cp, tx, yBot - cp, tx, yBot);
            ctx.stroke();
        }
    });

    // Pass 2 — nodes.
    rows.forEach((r, i) => {
        const yMid = i * ROW_H + ROW_H / 2;
        const nodeX = laneX(r.lane);
        const c = col(r.colorIdx);

        // Void halo carves the node out of the lines behind it.
        ctx.fillStyle = voidColor;
        ctx.beginPath();
        ctx.arc(nodeX, yMid, NODE_R + 1.6, 0, Math.PI * 2);
        ctx.fill();

        if (r.isHead) {
            ctx.save();
            ctx.shadowColor = c;
            ctx.shadowBlur = 9;
            ctx.lineWidth = 2.4;
            ctx.strokeStyle = c;
            ctx.beginPath();
            ctx.arc(nodeX, yMid, NODE_R + 1, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = c;
            ctx.beginPath();
            ctx.arc(nodeX, yMid, 2.3, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.fillStyle = c;
            ctx.beginPath();
            ctx.arc(nodeX, yMid, NODE_R, 0, Math.PI * 2);
            ctx.fill();
        }

        if (i === selectedIndex) {
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(255,255,255,.9)";
            ctx.beginPath();
            ctx.arc(nodeX, yMid, NODE_R + 3, 0, Math.PI * 2);
            ctx.stroke();
        }
    });
}

function RefBadge({ label }: { label: string }) {
    let kind = "branch";
    let text = label;
    if (label === "HEAD" || label.startsWith("HEAD -> ")) {
        kind = "head";
        text = label.startsWith("HEAD -> ") ? label.slice(8) : label;
    } else if (label.startsWith("tag: ")) {
        kind = "tag";
        text = label.slice(5);
    } else if (label.includes("/")) kind = "remote";
    return <span className={`gg-ref ${kind}`}>{text}</span>;
}

export function GitGraph({
    commits,
    selectedIndex,
    focused,
    range,
    onSelect,
    onActivate,
}: {
    commits: GitCommit[];
    selectedIndex: number;
    focused: boolean;
    range: [number, number] | null;
    onSelect: (i: number) => void;
    onActivate: () => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const selRef = useRef<HTMLDivElement>(null);
    const { rows, maxLanes } = useMemo(() => computeGraph(commits), [commits]);
    const gutter = gutterWidth(maxLanes);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (canvas) draw(canvas, rows, maxLanes, selectedIndex);
    }, [rows, maxLanes, selectedIndex]);

    // Keep the cursor row in view as the user moves through history.
    useLayoutEffect(() => {
        if (focused) selRef.current?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex, focused]);

    if (commits.length === 0) return <div className="git-empty">no commits</div>;

    return (
        <div className="git-graph" style={{ position: "relative" }}>
            <canvas ref={canvasRef} className="git-graph-canvas" aria-hidden />
            {commits.map((c, i) => {
                const sel = focused && selectedIndex === i;
                const inRange = range !== null && i >= range[0] && i <= range[1];
                return (
                    <div
                        key={c.full_hash || c.hash}
                        ref={sel ? selRef : undefined}
                        className={`gg-row${sel ? " sel" : ""}${inRange ? " ranged" : ""}`}
                        style={{ height: ROW_H, paddingLeft: gutter }}
                        onClick={() => onSelect(i)}
                        onDoubleClick={onActivate}
                        title={`${c.hash} · ${c.author}`}>
                        <span className="gg-hash">{c.hash}</span>
                        {c.refs.length > 0 && (
                            <span className="gg-refs">
                                {c.refs.map((r) => (
                                    <RefBadge key={r} label={r} />
                                ))}
                            </span>
                        )}
                        <span className="gg-subj">{c.subject}</span>
                        <span className="gg-author" style={{ background: authorColor(c.author_email || c.author) }}>
                            {initials(c.author)}
                        </span>
                        <span className="gg-when">{c.date}</span>
                    </div>
                );
            })}
        </div>
    );
}
