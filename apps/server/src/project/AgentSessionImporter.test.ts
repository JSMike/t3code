import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentSessionResumeError,
  ClaudeSettings,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type AgentSessionSource,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";
import { OrchestrationEventInfrastructureLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const workspaceRoot = "/workspace/project";
const sessionId = "5c119ee3-f063-4999-87ce-a062d004c37c";
const timestamp = "2026-09-01T10:00:00.000Z";
const at = DateTime.makeUnsafe(timestamp);
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};

function selectedSession(provider: AgentSessionSource = "codex", instanceId: string = provider) {
  const providerInstanceId = ProviderInstanceId.make(instanceId);
  const session = {
    provider,
    providerInstanceId,
    sessionId,
    title: "Continue the CLI task",
    cwd: "/external/worktrees/feature",
    branch: "feature/from-cli",
    updatedAt: timestamp,
  };
  return {
    session,
    isProjectRoot: false,
    source: {
      provider,
      providerInstanceId,
      providerSessionId: sessionId,
      filePath: `/homes/${instanceId}/${sessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId: sessionId,
      title: "Continue the CLI task",
      model: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  };
}

const persistence = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer))),
  ProviderSessionRuntime.layer,
  IdAllocator.layer,
).pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

function testLayer(selections = [selectedSession()]) {
  return AgentSessionImporter.layer.pipe(
    Layer.provideMerge(persistence),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(AgentSessionScanner.AgentSessionScanner, {
        scan: Effect.die("unused"),
        recentThreads: () =>
          Stream.fromIterable(
            selections.map((selected) => ({
              _tag: "Importable" as const,
              source: selected.source,
              thread: selected.thread,
            })),
          ),
        listSessions: (_cwd, excluded) =>
          Effect.succeed({
            sessions: selections
              .map((selected) => selected.session)
              .filter(
                (session) =>
                  !excluded?.has(
                    AgentSessionScanner.agentSessionKey(
                      session.provider,
                      session.providerInstanceId,
                      session.sessionId,
                    ),
                  ),
              ),
            truncated: false,
          }),
        lookupSession: () =>
          Effect.succeed({
            matches: selections.map(({ session }) => ({
              session,
              project: {
                path: workspaceRoot,
                title: "Project",
                projectId,
                alreadyImported: true,
                sources: [session.provider],
                threadCount: 1,
                lastActiveAt: timestamp,
              },
            })),
            truncated: false,
          }),
        readSession: (_cwd, instanceId) => {
          const selected = selections.find(
            (candidate) => candidate.session.providerInstanceId === instanceId,
          );
          return selected
            ? Effect.succeed(selected)
            : Effect.fail(new AgentSessionResumeError({ message: "Missing session" }));
        },
      }),
    ),
  );
}

const attachInput = (providerInstanceId = ProviderInstanceId.make("codex")) => ({
  projectId,
  providerInstanceId,
  sessionId,
});
const updateThread = Effect.fnUntraced(function* (
  thread: OrchestrationV2AppThread,
  patch: Partial<OrchestrationV2AppThread>,
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const eventId = yield* ids.allocate.event({ threadId: thread.id });
  yield* sink.write({
    events: [
      {
        id: eventId,
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: at,
        payload: { ...thread, ...patch },
      },
    ],
  });
});

// Recreate the persisted shape written before nativeThreadOrigin was introduced.
const upgradeUnmarkedImports = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(payload_json, '$.nativeThreadOrigin')
    WHERE application_event_version = 2 AND event_type = 'provider-thread.updated'
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_provider_threads
    SET payload_json = json_remove(payload_json, '$.nativeThreadOrigin')
  `;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 57`;
  yield* runMigrations();
});

const rebuildProjections = ProjectionMaintenance.ProjectionMaintenanceV2.use(
  (maintenance) => maintenance.rebuild,
).pipe(Effect.provide(ProjectionMaintenance.layer));

it.effect.each(["codex", "claudeAgent"] as const)(
  "attaches %s history and native identity in the original worktree",
  (provider) =>
    Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const selected = selectedSession(provider);
      const input = attachInput(selected.session.providerInstanceId);
      const result = yield* importer.attachAgentSession(input);
      const projection = yield* projections.getThreadProjection(result.threadId);
      expect(projection.thread).toMatchObject({
        projectId,
        worktreePath: selected.session.cwd,
        branch: selected.session.branch,
        settledOverride: null,
      });
      expect(projection.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
      expect(projection.turnItems.map((item) => item.type)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(projection.runs).toEqual([]);
      expect(projection.providerSessions).toEqual([]);
      const context = yield* projections.getThreadProviderContext(
        result.threadId,
        selected.session.providerInstanceId,
      );
      expect(context.providerThreads[0]?.nativeThreadRef).toEqual({
        driver: provider,
        nativeId: sessionId,
        strength: "strong",
      });
      const sequence = yield* (yield* EventSink.EventSinkV2).latestSequence();
      expect(yield* importer.attachAgentSession(input)).toEqual(result);
      expect(yield* (yield* EventSink.EventSinkV2).latestSequence()).toBe(sequence);
      expect((yield* importer.listAgentSessions({ projectId })).sessions).toEqual([]);
      expect((yield* importer.lookupAgentSession({ sessionId })).matches).toEqual([]);
    }).pipe(Effect.provide(testLayer([selectedSession(provider)]))),
);
it.effect.each(
  (["picker", "wizard"] as const).flatMap((entryPoint) =>
    (["current", "previous", "previous-rebuilt"] as const).map((savedState) => ({
      entryPoint,
      savedState,
    })),
  ),
)(
  "resumes an existing Claude session on the first follow-up after a $entryPoint import ($savedState)",
  ({ entryPoint, savedState }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const selection = selectedSession("claudeAgent");
        const instanceId = selection.session.providerInstanceId;
        if (entryPoint === "picker") {
          yield* importer.attachAgentSession(attachInput(instanceId));
        } else {
          yield* importer.importRecentAgentThreads({ projectId });
        }
        if (savedState !== "current") yield* upgradeUnmarkedImports;
        if (savedState === "previous-rebuilt") yield* rebuildProjections;
        const claims = yield* projections.getProviderSessionClaims();
        const projection = yield* projections.getThreadProjection(claims[0]!.threadId);
        expect(projection.providerTurns).toEqual([]);
        expect(projection.runs).toEqual([]);
        const providerThread = projection.providerThreads[0]!;
        const appThread = projection.thread;
        const fileSystem = yield* FileSystem.FileSystem;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-imported-claude-first-turn-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId,
          settings: claudeSettings,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.die("An imported session must keep its native ID"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: appThread.runtimeMode,
          interactionMode: appThread.interactionMode,
          cwd: appThread.worktreePath ?? workspaceRoot,
        });
        const runtime = yield* adapter.openSession({
          threadId: appThread.id,
          providerSessionId: ProviderSessionId.make(`claude-import-${entryPoint}`),
          modelSelection: appThread.modelSelection,
          runtimePolicy,
        });
        const resumed = yield* runtime.resumeThread({
          providerThread,
          threadId: appThread.id,
          modelSelection: appThread.modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn({
          appThread,
          threadId: appThread.id,
          runId: RunId.make("first-imported-follow-up"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("first-imported-follow-up-attempt"),
          rootNodeId: NodeId.make("first-imported-follow-up-root"),
          providerThread: resumed,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("first-imported-follow-up-message"),
            text: "Continue the CLI work here",
            attachments: [],
          },
          modelSelection: appThread.modelSelection,
          runtimePolicy,
        });
        expect(openedQueries).toHaveLength(1);
        expect(openedQueries[0]!.options.resume).toBe(sessionId);
        expect(openedQueries[0]!.options).not.toHaveProperty("sessionId");
      }).pipe(
        Effect.provide(
          Layer.merge(testLayer([selectedSession("claudeAgent")]), NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "backfills only proven imports, including later updates, through a projection rebuild",
  () =>
    Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const { threadId } = yield* importer.attachAgentSession(
        attachInput(ProviderInstanceId.make("claudeAgent")),
      );
      const imported = (yield* projections.getThreadProjection(threadId)).providerThreads[0]!;
      const fixtures = [
        { ...imported, status: "not_loaded" as const },
        {
          ...imported,
          id: ProviderThreadId.make("fresh-preallocated-thread"),
          nativeThreadRef: { ...imported.nativeThreadRef!, nativeId: "fresh-native-id" },
        },
        {
          ...imported,
          id: ProviderThreadId.make("same-native-id-different-thread"),
        },
        {
          ...imported,
          providerInstanceId: ProviderInstanceId.make("another-claude-account"),
        },
        {
          ...imported,
          nativeThreadRef: { ...imported.nativeThreadRef!, nativeId: "replacement-native-id" },
        },
      ];
      yield* sink.write({
        events: fixtures.map((payload, index) => ({
          id: EventId.make(`later-provider-update-${index}`),
          type: "provider-thread.updated" as const,
          threadId,
          occurredAt: at,
          payload,
        })),
      });
      const sequence = yield* sink.latestSequence();
      yield* upgradeUnmarkedImports;
      const events = yield* (yield* EventStore.EventStoreV2)
        .read({ threadId, eventType: "provider-thread.updated" })
        .pipe(Stream.runCollect);
      expect(
        events.map(({ event }) =>
          event.type === "provider-thread.updated" ? event.payload.nativeThreadOrigin : undefined,
        ),
      ).toEqual(["imported", "imported", undefined, undefined, undefined, undefined]);
      const beforeReplay = yield* projections.getThreadProjection(threadId);
      expect(beforeReplay.providerThreads).toHaveLength(3);
      expect(beforeReplay.providerThreads.every((thread) => !thread.nativeThreadOrigin)).toBe(true);
      yield* rebuildProjections;
      expect((yield* projections.getThreadProjection(threadId)).providerThreads).toEqual(
        beforeReplay.providerThreads,
      );
      expect(yield* sink.latestSequence()).toBe(sequence);
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(testLayer([selectedSession("claudeAgent")]))),
);

it.effect("onboarding still imports once, with settled history and its native binding", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    const claims = yield* (yield* ProjectionStore.ProjectionStoreV2).getProviderSessionClaims();
    expect(claims).toHaveLength(1);
    const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
      claims[0]!.threadId,
    );
    expect(projection.thread).toMatchObject({ worktreePath: null, settledOverride: "settled" });
    expect(projection.messages).toHaveLength(2);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("excludes archived sessions and permits a fresh import after deletion", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const first = yield* importer.attachAgentSession(attachInput());
    const thread = yield* projections.getThread(first.threadId);
    yield* updateThread(thread, { archivedAt: at });
    expect((yield* importer.listAgentSessions({ projectId })).sessions).toEqual([]);
    expect((yield* importer.lookupAgentSession({ sessionId })).matches).toEqual([]);
    const error = yield* importer.attachAgentSession(attachInput()).pipe(Effect.flip);
    expect(error.message).toContain("archived");
    yield* updateThread(thread, { deletedAt: at });
    expect((yield* importer.listAgentSessions({ projectId })).sessions).toHaveLength(1);
    const second = yield* importer.attachAgentSession(attachInput());
    expect(second.threadId).not.toBe(first.threadId);
    expect((yield* projections.getThread(first.threadId)).deletedAt).toEqual(at);
    expect((yield* projections.getThreadProjection(second.threadId)).messages).toHaveLength(2);
    expect(yield* importer.attachAgentSession(attachInput())).toEqual(second);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("keeps identical native IDs isolated by provider instance", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const first = yield* importer.attachAgentSession(attachInput());
    const second = yield* importer.attachAgentSession(
      attachInput(ProviderInstanceId.make("codex_other")),
    );
    expect(first.threadId).not.toBe(second.threadId);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect(
      (yield* projections.getProviderSessionClaims())
        .map((claim) => claim.providerInstanceId)
        .sort(),
    ).toEqual(["codex", "codex_other"]);
    const a = yield* projections.getThread(first.threadId);
    const b = yield* projections.getThread(second.threadId);
    expect(a.activeProviderThreadId).not.toBe(b.activeProviderThreadId);
  }).pipe(Effect.provide(testLayer([selectedSession(), selectedSession("codex", "codex_other")]))),
);

it.effect("serializes concurrent attachments and onboarding imports", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const results = yield* Effect.all(
      [
        importer.attachAgentSession(attachInput()),
        importer.attachAgentSession(attachInput()),
        importer.importRecentAgentThreads({ projectId }),
      ],
      { concurrency: "unbounded" },
    );
    expect(results[0]).toEqual(results[1]);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect(yield* projections.getProviderSessionClaims()).toHaveLength(1);
    expect((yield* projections.getThreadProjection(results[0].threadId)).messages).toHaveLength(2);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("returns an existing native thread even when it belongs to another project", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const first = yield* importer.attachAgentSession(attachInput());
    const thread = yield* projections.getThread(first.threadId);
    yield* updateThread(thread, {
      projectId: ProjectId.make("other-project"),
      historyOrigin: "native",
    });
    expect((yield* importer.listAgentSessions({ projectId })).sessions).toEqual([]);
    expect(yield* importer.attachAgentSession(attachInput())).toEqual(first);
  }).pipe(Effect.provide(testLayer())),
);

it.effect.each(["codex", "claudeAgent"] as const)(
  "keeps migrated %s sessions out of the picker until their T3 thread is deleted",
  (provider) =>
    Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const selection = selectedSession(provider);
      const input = attachInput(selection.session.providerInstanceId);
      const first = yield* importer.attachAgentSession(input);
      const imported = yield* projections.getThread(first.threadId);
      yield* updateThread(imported, { deletedAt: at });
      const legacyThreadId = ThreadId.make(`legacy-${provider}`);
      const legacyThread = {
        ...imported,
        id: legacyThreadId,
        activeProviderThreadId: null,
        lineage: { ...imported.lineage, rootThreadId: legacyThreadId },
      };
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId: legacyThreadId }),
            type: "thread.created",
            threadId: legacyThreadId,
            occurredAt: at,
            payload: legacyThread,
          },
        ],
      });
      yield* runtimes.upsert({
        threadId: legacyThreadId,
        providerName: provider,
        providerInstanceId: null,
        adapterKey: provider,
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: timestamp,
        resumeCursor: provider === "codex" ? { threadId: sessionId } : { resume: sessionId },
        runtimePayload: null,
      });
      expect((yield* importer.listAgentSessions({ projectId })).sessions).toEqual([]);
      expect((yield* importer.lookupAgentSession({ sessionId })).matches).toEqual([]);
      expect(yield* importer.attachAgentSession(input)).toEqual({ threadId: legacyThreadId });
      yield* updateThread(legacyThread, { deletedAt: at });
      expect((yield* importer.listAgentSessions({ projectId })).sessions).toHaveLength(1);
    }).pipe(Effect.provide(testLayer([selectedSession(provider)]))),
);

it.effect("rolls back unpublished history and retries the import without duplicates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* sql`CREATE TRIGGER reject_import BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT, 'test import failure'); END`;
    yield* importer.attachAgentSession(attachInput()).pipe(Effect.flip);
    expect(yield* projections.getProviderSessionClaims()).toEqual([]);
    expect((yield* projections.getShellSnapshot()).threads).toEqual([]);
    yield* sql`DROP TRIGGER reject_import`;
    const result = yield* importer.attachAgentSession(attachInput());
    expect((yield* projections.getThreadProjection(result.threadId)).messages).toHaveLength(2);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("rejects stale or missing project imports without publishing history", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(
      (yield* importer
        .importRecentAgentThreads({ projectId, expectedWorkspaceRoot: "/moved" })
        .pipe(Effect.flip))._tag,
    ).toBe("AgentSessionImportProjectChangedError");
    expect(
      (yield* importer
        .listAgentSessions({ projectId: ProjectId.make("missing") })
        .pipe(Effect.flip))._tag,
    ).toBe("AgentSessionImportProjectNotFoundError");
    expect(yield* (yield* EventSink.EventSinkV2).latestSequence()).toBe(0);
  }).pipe(Effect.provide(testLayer())),
);
