import type {
  AgentSessionLookupInput,
  AgentSessionLookupMatch,
  AgentSessionLookupResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

export type EnvironmentSessionMatch = AgentSessionLookupMatch & { environmentId: EnvironmentId };

const emptySearch = (key: string) => ({
  key,
  matches: [] as ReadonlyArray<EnvironmentSessionMatch>,
  errors: [] as ReadonlyArray<{ environmentId: EnvironmentId; message: string }>,
  pending: false,
  searched: false,
  expanded: false,
  truncated: false,
});

/** Explicit searches stay on the chosen server until the user expands to connected environments. */
export function useAgentSessionLookup({
  input,
  environmentId,
  connectedEnvironmentIds,
  lookup,
}: {
  input: AgentSessionLookupInput;
  environmentId: EnvironmentId | null;
  connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  lookup: (
    environmentId: EnvironmentId,
    input: AgentSessionLookupInput,
  ) => Promise<AgentSessionLookupResult>;
}) {
  const key = JSON.stringify([environmentId, input.provider, input.sessionId]);
  const [state, setState] = useState(() => emptySearch(key));
  if (state.key !== key) setState(emptySearch(key));
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  async function search(all = false) {
    const current = ++generation.current;
    setState({ ...emptySearch(key), pending: true, expanded: all });
    const ids = all ? connectedEnvironmentIds : environmentId ? [environmentId] : [];
    const results = await Promise.allSettled(
      ids.map(async (id) => ({ id, result: await lookup(id, input) })),
    );
    if (generation.current !== current) return;
    const matches: EnvironmentSessionMatch[] = [];
    const errors: Array<{ environmentId: EnvironmentId; message: string }> = [];
    let truncated = false;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        matches.push(
          ...result.value.result.matches.map((match) => ({
            ...match,
            environmentId: result.value.id,
          })),
        );
        truncated ||= result.value.result.truncated;
      } else {
        errors.push({
          environmentId: ids[index]!,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : "Could not search this environment.",
        });
      }
    });
    matches.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
    setState((latest) =>
      latest.key === key
        ? { key, matches, errors, truncated, pending: false, searched: true, expanded: all }
        : latest,
    );
  }
  return { ...state, search };
}
