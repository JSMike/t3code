import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionResumeError,
  importedAgentSessionThreadId,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type AgentSessionLookupInput,
  type AgentSessionLookupResult,
  type AgentSessionAttachInput,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

type ProjectReadError = AgentSessionScanError | AgentSessionImportProjectNotFoundError;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  {
    readonly importRecentAgentThreads: (
      input: AgentSessionImportInput,
    ) => Effect.Effect<
      AgentSessionImportResult,
      ProjectReadError | AgentSessionImportProjectChangedError
    >;
    readonly listAgentSessions: (
      input: AgentSessionListInput,
    ) => Effect.Effect<AgentSessionListResult, ProjectReadError>;
    readonly lookupAgentSession: (
      input: AgentSessionLookupInput,
    ) => Effect.Effect<AgentSessionLookupResult, AgentSessionScanError>;
    readonly attachAgentSession: (
      input: AgentSessionAttachInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, AgentSessionResumeError>;
  }
>()("t3/project/AgentSessionImporter") {}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importLock = yield* Semaphore.make(1);
  const readProject = Effect.fn("AgentSessionImporter.readProject")(function* (
    projectId: ProjectId,
  ) {
    return yield* projects.getById(projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
  });
  const readClaims = () =>
    projections
      .getProviderSessionClaims()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
  const claimKey = (claim: { provider: string; providerInstanceId: string; sessionId: string }) =>
    AgentSessionScanner.agentSessionKey(claim.provider, claim.providerInstanceId, claim.sessionId);

  // History and the native continuation reference become visible together in V2.
  const importThread = Effect.fn("AgentSessionImporter.importThread")(function* ({
    projectId,
    workspaceRoot,
    worktreePath,
    branch,
    thread,
    source,
    resume,
  }: {
    projectId: ProjectId;
    workspaceRoot: string;
    worktreePath: string | null;
    branch: string | null;
    thread: AgentSessionScanner.AgentSessionThread;
    source: AgentSessionImportSource;
    resume: boolean;
  }) {
    if (
      thread.source === "claudeAgent" &&
      !AgentSessionScanner.CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: thread.source,
        providerSessionId: thread.providerSessionId,
      });
    }
    const key = AgentSessionScanner.agentSessionKey(
      thread.source,
      thread.providerInstanceId,
      thread.providerSessionId,
    );
    const holders = (yield* readClaims()).filter((claim) => claimKey(claim) === key);
    const open = holders.find((claim) => !claim.archived);
    if (open) return open.threadId;
    if (holders.length > 0)
      return yield* new AgentSessionResumeError({
        message:
          "This session already belongs to an archived T3 thread. Reopen that thread to continue.",
      });
    let threadId = importedAgentSessionThreadId(
      thread.providerInstanceId,
      thread.providerSessionId,
    );
    const existing = yield* projections.getThread(threadId).pipe(
      Effect.map(Option.some),
      Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(Option.none())),
    );
    if (Option.isSome(existing)) {
      if (existing.value.deletedAt === null)
        return yield* new AgentSessionResumeError({
          message: "The previous import no longer owns this session. Use its existing T3 thread.",
        });
      // Deleted history stays deleted; a new import must use fresh message/event IDs.
      threadId = yield* idAllocator.allocate.thread({ projectId });
    }
    const driver = ProviderDriverKind.make(thread.source);
    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: thread.providerSessionId,
      providerInstanceId: thread.providerInstanceId,
    });
    const createdAt = dateTime(thread.createdAt);
    const updatedAt = dateTime(thread.updatedAt);
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: projectId,
      title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch,
      worktreePath,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: resume ? null : "settled",
      settledAt: resume ? null : updatedAt,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver,
        nativeId: thread.providerSessionId,
        strength: "strong",
      },
      nativeThreadOrigin: "imported",
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };

    yield* runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: workspaceRoot },
      },
      { onConflict: "ignore" },
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: createdAt,
          payload: appThread,
        },
        ...thread.messages.flatMap((message, index) => messageEvents({ threadId, index, message })),
        {
          id: EventId.make(
            `${IMPORT_EVENT_PREFIX}:provider-thread:${threadId}:${providerThreadId}`,
          ),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: updatedAt,
          payload: providerThread,
        },
      ],
    });
    yield* runtimes.recordImportedTranscript({ threadId, source });
    return threadId;
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* readProject(input.projectId);
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const liveThreads = new Set((yield* readClaims()).map((claim) => claim.threadId));
    const completedSources = runtimeRows.flatMap((runtime) => {
      if (!liveThreads.has(runtime.threadId)) return [];
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* importThread({
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          worktreePath: null,
          branch: null,
          thread: outcome.thread,
          source,
          resume: false,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  const listAgentSessions = Effect.fn("AgentSessionImporter.listAgentSessions")(function* (
    input: AgentSessionListInput,
  ) {
    const project = yield* readProject(input.projectId);
    const excluded = new Set((yield* readClaims()).map(claimKey));
    return yield* scanner.listSessions(project.workspaceRoot, excluded);
  });
  const lookupAgentSession = Effect.fn("AgentSessionImporter.lookupAgentSession")(function* (
    input: AgentSessionLookupInput,
  ) {
    const result = yield* scanner.lookupSession(input);
    const excluded = new Set((yield* readClaims()).map(claimKey));
    return {
      ...result,
      matches: result.matches.filter(({ session }) => !excluded.has(claimKey(session))),
    };
  });
  const attachAgentSession = Effect.fn("AgentSessionImporter.attachAgentSession")(
    function* (input: AgentSessionAttachInput) {
      const project = yield* readProject(input.projectId);
      const selected = yield* scanner.readSession(
        project.workspaceRoot,
        input.providerInstanceId,
        input.sessionId,
      );
      const threadId = yield* importThread({
        projectId: input.projectId,
        workspaceRoot: selected.session.cwd,
        worktreePath: selected.isProjectRoot ? null : selected.session.cwd,
        branch: selected.session.branch,
        thread: { ...selected.thread, title: selected.session.title },
        source: selected.source,
        resume: true,
      });
      return { threadId };
    },
    Effect.mapError((cause) => new AgentSessionResumeError({ message: cause.message })),
  );

  return AgentSessionImporter.of({
    importRecentAgentThreads: (input) =>
      importRecentAgentThreads(input).pipe(importLock.withPermits(1)),
    listAgentSessions,
    lookupAgentSession,
    attachAgentSession: (input) => attachAgentSession(input).pipe(importLock.withPermits(1)),
  });
});

export const layer = Layer.effect(AgentSessionImporter, make);
