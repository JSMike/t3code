import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  useAgentSessionLookup,
  type EnvironmentSessionMatch,
} from "@t3tools/client-runtime/state/useAgentSessionLookup";
import {
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type AgentSessionLookupInput,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { agentSessionAttach, agentSessionLookup } from "../state/agentSessions";
import { useEnvironments } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { buildThreadRouteParams } from "../threadRoutes";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { Button } from "./ui/button";
import { waitForStartedServerThread } from "./ChatView.logic";

const ImportStep = lazy(() =>
  import("./onboarding/WelcomeWizard").then((module) => ({ default: module.ImportStep })),
);

/** Resolve a pasted reference before choosing a project, then reuse project onboarding when needed. */
export function SessionReferenceLookup({
  input,
  environmentId,
  onDone,
}: {
  input: AgentSessionLookupInput;
  environmentId: EnvironmentId | null;
  onDone: () => void;
}) {
  const { environments } = useEnvironments();
  const targetEnvironmentId =
    environmentId ??
    environments.find((env) => env.connection.phase === "connected")?.environmentId ??
    null;
  const runLookup = useAtomQueryRunner(agentSessionLookup, { reportFailure: false, refresh: true });
  const attach = useAtomCommand(agentSessionAttach, { reportFailure: false });
  const navigate = useNavigate();
  const [importing, setImporting] = useState<EnvironmentSessionMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const attaching = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const lookup = useCallback(
    async (id: EnvironmentId, reference: AgentSessionLookupInput) => {
      const result = await runLookup({ environmentId: id, input: reference });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value;
    },
    [runLookup],
  );
  const search = useAgentSessionLookup({
    input,
    environmentId: targetEnvironmentId,
    connectedEnvironmentIds: environments
      .filter((env) => env.connection.phase === "connected")
      .map((env) => env.environmentId),
    lookup,
  });
  const label = (id: EnvironmentId | null) =>
    environments.find((env) => env.environmentId === id)?.label ?? "Selected environment";

  async function resume(
    match: EnvironmentSessionMatch,
    projectRef?: ScopedProjectRef,
  ): Promise<boolean> {
    const projectId = projectRef?.projectId ?? match.project.projectId;
    if (!projectId || attaching.current) return false;
    attaching.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await attach({
        environmentId: match.environmentId,
        input: {
          projectId,
          providerInstanceId: match.session.providerInstanceId,
          sessionId: match.session.sessionId,
        },
      });
      if (!active.current) return false;
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const threadRef = scopeThreadRef(match.environmentId, result.value.threadId);
      if (!(await waitForStartedServerThread(threadRef, 10_000))) {
        throw new Error(
          "The session was imported, but its history has not reached this client yet. Open it from the thread list.",
        );
      }
      if (!active.current) return false;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      onDone();
      return true;
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Could not resume session.");
      return false;
    } finally {
      attaching.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-3 p-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {importing ? (
        <Suspense fallback={<p role="status">Loading project import…</p>}>
          <ImportStep
            resumeOnly
            scans={[
              {
                environmentId: importing.environmentId,
                data: { candidates: [importing.project], scannedAt: importing.session.updatedAt },
                error: null,
                isPending: false,
                refresh: () => {},
              },
            ]}
            isImporting={busy}
            setIsImporting={setBusy}
            onDone={async (projectRef) => {
              if (!projectRef) {
                setImporting(null);
                return true;
              }
              return resume(importing, projectRef);
            }}
          />
        </Suspense>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Find this CLI session on {label(targetEnvironmentId)}.
          </p>
          <Button
            id="find-cli-session"
            size="sm"
            disabled={search.pending || busy || !targetEnvironmentId}
            onClick={() => void search.search()}
          >
            {search.pending ? "Searching…" : "Find session"}
          </Button>
          {search.searched &&
          !search.pending &&
          search.matches.length === 0 &&
          search.errors.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No external session found. Sessions already in T3 are excluded.
            </p>
          ) : null}
          {search.truncated ? (
            <p className="text-sm text-muted-foreground">
              Some session files could not be searched.
            </p>
          ) : null}
          {search.errors.map((failure) => (
            <p key={failure.environmentId} role="alert" className="text-sm text-destructive">
              {label(failure.environmentId)}: {failure.message}
            </p>
          ))}
          {search.matches.map((match) => {
            return (
              <div
                key={`${match.environmentId}:${match.session.providerInstanceId}:${match.session.sessionId}`}
                className="space-y-2 border-t pt-3"
              >
                <div className="flex items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={ProviderDriverKind.make(match.session.provider)}
                    displayName={
                      PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(match.session.provider)] ??
                      match.session.provider
                    }
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span className="min-w-0 truncate text-sm font-medium">
                    {match.session.title}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(match.session.provider)]} ·{" "}
                  {label(match.environmentId)} · {match.project.title} ·{" "}
                  {formatRelativeTimeLabel(match.session.updatedAt)}
                </p>
                <p className="break-all text-xs text-muted-foreground">{match.session.cwd}</p>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    match.project.projectId ? void resume(match) : setImporting(match)
                  }
                >
                  {busy ? "Resuming…" : match.project.projectId ? "Resume" : "Import project…"}
                </Button>
              </div>
            );
          })}
          {search.searched &&
          !search.pending &&
          search.matches.length === 0 &&
          !search.expanded &&
          environments.some(
            (env) =>
              env.environmentId !== targetEnvironmentId && env.connection.phase === "connected",
          ) ? (
            <Button size="sm" variant="outline" onClick={() => void search.search(true)}>
              Search connected environments
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
