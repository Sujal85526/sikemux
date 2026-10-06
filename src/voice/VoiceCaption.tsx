import type { CSSProperties } from "react";
import { useVoice } from "./dictation";

const INSET = 12;

/** Where the caption goes: above a chat's composer so it never covers the mic or send buttons, otherwise inside the bottom of the field. */
export function captionStyle(target: HTMLElement | null, viewportHeight: number): CSSProperties {
    if (!target?.isConnected) return { left: "50%", bottom: 64 };
    const composer = target.querySelector<HTMLElement>(".chat-composer");
    const rect = (composer ?? target).getBoundingClientRect();
    const bottom = composer ? viewportHeight - rect.top + INSET : viewportHeight - rect.bottom + INSET;
    return { left: rect.left + rect.width / 2, bottom, maxWidth: Math.max(rect.width - INSET * 2, 160) };
}

export function VoiceCaption() {
    const partial = useVoice((s) => s.partial);
    const target = useVoice((s) => s.target);
    const phase = useVoice((s) => s.phase);
    if (!partial || (phase !== "listening" && phase !== "transcribing")) return null;

    return (
        <div
            className={`voice-caption${phase === "transcribing" ? " settling" : ""}`}
            style={captionStyle(target, window.innerHeight)}
            role="status"
            aria-live="polite">
            <div className="voice-caption-lines">
                <p>{partial}</p>
            </div>
        </div>
    );
}
