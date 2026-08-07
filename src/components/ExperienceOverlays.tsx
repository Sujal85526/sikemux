import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { browserDiagnostics, nativeDiagnostics } from "../lib/diagnostics";
import { useResource } from "../state/resources";
import { agentCatalogR } from "../state/resources.defs";
import { useStore } from "../state/store";
import * as cmd from "../state/commands";
import { installPendingUpdate } from "../api/updater";
import { agentDetectionApi, type ManifestReport } from "../api/agentDetection";
import { getKeybindingAction, keybindingLabelForAction, type KeybindingActionId } from "../keybindings";

interface IntegrationHealth {
    shell: string;
    git: boolean;
    aws: boolean;
    rnd: boolean;
}

const ONBOARDING_STEPS = [
    { kicker: "One cockpit", title: "Everything you ship, one signal away" },
    { kicker: "Muscle memory", title: "Open anything without breaking flow" },
    { kicker: "Agent signals", title: "Know when to watch, help, or move on" },
    { kicker: "Launch ready", title: "Your first move is already mapped" },
] as const;

const ONBOARDING_SHORTCUTS = ["session.open", "palette.commands", "project.open", "pane.splitRow"] as const satisfies readonly KeybindingActionId[];

function Frame({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [onClose]);
    return (
        <div className="experience-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <section className="experience-frame" role="dialog" aria-modal="true" aria-label={label}>
                <div className="experience-notch" aria-hidden="true" />
                <header>
                    <span className="experience-kicker">Sikemux signal deck</span>
                    <h1>{label}</h1>
                    <button onClick={onClose} aria-label={`Close ${label}`}>
                        esc
                    </button>
                </header>
                {children}
            </section>
        </div>
    );
}

export function Onboarding() {
    const open = useStore((s) => s.onboardingOpen);
    const overrides = useStore((s) => s.keybindingOverrides);
    const catalog = useResource(agentCatalogR);
    const [health, setHealth] = useState<IntegrationHealth | null>(null);
    const [healthUnavailable, setHealthUnavailable] = useState(false);
    const [step, setStep] = useState(0);
    const [direction, setDirection] = useState<"forward" | "back">("forward");
    const dialogRef = useRef<HTMLElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!open) return;
        let disposed = false;
        setHealth(null);
        setHealthUnavailable(false);
        void invoke<IntegrationHealth>("integration_health")
            .then((value) => {
                if (!disposed) setHealth(value);
            })
            .catch(() => {
                if (!disposed) setHealthUnavailable(true);
            });
        return () => {
            disposed = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setStep(0);
        setDirection("forward");
        const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
        return () => {
            window.cancelAnimationFrame(frame);
            returnFocusRef.current?.focus();
        };
    }, [open]);

    if (!open) return null;

    const goTo = (next: number) => {
        const bounded = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, next));
        setDirection(bounded < step ? "back" : "forward");
        setStep(bounded);
    };
    const next = () => {
        if (step === ONBOARDING_STEPS.length - 1) cmd.closeOnboarding();
        else goTo(step + 1);
    };
    const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            cmd.closeOnboarding();
            return;
        }
        if (event.key === "ArrowRight") {
            event.preventDefault();
            next();
            return;
        }
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            goTo(step - 1);
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [
            ...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])") ?? []),
        ];
        if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1)!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === dialogRef.current)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        } else if (!event.shiftKey && active === dialogRef.current) {
            event.preventDefault();
            first.focus();
        }
    };
    const shortcut = (id: KeybindingActionId) => ({
        action: getKeybindingAction(id),
        label: keybindingLabelForAction(overrides, id),
    });
    const sessionShortcut = shortcut("session.open");
    const commandShortcut = shortcut("palette.commands");
    const detectedAgents = catalog.data?.map((agent) => agent.label) ?? [];
    const healthSignals = health
        ? [
              { label: `shell ${health.shell || "unknown"}`, ready: !!health.shell },
              { label: "git", ready: health.git },
              { label: "aws", ready: health.aws },
              { label: "rundeck", ready: health.rnd },
          ]
        : [];

    return (
        <div className="experience-backdrop onboarding-backdrop" role="presentation">
            <section
                ref={dialogRef}
                className="experience-frame onboarding-frame"
                role="dialog"
                aria-modal="true"
                aria-labelledby="onboarding-title"
                aria-describedby="onboarding-description"
                tabIndex={-1}
                onKeyDown={onKeyDown}>
                <div className="onboarding-signal-rail" aria-hidden="true">
                    <span style={{ height: `${((step + 1) / ONBOARDING_STEPS.length) * 100}%` }} />
                </div>

                <header className="onboarding-header">
                    <div>
                        <span className="experience-kicker">Sikemux · first signal</span>
                        <span className="onboarding-step-count">{String(step + 1).padStart(2, "0")} / 04</span>
                    </div>
                    <button className="onboarding-skip" onClick={() => cmd.closeOnboarding()} aria-label="Skip onboarding tour">
                        Skip tour <span aria-hidden="true">esc</span>
                    </button>
                </header>

                <div className="onboarding-progress" aria-label={`Onboarding step ${step + 1} of ${ONBOARDING_STEPS.length}`}>
                    {ONBOARDING_STEPS.map((item, index) => (
                        <button
                            key={item.kicker}
                            className={index === step ? "is-current" : index < step ? "is-complete" : ""}
                            onClick={() => goTo(index)}
                            aria-label={`Go to step ${index + 1}: ${item.kicker}`}
                            aria-current={index === step ? "step" : undefined}>
                            <span />
                        </button>
                    ))}
                </div>

                <div key={step} className="onboarding-scene" data-direction={direction}>
                    <div className="onboarding-copy">
                        <span className="experience-kicker">{ONBOARDING_STEPS[step].kicker}</span>
                        <h1 id="onboarding-title">{ONBOARDING_STEPS[step].title}</h1>

                        {step === 0 && (
                            <>
                                <p id="onboarding-description">
                                    Sikemux keeps projects, terminals, cloud tools, API work, and coding agents in one keyboard-first workspace.
                                </p>
                                <div className="onboarding-note">
                                    <span className="onboarding-note-mark" aria-hidden="true" />
                                    Keep your context. Change the tool, not the window.
                                </div>
                            </>
                        )}

                        {step === 1 && (
                            <>
                                <p id="onboarding-description">
                                    Two shortcuts do most of the heavy lifting. Your custom bindings are shown here automatically.
                                </p>
                                <div className="onboarding-shortcut-stack">
                                    {[sessionShortcut, commandShortcut].map(({ action, label }, index) => (
                                        <div
                                            key={action.id}
                                            className="onboarding-shortcut-card"
                                            style={{ "--stagger": index } as React.CSSProperties}>
                                            <kbd>{label}</kbd>
                                            <span>
                                                <b>{action.label}</b>
                                                <small>{action.detail}</small>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {step === 2 && (
                            <>
                                <p id="onboarding-description">
                                    The rail is quiet until an agent needs you. Color tells you what kind of attention to give.
                                </p>
                                <div className="onboarding-state-list">
                                    <div>
                                        <i className="is-live" />
                                        <b>Working</b>
                                        <span>Let it cook</span>
                                    </div>
                                    <div>
                                        <i className="is-warn" />
                                        <b>Needs input</b>
                                        <span>Unblock it</span>
                                    </div>
                                    <div>
                                        <i className="is-ready" />
                                        <b>Ready</b>
                                        <span>Review the result</span>
                                    </div>
                                </div>
                                <div className="onboarding-detected">
                                    <span>Detected here</span>
                                    <b>
                                        {catalog.status === "loading"
                                            ? "Checking PATH…"
                                            : detectedAgents.length
                                              ? detectedAgents.join(" · ")
                                              : "Add a supported agent whenever you’re ready"}
                                    </b>
                                </div>
                            </>
                        )}

                        {step === 3 && (
                            <>
                                <p id="onboarding-description">
                                    You can replay this tour from the command deck or Settings. For now, start with any session.
                                </p>
                                <div className="onboarding-reference">
                                    {ONBOARDING_SHORTCUTS.map((id) => {
                                        const { action, label } = shortcut(id);
                                        return (
                                            <div key={id}>
                                                <span>{action.label}</span>
                                                <kbd>{label}</kbd>
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="onboarding-health" aria-live="polite">
                                    {healthSignals.length ? (
                                        healthSignals.map((signal) => (
                                            <span key={signal.label} className={signal.ready ? "is-ready" : "is-muted"}>
                                                {signal.label} {signal.ready ? "ready" : "missing"}
                                            </span>
                                        ))
                                    ) : (
                                        <span className={healthUnavailable ? "is-muted" : "is-checking"}>
                                            {healthUnavailable ? "Local tool check unavailable — setup can continue" : "Checking local tools…"}
                                        </span>
                                    )}
                                </div>
                            </>
                        )}
                    </div>

                    <div className={`onboarding-visual onboarding-visual--${step}`} aria-hidden="true">
                        <div className="onboarding-orbit orbit-a">
                            <span />
                        </div>
                        <div className="onboarding-orbit orbit-b">
                            <span />
                        </div>
                        <div className="onboarding-core">
                            <span className="onboarding-core-mark">S</span>
                            <small>{step === 0 ? "signal deck" : step === 1 ? "shortcut" : step === 2 ? "attention" : "ready"}</small>
                        </div>
                        <span className="onboarding-node node-project">project</span>
                        <span className="onboarding-node node-agent">agent</span>
                        <span className="onboarding-node node-cloud">cloud</span>
                        <span className="onboarding-node node-command">command</span>
                        <div className="onboarding-sweep" />
                    </div>
                </div>

                <span className="onboarding-sr-only" role="status" aria-live="polite">
                    Step {step + 1} of {ONBOARDING_STEPS.length}: {ONBOARDING_STEPS[step].title}
                </span>

                <footer className="onboarding-footer">
                    <span className="onboarding-key-hint">
                        Use <kbd>←</kbd>
                        <kbd>→</kbd> to explore
                    </span>
                    <div>
                        {step > 0 && <button onClick={() => goTo(step - 1)}>Back</button>}
                        <button className="primary" onClick={next}>
                            {step === ONBOARDING_STEPS.length - 1 ? "Enter Sikemux" : "Continue"}
                            <span aria-hidden="true"> {step === ONBOARDING_STEPS.length - 1 ? "↵" : "→"}</span>
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    );
}

export function DiagnosticsOverlay() {
    const open = useStore((s) => s.diagnosticsOpen);
    const [snapshot, setSnapshot] = useState<unknown>(null);
    const [error, setError] = useState("");
    const [manifests, setManifests] = useState<ManifestReport | null>(null);
    const [explain, setExplain] = useState<unknown>(null);
    const agents = useStore((s) => s.agents);
    const activity = useStore((s) => s.agentActivity);
    const refresh = async () => {
        setError("");
        try {
            const [native, detection] = await Promise.all([nativeDiagnostics(), agentDetectionApi.manifests()]);
            setSnapshot({ browser: browserDiagnostics(), native });
            setManifests(detection);
        } catch (value) {
            setError(value instanceof Error ? value.message : String(value));
        }
    };
    useEffect(() => {
        if (open) void refresh();
    }, [open]);
    if (!open) return null;
    const text = JSON.stringify(snapshot, null, 2);
    return (
        <Frame label="Runtime diagnostics" onClose={cmd.closeDiagnostics}>
            <p className="experience-deck">
                A redacted operational snapshot. Terminal text, environment values, credentials, and API secrets are never included.
            </p>
            <div className="diagnostics-signals">
                <span className="experience-kicker">agent detection manifests</span>
                {manifests?.manifests.map((item) => (
                    <span key={item.agent}>
                        <b>{item.agent}</b> v{item.version} · {item.source.kind}
                        {item.warning ? " · warning" : ""}
                    </span>
                ))}
                {Object.values(agents).map((agent) => (
                    <button
                        key={agent.id}
                        type="button"
                        disabled={agent.launchState === "dormant"}
                        onClick={() =>
                            void agentDetectionApi
                                .explain(agent.id)
                                .then(setExplain)
                                .catch((value) => setError(String(value)))
                        }>
                        <b>{agent.title}</b>
                        <span>{agent.launchState === "dormant" ? "dormant" : (activity[agent.id]?.state ?? "unknown")}</span>
                        <small>explain</small>
                    </button>
                ))}
            </div>
            {explain != null && <pre className="diagnostics-json diagnostics-explain">{JSON.stringify(explain, null, 2)}</pre>}
            {error ? <p className="experience-error">{error}</p> : <pre className="diagnostics-json">{text || "Collecting…"}</pre>}
            <footer>
                <button
                    onClick={() =>
                        void agentDetectionApi
                            .reload()
                            .then(setManifests)
                            .catch((value) => setError(String(value)))
                    }>
                    Reload manifests
                </button>
                <button onClick={() => void refresh()}>Refresh</button>
                <button onClick={() => void navigator.clipboard.writeText(text)}>Copy JSON</button>
            </footer>
        </Frame>
    );
}

export function WhatsNewOverlay() {
    const open = useStore((s) => s.whatsNewOpen);
    const pending = useStore((s) => s.pendingUpdate);
    const installedNotes = useStore((s) => s.lastReleaseNotes);
    const [version, setVersion] = useState("");
    useEffect(() => {
        if (open) void getVersion().then(setVersion);
    }, [open]);
    if (!open) return null;
    return (
        <Frame label="What’s new" onClose={cmd.closeWhatsNew}>
            <p className="experience-deck">
                You are on Sikemux v{version || "…"}. Release notes stay reachable here instead of disappearing into an update tooltip.
            </p>
            <div className="release-notes">
                {pending?.notes ||
                    installedNotes?.notes ||
                    (pending
                        ? `Version ${pending.version} is ready.`
                        : installedNotes
                          ? `Updated to ${installedNotes.version}.`
                          : "You are up to date. No newer release notes are available yet.")}
            </div>
            <footer>
                {pending && (
                    <button className="primary" disabled={pending.state === "installing"} onClick={() => void installPendingUpdate()}>
                        {pending.state === "installing" ? "Installing…" : `Install v${pending.version}`}
                    </button>
                )}
            </footer>
        </Frame>
    );
}
