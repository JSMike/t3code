import { StackActions, useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  useAgentSessionLookup,
  type EnvironmentSessionMatch,
} from "@t3tools/client-runtime/state/useAgentSessionLookup";
import {
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type AgentSessionLookupInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ProviderIcon } from "../../components/ProviderIcon";
import { agentSessionAttach, agentSessionLookup } from "../../state/agentSessions";
import { relativeTime } from "../../lib/time";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

/** Resolve an external session on its owning server before selecting or onboarding a project. */
export function SessionReferenceLookup({
  input,
  environmentId,
}: {
  input: AgentSessionLookupInput;
  environmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const targetEnvironmentId =
    environmentId ??
    environments.find((env) => env.connection.phase === "connected")?.environmentId ??
    null;
  const navigation = useNavigation();
  const runLookup = useAtomQueryRunner(agentSessionLookup, { reportFailure: false, refresh: true });
  const attach = useAtomCommand(agentSessionAttach, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
  async function resume(match: EnvironmentSessionMatch) {
    if (!match.project.projectId) {
      navigation.dispatch(
        StackActions.push("AddProjectLocal", {
          environmentId: match.environmentId,
          workspaceRoot: match.project.path,
          resumeSessionId: match.session.sessionId,
          resumeProviderInstanceId: match.session.providerInstanceId,
        }),
      );
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await attach({
      environmentId: match.environmentId,
      input: {
        projectId: match.project.projectId,
        sessionId: match.session.sessionId,
        providerInstanceId: match.session.providerInstanceId,
      },
    });
    busyRef.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result._tag !== "Success") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not resume session.");
      return;
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: match.environmentId,
        threadId: result.value.threadId,
      }),
    );
  }
  return (
    <View className="gap-3">
      <Text className="text-foreground-muted">
        Find this CLI session on {label(targetEnvironmentId)}.
      </Text>
      <MaterialButton
        label={search.pending ? "Searching…" : "Find session"}
        disabled={search.pending || busy || !targetEnvironmentId}
        onPress={() => void search.search()}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
      {search.errors.map((failure) => (
        <Text accessibilityRole="alert" key={failure.environmentId} className="text-destructive">
          {label(failure.environmentId)}: {failure.message}
        </Text>
      ))}
      {search.searched &&
      !search.pending &&
      search.matches.length === 0 &&
      search.errors.length === 0 ? (
        <Text className="text-foreground-muted">
          No external session found. Sessions already in T3 are excluded.
        </Text>
      ) : null}
      {search.truncated ? (
        <Text className="text-foreground-muted">Some session files could not be searched.</Text>
      ) : null}
      {search.matches.map((match) => (
        <View
          key={`${match.environmentId}:${match.session.providerInstanceId}:${match.session.sessionId}`}
          className="gap-2 rounded-xl bg-card p-3"
        >
          <View className="flex-row items-center gap-2">
            <ProviderIcon provider={ProviderDriverKind.make(match.session.provider)} size={18} />
            <Text className="flex-1 text-foreground font-t3-medium">{match.session.title}</Text>
          </View>
          <Text className="text-foreground-muted">
            {PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(match.session.provider)]} ·{" "}
            {label(match.environmentId)} · {match.project.title} ·{" "}
            {relativeTime(match.session.updatedAt)}
          </Text>
          <Text className="text-foreground-muted">{match.session.cwd}</Text>
          <MaterialButton
            label={busy ? "Resuming…" : match.project.projectId ? "Resume" : "Import project…"}
            disabled={busy}
            onPress={() => void resume(match)}
          />
        </View>
      ))}
      {search.searched &&
      !search.pending &&
      !search.expanded &&
      search.matches.length === 0 &&
      environments.some(
        (env) => env.environmentId !== targetEnvironmentId && env.connection.phase === "connected",
      ) ? (
        <MaterialButton
          label="Search connected environments"
          onPress={() => void search.search(true)}
        />
      ) : null}
    </View>
  );
}
