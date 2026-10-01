import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  filterResumableSessions,
  resumableSessionLocation,
} from "@t3tools/client-runtime/state/agentSessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ResumableAgentSession,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { agentSessionAttach, agentSessionList } from "../state/agentSessions";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { waitForStartedServerThread } from "./ChatView.logic";
import { ComposerControl, ComposerControlChevron } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";

/** Browsing is read-only; selecting attaches history and opens the native session's T3 thread. */
export function ResumeSessionPicker({ projectRef }: { projectRef: ScopedProjectRef }) {
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [search, setSearch] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachingRef = useRef(false);
  const floatingLayerProps = useComposerMenuProps();
  const navigate = useNavigate();
  const attach = useAtomCommand(agentSessionAttach, { reportFailure: false });
  const queryAtom = useMemo(
    () =>
      open
        ? agentSessionList({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId },
          })
        : null,
    [open, projectRef.environmentId, projectRef.projectId],
  );
  const query = useEnvironmentQuery(queryAtom);
  const sessions = useMemo(
    () => filterResumableSessions(query.data?.sessions ?? [], search),
    [query.data, search],
  );

  /** Attach once per selection and navigate in the owning environment unless the picker unmounted. */
  const select = async (session: ResumableAgentSession) => {
    if (attachingRef.current) return;
    attachingRef.current = true;
    setAttaching(true);
    setError(null);
    try {
      const result = await attach({
        environmentId: projectRef.environmentId,
        input: {
          projectId: projectRef.projectId,
          providerInstanceId: session.providerInstanceId,
          sessionId: session.sessionId,
        },
      });
      if (!mounted.current) return;
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const threadRef = scopeThreadRef(projectRef.environmentId, result.value.threadId);
      if (!(await waitForStartedServerThread(threadRef, 10_000))) {
        throw new Error(
          "The session was imported, but its history has not reached this client yet. Open it from the thread list.",
        );
      }
      if (!mounted.current) return;
      setOpen(false);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not resume this session.");
    } finally {
      attachingRef.current = false;
      if (mounted.current) setAttaching(false);
    }
  };

  return (
    <Combobox<ResumableAgentSession>
      items={sessions}
      filter={null}
      value={null}
      open={open}
      onOpenChange={(value) => {
        if (!attachingRef.current) {
          setOpen(value);
          setError(null);
          setSearch("");
        }
      }}
      onValueChange={(value) => {
        if (value) void select(value);
      }}
      itemToStringLabel={(item) => item.title}
    >
      <ComboboxTrigger
        render={<ComposerControl size="xs" />}
        aria-label="Resume a session"
        data-composer-context-control
      >
        <HistoryIcon className="size-3" />
        <span>Resume</span>
        <ComposerControlChevron size="xs" />
      </ComboboxTrigger>
      <ComboboxPopup side="top" align="start" className="w-96" {...floatingLayerProps}>
        <ComboboxSearchInput
          placeholder="Search sessions or paste a resume command…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span>Codex and Claude · All project worktrees</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={query.isPending || attaching}
            onClick={query.refresh}
          >
            Refresh
          </Button>
        </div>
        {error || query.error ? <ComboboxStatus>{error ?? query.error}</ComboboxStatus> : null}
        {attaching ? (
          <ComboboxStatus>Opening session…</ComboboxStatus>
        ) : query.isPending && !query.data ? (
          <ComboboxStatus>Finding sessions…</ComboboxStatus>
        ) : (
          <>
            {!query.error ? <ComboboxEmpty>No external sessions found.</ComboboxEmpty> : null}
            <ComboboxList>
              {(session: ResumableAgentSession) => {
                const providerName =
                  PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(session.provider)] ??
                  session.provider;
                return (
                  <ComboboxItem
                    key={`${session.providerInstanceId}:${session.sessionId}`}
                    value={session}
                    hideIndicator
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2 py-1">
                      <ProviderInstanceIcon
                        driverKind={ProviderDriverKind.make(session.provider)}
                        displayName={providerName}
                        className="mt-0.5 size-4 shrink-0"
                        iconClassName="size-4"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{session.title}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {providerName} · {resumableSessionLocation(session)}
                        </div>
                      </div>
                      <time
                        className="shrink-0 text-xs text-muted-foreground"
                        dateTime={session.updatedAt}
                      >
                        {formatRelativeTimeLabel(session.updatedAt)}
                      </time>
                    </div>
                  </ComboboxItem>
                );
              }}
            </ComboboxList>
          </>
        )}
        {query.data?.truncated ? (
          <ComboboxStatus>Some sessions could not be listed.</ComboboxStatus>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
