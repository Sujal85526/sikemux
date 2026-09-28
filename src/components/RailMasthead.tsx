import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isUpdateBusy, updateDownloadPercent, updateStatusLabel } from "../api/updater";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { swallow } from "../state/toast";
import { IconDownload, IconRefresh, IconWarning, Logo } from "./Icons";
import { RailToggle } from "./RailToggle";
import { Tooltip } from "./Tooltip";

const RING_RADIUS = 9;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function useAppVersion(): string | null {
    const [version, setVersion] = useState<string | null>(null);
    useEffect(() => {
        getVersion().then(setVersion).catch(swallow("getVersion"));
    }, []);
    return version;
}

function ProgressRing({ percent }: { percent: number | null }) {
    const shown = percent === null ? RING_LENGTH * 0.25 : (RING_LENGTH * percent) / 100;
    return (
        <svg className={`update-ring${percent === null ? " update-ring-spin" : ""}`} viewBox="0 0 22 22" aria-hidden="true">
            <circle className="update-ring-track" cx="11" cy="11" r={RING_RADIUS} />
            <circle className="update-ring-bar" cx="11" cy="11" r={RING_RADIUS} strokeDasharray={`${shown} ${RING_LENGTH}`} />
        </svg>
    );
}

function splitVersion(version: string): { release: string; channel: string | null } {
    const match = /^(\d+\.\d+\.\d+)-([a-z]+)(?:\.(\d+))?$/i.exec(version);
    if (!match) return { release: version, channel: null };
    const [, release, name, build] = match;
    return { release, channel: build ? `${name} ${build}` : name };
}

function VersionLabel({ version }: { version: string }) {
    const { release, channel } = splitVersion(version);
    return (
        <Tooltip label={`Sikemux ${version}`}>
            <span className="rail-masthead-version">
                v{release}
                {channel && <span className="rail-masthead-channel">{channel}</span>}
            </span>
        </Tooltip>
    );
}

export function UpdateButton() {
    const pending = useStore((s) => s.pendingUpdate);
    if (!pending) return null;

    const state = pending.state;
    const busy = isUpdateBusy(state);
    const statusLabel = updateStatusLabel(pending);
    const label =
        state === "error"
            ? `Update v${pending.version} failed — ${pending.error ?? "unknown"}. Click to retry.`
            : busy
              ? `${statusLabel} v${pending.version}`
              : `Update v${pending.version} available (current: v${pending.currentVersion}). Click to install + relaunch.${pending.notes ? `\n\n${pending.notes}` : ""}`;
    const Glyph = state === "error" ? IconWarning : state === "installing" || state === "restarting" ? IconRefresh : IconDownload;

    return (
        <Tooltip label={label}>
            <button className={`update-button update-button-${state}`} onClick={cmd.openWhatsNew} disabled={busy} aria-label={label}>
                {busy && <ProgressRing percent={state === "downloading" ? updateDownloadPercent(pending) : null} />}
                <Glyph size={busy ? 10 : 14} />
            </button>
        </Tooltip>
    );
}

export function RailMasthead() {
    const version = useAppVersion();
    return (
        <div className="rail-masthead">
            <Logo size={14} className="rail-masthead-logo" />
            <span className="rail-masthead-name">Sikemux</span>
            {version && <VersionLabel version={version} />}
            <span className="rail-masthead-actions">
                <UpdateButton />
                <RailToggle edge="start" />
            </span>
        </div>
    );
}
