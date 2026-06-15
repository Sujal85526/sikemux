import { useCallback, useEffect, useMemo, useState } from "react";
import * as cmd from "../../state/commands";
import { subscribe } from "../../state/bus";
import { useResourceEnabled } from "../../state/resources";
import { brunoCollectionR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { DEFAULT_BRUNO_VIEW } from "../../state/types";
import { parseRequest } from "../../bruno/parse";
import { serializeRequest } from "../../bruno/serialize";
import { buildScope, findRequest, requestVars, selectedEnvOf } from "../../bruno/resolve";
import { mergeScope, type Scope } from "../../bruno/interpolate";
import { runRequest, type RunResult } from "../../bruno/run";
import type { BruRequest, BruScope } from "../../bruno/types";
import { basename } from "../../lib/paths";
import { IconBruno, IconClose } from "../Icons";
import { BrunoEnvSelect } from "./BrunoEnvSelect";
import { BrunoTree } from "./BrunoTree";
import { BrunoRequestView } from "./BrunoRequest";
import { BrunoResponseView } from "./BrunoResponse";

interface Props {
    paneId: string;
    sessionId: string;
    active: boolean;
}

function safeParse(text: string, fallback: BruRequest | null): BruRequest | null {
    try {
        return parseRequest(text);
    } catch {
        return fallback;
    }
}

export function BrunoPane({ sessionId, active }: Props) {
    const session = useStore((s) => s.sessions[sessionId]);
    const bruno = session?.bruno ?? null;
    const collectionPath = bruno?.collectionPath ?? "";
    const view = useStore((s) => s.brunoViews[sessionId] ?? DEFAULT_BRUNO_VIEW);
    const drafts = bruno?.drafts ?? {};
    const secretVars = bruno?.secretVars ?? {};
    const selectedEnvs = bruno?.selectedEnvs ?? {};

    const coll = useResourceEnabled(active && !!collectionPath, brunoCollectionR, collectionPath);
    const collection = coll.data;

    const [results, setResults] = useState<Record<string, RunResult>>({});
    const [running, setRunning] = useState<Record<string, boolean>>({});
    const [editing, setEditing] = useState<{ path: string; req: BruRequest } | null>(null);
    const [runtime, setRuntime] = useState<Scope>({});

    const path = view.activeRequestPath;
    const located = useMemo(() => (collection && path ? findRequest(collection.tree, path) : null), [collection, path]);
    const diskRequest = located?.request ?? null;
    const draft = path ? (drafts[path] ?? null) : null;

    const effectiveRequest = useMemo<BruRequest | null>(() => {
        if (editing && path && editing.path === path) return editing.req;
        if (draft != null) return safeParse(draft, diskRequest);
        return diskRequest;
    }, [editing, path, draft, diskRequest]);

    // Scope the environment picker to the open request's collection.
    const reqCollPath = located?.collectionPath ?? "";
    const visibleEnvs = useMemo(() => {
        if (!collection) return [];
        return reqCollPath ? collection.envs.filter((e) => e.collectionPath === reqCollPath) : collection.envs;
    }, [collection, reqCollPath]);
    const showEnvCollection = !reqCollPath; // only disambiguate by collection when not scoped
    const selectedEnvId = selectedEnvs[reqCollPath] ?? null;
    const env = collection ? selectedEnvOf(collection, selectedEnvId) : undefined;
    const secretNames = env?.secretNames ?? [];
    const inheritedScope = useMemo(() => {
        if (!collection) return {} as Scope;
        return buildScope({ collection, env, secretVars, folderScopes: located?.folderScopes ?? [] });
    }, [collection, env, secretVars, located]);
    const scope = useMemo(() => mergeScope(runtime, requestVars(effectiveRequest), inheritedScope), [runtime, effectiveRequest, inheritedScope]);

    const openTabs = useMemo(
        () =>
            view.openPaths.map((p) => {
                const loc = collection ? findRequest(collection.tree, p) : null;
                return {
                    path: p,
                    name: loc?.request.meta.name || basename(p).replace(/\.bru$/, ""),
                    method: loc?.request.method ?? "get",
                    dirty: drafts[p] != null,
                };
            }),
        [view.openPaths, collection, drafts],
    );

    const onChange = useCallback(
        (next: BruRequest) => {
            if (!path) return;
            setEditing({ path, req: next });
            const serialized = serializeRequest(next);
            const diskSer = diskRequest ? serializeRequest(diskRequest) : "";
            cmd.brunoSetDraft(sessionId, path, serialized === diskSer ? null : serialized);
        },
        [path, diskRequest, sessionId],
    );

    const onSend = useCallback(async () => {
        if (!path || !effectiveRequest || !collection) return;
        const scopes = [collection.config, ...(located?.folderScopes ?? [])].filter(Boolean) as BruScope[];
        setRunning((r) => ({ ...r, [path]: true }));
        try {
            const result = await runRequest({ request: effectiveRequest, scopes, vars: scope });
            setResults((r) => ({ ...r, [path]: result }));
            if (Object.keys(result.envUpdates).length) {
                setRuntime((prev) => ({ ...prev, ...result.envUpdates }));
                // persist any script-updated secret values (e.g. a refreshed token)
                for (const [k, v] of Object.entries(result.envUpdates)) {
                    if (secretNames.includes(k)) cmd.brunoSetSecret(sessionId, k, v);
                }
            }
        } finally {
            setRunning((r) => ({ ...r, [path]: false }));
        }
    }, [path, effectiveRequest, collection, located, scope, runtime, secretNames, sessionId]);

    const onSave = useCallback(() => {
        if (!path) return;
        void cmd.brunoSaveRequest(sessionId, path).then(() => setEditing(null));
    }, [path, sessionId]);

    // ⌘↵ from anywhere in the pane: the keymap emits, we run.
    useEffect(() => {
        return subscribe("bruno-run", (e) => {
            if (e.sessionId === sessionId) void onSend();
        });
    }, [sessionId, onSend]);

    if (!bruno) return <div className="bruno-pane bruno-empty">not a Bruno workspace</div>;

    return (
        <div className="bruno-pane" data-active={active ? "1" : "0"}>
            <header className="bruno-head">
                <span className="bruno-head-mark">
                    <IconBruno size={15} />
                </span>
                <span className="bruno-coll-name" title={collectionPath}>
                    {collection?.name || basename(collectionPath)}
                </span>
                <BrunoEnvSelect
                    sessionId={sessionId}
                    collectionPath={reqCollPath}
                    envs={visibleEnvs}
                    showCollection={showEnvCollection}
                    selected={selectedEnvId}
                    secretNames={secretNames}
                    secretVars={secretVars}
                    secretsOpen={view.secretsOpen}
                />
            </header>
            <div className="bruno-cols">
                <BrunoTree
                    sessionId={sessionId}
                    collectionPath={collectionPath}
                    tree={collection?.tree ?? []}
                    activePath={path}
                    drafts={drafts}
                    running={running}
                    loading={coll.status === "loading" && !collection}
                    error={coll.error ?? null}
                    onSelect={(p) => cmd.brunoSelectRequest(sessionId, p)}
                    onReload={() => void coll.refresh()}
                />
                <div className="bruno-main">
                    {openTabs.length > 0 && (
                        <div className="bruno-reqtabs">
                            {openTabs.map((t) => (
                                <div
                                    key={t.path}
                                    className={`bruno-reqtab${t.path === path ? " active" : ""}`}
                                    role="button"
                                    tabIndex={0}
                                    title={t.path}
                                    onClick={() => cmd.brunoSelectRequest(sessionId, t.path)}>
                                    <span className={`bruno-method m-${t.method}`}>{t.method.toUpperCase()}</span>
                                    <span className="bruno-reqtab-name">{t.name}</span>
                                    {t.dirty && <span className="bruno-row-dirty" title="unsaved changes" />}
                                    <button
                                        className="bruno-reqtab-x"
                                        title="Close tab"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            cmd.brunoCloseTab(sessionId, t.path);
                                        }}>
                                        <IconClose size={10} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    {effectiveRequest && path ? (
                        <>
                            <BrunoRequestView
                                request={effectiveRequest}
                                tab={view.reqTab}
                                scope={scope}
                                running={!!running[path]}
                                dirty={draft != null}
                                onChange={onChange}
                                onSend={() => void onSend()}
                                onSave={onSave}
                                onTab={(t) => cmd.brunoSetReqTab(sessionId, t)}
                            />
                            <BrunoResponseView
                                result={results[path] ?? null}
                                running={!!running[path]}
                                tab={view.resTab}
                                onTab={(t) => cmd.brunoSetResTab(sessionId, t)}
                            />
                        </>
                    ) : (
                        <div className="bruno-empty bruno-empty-main">
                            <span>select a request from the collection</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
