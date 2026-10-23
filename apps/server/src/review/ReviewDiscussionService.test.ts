import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationMessageContext,
  EnvironmentId,
  ProviderInstanceId,
  ReviewDiscussionAnchor,
  ReviewDiscussionMutationInput,
  ThreadId,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Review from "./ReviewService.ts";
import * as Discussions from "./ReviewDiscussionService.ts";
import migration from "../persistence/ReviewDiscussionMigrations/001_ReviewDiscussions.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as McpContext from "../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Handlers from "../mcp/toolkits/reviewDiscussions/handlers.ts";
import { ReviewDiscussionsToolkit } from "../mcp/toolkits/reviewDiscussions/tools.ts";

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const threadId = ThreadId.make("own-thread");
const otherThread = ThreadId.make("other-thread");
const anchor: ReviewDiscussionAnchor = {
  sourceId: "working-tree",
  sourceKind: "working-tree",
  diffHash: "native-hash",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  side: "new",
  startLine: 2,
  endLine: 2,
  excerpt: "const value = 1;",
};
const create: ReviewDiscussionMutationInput = {
  type: "create",
  threadId,
  id: "discussion",
  messageId: "post",
  text: "Explain this line",
  anchor,
};
const lostProjection = () =>
  new Threads.ThreadManagementDurableRunProjectionError({ threadId, messageId: "native" as never });

function harness(
  filename = ":memory:",
  overrides: {
    threads?: Partial<Threads.ThreadManagementService["Service"]>;
    projects?: Partial<Projects.ProjectService["Service"]>;
    review?: Partial<Review.ReviewService["Service"]>;
  } = {},
) {
  const calls: Threads.ThreadManagementSendInput[] = [];
  const receipts = new Map<CommandId, Receipts.CommandReceiptV2>();
  let onSend: Threads.ThreadManagementService["Service"]["sendToThread"] = () =>
    Effect.fail(lostProjection());
  const dependencies = Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      sendToThread: (input) =>
        Effect.suspend(() => {
          calls.push(input);
          return onSend(input);
        }),
      ...overrides.threads,
    }),
    Layer.mock(Receipts.CommandReceiptStoreV2)({
      getByCommandId: (id) => Effect.sync(() => Option.fromUndefinedOr(receipts.get(id))),
    }),
    Layer.mock(Projects.ProjectService)(overrides.projects ?? {}),
    Layer.mock(Review.ReviewService)(overrides.review ?? {}),
  );
  const database = NodeSqliteClient.layer({ filename });
  const layer = Discussions.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(database),
  );
  const accept = (
    input: Threads.ThreadManagementSendInput,
    status: "accepted" | "rejected" = "accepted",
  ) => {
    receipts.set(input.commandId, {
      commandId: input.commandId,
      threadId: input.threadId,
      commandType: "message.dispatch",
      acceptedAt: DateTime.makeUnsafe(0),
      resultSequence: 1,
      status,
      error: null,
    });
  };
  return {
    calls,
    receipts,
    layer,
    accept,
    setSend: (send: typeof onSend) => {
      onSend = send;
    },
  };
}

it.effect(
  "persists before dispatch, reconciles accepted delivery after projection failure, and deduplicates retries",
  () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* Discussions.ReviewDiscussionService;
      const sql = yield* SqlClient.SqlClient;
      test.setSend((input) =>
        Effect.gen(function* () {
          const saved = yield* sql<{
            prompt: string;
            command_id: string;
            native_message_id: string;
          }>`SELECT prompt, command_id, native_message_id FROM review_discussion_messages`.pipe(
            Effect.orDie,
          );
          expect(saved[0]).toEqual({
            prompt: input.text,
            command_id: input.commandId,
            native_message_id: input.messageId,
          });
          const contextId = toKindScopedComposerContextId(
            "review-comment",
            `${threadId}:discussion:post`,
          );
          expect(input.text).toBe(
            `Explain this line\n\n[src/a.ts new L2](t3-context://v1/review-comment/${contextId})`,
          );
          expect(collectComposerContextReferences(input.text)).toHaveLength(1);
          expect(input.context).toEqual({
            version: 1,
            records: [
              {
                version: 1,
                kind: "review-comment",
                contextId,
                label: "src/a.ts new L2",
                discussionId: "discussion",
                sectionId: "working-tree",
                sectionTitle: "Uncommitted",
                filePath: "src/a.ts",
                startIndex: 2,
                endIndex: 2,
                rangeLabel: "new L2",
                text: "",
                diff: anchor.excerpt,
              },
            ],
          });
          expect(decodeMessageContext(input.context).records).toHaveLength(1);
          expect(input.mode).toBe("auto");
          expect(input.createdBy).toBe("user");
          test.accept(input);
          return yield* lostProjection();
        }),
      );
      const first = yield* service.mutate(create, "user");
      expect(first.discussion.messages[0]?.delivery).toBe("sent");
      yield* service.mutate(create, "user");
      yield* service.mutate({ type: "retry", threadId, messageId: "post" }, "user");
      expect(test.calls).toHaveLength(1);
      expect((yield* service.list({ threadId })).discussions[0]?.messages).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "retains uncertain and rejected posts; retries identical native IDs and immutable prompt",
  () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* Discussions.ReviewDiscussionService;
      const first = yield* service.mutate(create, "user");
      expect(first.discussion.messages[0]?.delivery).toBe("failed");
      yield* service.mutate(
        {
          type: "reply",
          threadId,
          discussionId: "discussion",
          messageId: "assistant",
          text: "An answer",
        },
        "assistant",
      );
      test.setSend((input) =>
        Effect.sync(() => test.accept(input, "rejected")).pipe(
          Effect.andThen(Effect.fail(lostProjection())),
        ),
      );
      const retried = yield* service.mutate({ type: "retry", threadId, messageId: "post" }, "user");
      expect(retried.discussion.messages[0]?.delivery).toBe("failed");
      expect(test.calls[1]).toEqual(test.calls[0]);
      expect(retried.discussion.messages).toHaveLength(2);
      const changed = yield* service
        .mutate({ ...create, text: "Changed content" }, "user")
        .pipe(Effect.flip);
      expect(changed.code).toBe("conflict");
      const moved = yield* service
        .mutate({ ...create, anchor: { ...anchor, diffHash: "new-comparison" } }, "user")
        .pipe(Effect.flip);
      expect(moved.code).toBe("conflict");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("serializes concurrent same-post sends and preserves distinct concurrent replies", () => {
  const test = harness();
  return Effect.gen(function* () {
    yield* migration;
    const service = yield* Discussions.ReviewDiscussionService;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    test.setSend((input) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        test.accept(input);
        return yield* lostProjection();
      }),
    );
    const first = yield* service.mutate(create, "user").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* service.list({ threadId })).discussions[0]?.messages[0]?.delivery).toBe(
      "pending",
    );
    const retry = yield* service.mutate(create, "user").pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(retry);
    expect(test.calls).toHaveLength(1);
    yield* Effect.all(
      ["reply-a", "reply-b"].map((messageId) =>
        service.mutate(
          { type: "reply", threadId, discussionId: "discussion", messageId, text: messageId },
          "assistant",
        ),
      ),
      { concurrency: "unbounded" },
    );
    const discussion = (yield* service.list({ threadId })).discussions[0];
    expect(discussion?.messages.map((message) => message.id)).toEqual([
      "post",
      "reply-a",
      "reply-b",
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "survives database close/reopen with anchors, hidden state, posts and retry identity",
  () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-diff-" });
      const filename = `${directory}/discussions.sqlite`;
      const original = harness(filename);
      const reopened = harness(filename);
      yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* Discussions.ReviewDiscussionService;
        yield* service.mutate(create, "user");
        yield* service.mutate(
          { type: "status", threadId, discussionId: "discussion", hidden: true, resolved: true },
          "user",
        );
      }).pipe(Effect.provide(original.layer));
      yield* Effect.gen(function* () {
        const service = yield* Discussions.ReviewDiscussionService;
        expect((yield* service.list({ threadId })).discussions).toHaveLength(0);
        const historical = (yield* service.list({ threadId, includeHidden: true })).discussions[0];
        expect(historical?.anchor).toEqual(anchor);
        expect(historical?.messages[0]?.text).toBe(create.text);
        expect(historical?.resolved).toBe(true);
        yield* service.mutate({ type: "retry", threadId, messageId: "post" }, "user");
        expect(reopened.calls[0]).toEqual(original.calls[0]);
        yield* service.mutate(
          { type: "status", threadId, discussionId: "discussion", hidden: false, resolved: false },
          "user",
        );
        expect((yield* service.list({ threadId })).discussions[0]?.resolved).toBe(false);
      }).pipe(Effect.provide(reopened.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  },
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope = (id: ThreadId): McpContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "test",
  thread: {
    threadId: id,
    providerSessionId: "test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const decodeToolResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const callTool = (
  name: string,
  invocation: McpContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeToolResult(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect(
  "MCP isolates reads and supplied IDs to the caller; assistant writes never dispatch",
  () => {
    const test = harness();
    const layer = McpHttpServer.toolkitRegistration(ReviewDiscussionsToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(test.layer),
    );
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* Discussions.ReviewDiscussionService;
      yield* service.mutate(create, "assistant");
      expect(yield* callTool("diff_discussions_read", scope(otherThread), { threadId })).toEqual({
        discussions: [],
      });
      expect(
        yield* callTool("diff_discussion_reply", scope(otherThread), {
          threadId,
          discussionId: "discussion",
          messageId: "intruder",
          text: "Wrong thread",
        }),
      ).toMatchObject({ code: "not_found" });
      expect(
        yield* callTool("diff_discussions_read", { ...scope(threadId), thread: undefined }, {}),
      ).toMatchObject({ code: "thread_credential_required" });
      expect(
        yield* callTool(
          "diff_discussions_read",
          { ...scope(threadId), capabilities: new Set() },
          {},
        ),
      ).toMatchObject({ code: "capability_denied" });
      const reply = yield* callTool("diff_discussion_reply", scope(threadId), {
        discussionId: "discussion",
        messageId: "answer",
        text: "My answer",
        author: "user",
      });
      expect(reply).toMatchObject({
        discussion: {
          messages: [{ author: "assistant" }, { author: "assistant", delivery: "none" }],
        },
      });
      expect(
        yield* callTool("diff_annotate", scope(threadId), {
          id: "proactive",
          messageId: "annotation",
          text: "Check this",
          anchor,
        }),
      ).toMatchObject({ discussion: { id: "proactive", anchor } });
      expect(test.calls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rejects invalid anchor bounds before saving or dispatching", () => {
  const test = harness();
  return Effect.gen(function* () {
    yield* migration;
    const service = yield* Discussions.ReviewDiscussionService;
    for (const invalid of [
      { startLine: 0 },
      { endLine: 1 },
      { endLine: 1000 },
      { side: "old" as const, oldPath: null },
    ]) {
      expect(
        (yield* service
          .mutate({ ...create, anchor: { ...anchor, ...invalid } }, "user")
          .pipe(Effect.flip)).code,
      ).toBe("invalid_input");
    }
    expect((yield* service.list({ threadId })).discussions).toHaveLength(0);
    expect(test.calls).toHaveLength(0);
  }).pipe(Effect.provide(test.layer));
});

it.effect.each([null, "/authorized/worktree"])(
  "MCP exposes native comparison identity from the authorized workspace %s",
  (worktreePath) => {
    const expectedCwd = worktreePath ?? "/authorized/project";
    const source = {
      id: anchor.sourceId,
      kind: anchor.sourceKind,
      title: "Working tree",
      baseRef: anchor.baseRef,
      headRef: anchor.headRef,
      diffHash: anchor.diffHash,
      diff: "@@ -1,2 +1,2 @@\n context\n-old\n+const value = 1;",
      truncated: false,
    };
    const test = harness(":memory:", {
      threads: { getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), worktreePath }) },
      projects: {
        getShell: (id) =>
          Effect.succeed(
            Option.some({
              id,
              title: "Project",
              workspaceRoot: "/authorized/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
            }),
          ),
      },
      review: {
        getDiffPreview: (input) => {
          expect(input).toEqual({ cwd: expectedCwd, baseRef: "main" });
          return Effect.succeed({
            cwd: input.cwd,
            generatedAt: DateTime.makeUnsafe(0),
            sources: [source],
          });
        },
      },
    });
    const layer = McpHttpServer.toolkitRegistration(ReviewDiscussionsToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(test.layer),
    );
    return Effect.gen(function* () {
      yield* migration;
      expect(
        yield* callTool("diff_discussions_read", scope(threadId), {
          includeDiff: true,
          baseRef: "main",
          cwd: "/unrelated/workspace",
        }),
      ).toMatchObject({ diff: { cwd: expectedCwd, sources: [source] } });
      expect(
        yield* callTool("diff_annotate", scope(threadId), {
          id: "proactive",
          messageId: "annotation",
          text: "Check this",
          anchor,
        }),
      ).toMatchObject({ discussion: { anchor } });
      expect(test.calls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "clamps native card excerpts without changing the saved anchor and preserves legacy prompts on retry",
  () => {
    const test = harness();
    const longAnchor = {
      ...anchor,
      sourceKind: "branch-range" as const,
      sourceId: "x".repeat(1024),
      excerpt: "x".repeat(32_768),
      side: "old" as const,
      endLine: 4,
    };
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* Discussions.ReviewDiscussionService;
      yield* service.mutate({ ...create, anchor: longAnchor }, "user");
      const context = decodeMessageContext(test.calls[0]?.context);
      expect(context.records[0]).toMatchObject({
        sectionId: "branch-range",
        sectionTitle: "Changes",
        rangeLabel: "old L2-L4",
        diff: longAnchor.excerpt.slice(0, 32_000),
      });
      expect((yield* service.list({ threadId })).discussions[0]?.anchor.excerpt).toBe(
        longAnchor.excerpt,
      );
      const sql = yield* SqlClient.SqlClient;
      const legacyPrompt = "Previously saved plain prompt";
      yield* sql`UPDATE review_discussion_messages SET prompt = ${legacyPrompt} WHERE thread_id = ${threadId} AND id = 'post'`;
      yield* service.mutate({ type: "retry", threadId, messageId: "post" }, "user");
      expect(test.calls[1]).toEqual({ ...test.calls[0], text: legacyPrompt });
    }).pipe(Effect.provide(test.layer));
  },
);
