import {
  WS_METHODS,
  type ResumableAgentSession,
  type AgentSessionLookupInput,
} from "@t3tools/contracts";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { fileBasename } from "../markdownLinks.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Resume picker RPCs, instantiated by each client with its own connection
 * runtime. Refresh after attachment because reopening within the idle TTL
 * reuses the cached list without revalidating it.
 */
export function createAgentSessionResumeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-sessions:list",
    tag: WS_METHODS.agentSessionsList,
    staleTimeMs: 0,
    idleTtlMs: 30_000,
  });
  return {
    list,
    lookup: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-sessions:lookup",
      tag: WS_METHODS.agentSessionsLookup,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    attach: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:attach",
      tag: WS_METHODS.agentSessionsAttach,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(list({ environmentId, input: { projectId: input.projectId } }));
        }),
    }),
  };
}

const RESUME_COMMAND_PREFIX = /^(?:codex\s+resume|claude\s+--resume)\s+/i;

/** Matches title, ID, branch, directory, or provider. A pasted resume command matches its ID. */
export function filterResumableSessions(
  sessions: ReadonlyArray<ResumableAgentSession>,
  search: string,
): ReadonlyArray<ResumableAgentSession> {
  const query = normalizeSearchQuery(search, { trimLeadingPattern: RESUME_COMMAND_PREFIX });
  if (!query) return sessions;
  return sessions.filter((session) =>
    [session.title, session.sessionId, session.branch, session.cwd, session.provider].some(
      (value) => value?.toLowerCase().includes(query),
    ),
  );
}

/** The branch a session ran on, or its directory name outside Git. */
export function resumableSessionLocation(session: ResumableAgentSession): string {
  return session.branch ?? fileBasename(session.cwd);
}

/** Recognize pasted commands without executing shell syntax; bare IDs must be UUIDs. */
export function parseAgentSessionReference(value: string): AgentSessionLookupInput | null {
  const text = value.trim();
  const command = /^(codex\s+resume|claude\s+--resume)\s+([a-z0-9_-]{1,256})$/i.exec(text);
  if (command)
    return {
      provider: command[1]!.toLowerCase().startsWith("codex") ? "codex" : "claudeAgent",
      sessionId: command[2]!,
    };
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text) ? { sessionId: text } : null;
}
