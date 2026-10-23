import {
  CommandId,
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  type ReviewCommentContextRecord,
  MessageId,
  ReviewDiscussion,
  ReviewDiscussionAnchor,
  ReviewDiscussionError,
  ReviewDiscussionListInput,
  type ReviewDiscussionListResult,
  ReviewDiscussionMessage,
  ReviewDiscussionMutationInput,
  type ReviewDiscussionMutationResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ReviewService from "./ReviewService.ts";

export class ReviewDiscussionService extends Context.Service<
  ReviewDiscussionService,
  {
    readonly list: (
      input: ReviewDiscussionListInput,
    ) => Effect.Effect<ReviewDiscussionListResult, ReviewDiscussionError>;
    readonly mutate: (
      input: ReviewDiscussionMutationInput,
      author: "user" | "assistant",
    ) => Effect.Effect<ReviewDiscussionMutationResult, ReviewDiscussionError>;
  }
>()("t3/review/ReviewDiscussionService") {}

const DiscussionRow = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  anchor: Schema.fromJsonString(ReviewDiscussionAnchor),
  resolved: Schema.Number,
  hidden: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const ListedMessage = Schema.Struct({
  ...ReviewDiscussionMessage.fields,
  discussionId: Schema.String,
});
const MessageRow = Schema.Struct({
  ...ListedMessage.fields,
  prompt: Schema.String,
  commandId: CommandId,
  nativeMessageId: MessageId,
});
type MessageRow = typeof MessageRow.Type;

const decodeDiscussionRows = Schema.decodeUnknownEffect(Schema.Array(DiscussionRow));
const decodeListedMessages = Schema.decodeUnknownEffect(Schema.Array(ListedMessage));
const decodeMessage = Schema.decodeUnknownEffect(MessageRow);
const decodeListInput = Schema.decodeEffect(ReviewDiscussionListInput);
const decodeMutationInput = Schema.decodeEffect(ReviewDiscussionMutationInput);
const isDiscussionError = Schema.is(ReviewDiscussionError);

const storageError = (cause: unknown) => new ReviewDiscussionError({ code: "storage", cause });
const encodeAnchor = Schema.encodeSync(Schema.fromJsonString(ReviewDiscussionAnchor));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function discussionContextRecord(
  discussion: ReviewDiscussion,
  messageId: string,
): ReviewCommentContextRecord {
  const { anchor } = discussion;
  const filePath = (anchor.side === "old" ? anchor.oldPath : anchor.newPath)!;
  const rangeLabel = `${anchor.side} L${anchor.startLine}${anchor.endLine === anchor.startLine ? "" : `-L${anchor.endLine}`}`;
  return {
    version: 1,
    kind: "review-comment",
    contextId: toKindScopedComposerContextId(
      "review-comment",
      `${discussion.threadId}:${discussion.id}:${messageId}`,
    ),
    label: sanitizeComposerContextLabel(`${filePath} ${rangeLabel}`, "review-comment"),
    discussionId: discussion.id,
    sectionId: anchor.sourceKind,
    sectionTitle: anchor.sourceKind === "working-tree" ? "Uncommitted" : "Changes",
    filePath,
    startIndex: anchor.startLine,
    endIndex: anchor.endLine,
    rangeLabel,
    text: "",
    diff: anchor.excerpt.slice(0, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS),
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const review = yield* ReviewService.ReviewService;
  // A single service owns mutations. The lock also prevents concurrent retries from
  // dispatching one pending post twice; no SQL transaction spans native dispatch.
  const mutationLock = yield* Semaphore.make(1);

  const requireThread = Effect.fn("ReviewDiscussionService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new ReviewDiscussionError({ code: "thread_unavailable", cause }),
        ),
      );
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ReviewDiscussionError({ code: "thread_unavailable" });
    }
    return thread;
  });

  const readDiscussions = Effect.fn("ReviewDiscussionService.readDiscussions")(function* (
    threadId: ThreadId,
    includeHidden: boolean,
    discussionId: string | null = null,
  ) {
    const rows = yield* sql`
      SELECT id, thread_id AS "threadId", anchor_json AS anchor, resolved, hidden,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM review_discussions
      WHERE thread_id = ${threadId} AND (${includeHidden ? 1 : 0} = 1 OR hidden = 0)
        AND (${discussionId} IS NULL OR id = ${discussionId})
      ORDER BY created_at, rowid
    `.pipe(Effect.flatMap(decodeDiscussionRows), Effect.mapError(storageError));
    const messages = yield* sql`
      SELECT m.id, m.discussion_id AS "discussionId", m.author, m.text, m.created_at AS "createdAt",
        m.delivery, m.delivery_error AS "deliveryError"
      FROM review_discussion_messages m
      JOIN review_discussions d ON d.thread_id = m.thread_id AND d.id = m.discussion_id
      WHERE m.thread_id = ${threadId} AND (${includeHidden ? 1 : 0} = 1 OR d.hidden = 0)
        AND (${discussionId} IS NULL OR d.id = ${discussionId})
      ORDER BY m.rowid
    `.pipe(Effect.flatMap(decodeListedMessages), Effect.mapError(storageError));
    return rows.map((row): ReviewDiscussion => ({
      ...row,
      threadId,
      resolved: row.resolved !== 0,
      hidden: row.hidden !== 0,
      messages: messages
        .filter((message) => message.discussionId === row.id)
        .map(({ id, author, text, createdAt, delivery, deliveryError }) => ({
          id,
          author,
          text,
          createdAt,
          delivery,
          deliveryError,
        })),
    }));
  });

  const readDiscussion = Effect.fn("ReviewDiscussionService.readDiscussion")(function* (
    threadId: ThreadId,
    discussionId: string,
  ) {
    const discussion = (yield* readDiscussions(threadId, true, discussionId))[0];
    if (!discussion) return yield* new ReviewDiscussionError({ code: "not_found" });
    return discussion;
  });

  const readMessage = Effect.fn("ReviewDiscussionService.readMessage")(function* (
    threadId: ThreadId,
    messageId: string,
  ) {
    const rows = yield* sql`
      SELECT id, discussion_id AS "discussionId", author, text, created_at AS "createdAt", delivery,
        delivery_error AS "deliveryError", prompt, command_id AS "commandId", native_message_id AS "nativeMessageId"
      FROM review_discussion_messages WHERE thread_id = ${threadId} AND id = ${messageId}
    `.pipe(Effect.mapError(storageError));
    if (!rows[0]) return undefined;
    return yield* decodeMessage(rows[0]).pipe(Effect.mapError(storageError));
  });

  const list = Effect.fn("ReviewDiscussionService.list")(function* (
    raw: ReviewDiscussionListInput,
  ) {
    const input = yield* decodeListInput(raw).pipe(
      Effect.mapError((cause) => new ReviewDiscussionError({ code: "invalid_input", cause })),
    );
    const thread = yield* requireThread(input.threadId);
    const discussions = yield* readDiscussions(input.threadId, input.includeHidden === true);
    if (!input.includeDiff) return { discussions };
    const project = yield* projects
      .getShell(thread.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ReviewDiscussionError({ code: "thread_unavailable", cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new ReviewDiscussionError({ code: "thread_unavailable" });
    const diff = yield* review
      .getDiffPreview({
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      })
      .pipe(
        Effect.mapError(
          (cause) => new ReviewDiscussionError({ code: "thread_unavailable", cause }),
        ),
      );
    return { discussions, diff };
  });

  const acceptedReceipt = Effect.fn("ReviewDiscussionService.acceptedReceipt")(function* (
    threadId: ThreadId,
    commandId: CommandId,
  ) {
    const receipt = yield* receipts
      .getByCommandId(commandId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return (
      Option.isSome(receipt) &&
      receipt.value.status === "accepted" &&
      receipt.value.threadId === threadId &&
      receipt.value.commandType === "message.dispatch"
    );
  });

  const deliver = Effect.fn("ReviewDiscussionService.deliver")(function* (
    threadId: ThreadId,
    message: MessageRow,
  ) {
    if (message.delivery === "none" || message.delivery === "sent") return;
    const thread = yield* requireThread(threadId);
    const discussion = yield* readDiscussion(threadId, message.discussionId);
    yield* sql`UPDATE review_discussion_messages SET delivery = 'pending', delivery_error = NULL
      WHERE thread_id = ${threadId} AND id = ${message.id}`.pipe(Effect.mapError(storageError));
    const accepted =
      (yield* acceptedReceipt(threadId, message.commandId)) ||
      (yield* threads
        .sendToThread({
          projectId: thread.projectId,
          threadId,
          commandId: message.commandId,
          messageId: message.nativeMessageId,
          text: message.prompt,
          context: { version: 1, records: [discussionContextRecord(discussion, message.id)] },
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.as(true),
          // A failure loading the projection after commit must not make a new turn.
          Effect.catch(() => acceptedReceipt(threadId, message.commandId)),
        ));
    const delivery = accepted ? "sent" : "failed";
    const error = accepted
      ? null
      : "Native delivery could not be confirmed. Retry reuses this post's original IDs.";
    yield* sql`UPDATE review_discussion_messages SET delivery = ${delivery}, delivery_error = ${error}
      WHERE thread_id = ${threadId} AND id = ${message.id}`.pipe(Effect.mapError(storageError));
  });

  const persistPost = Effect.fn("ReviewDiscussionService.persistPost")(function* (
    input: Extract<ReviewDiscussionMutationInput, { type: "create" | "reply" }>,
    author: "user" | "assistant",
  ) {
    const discussionId = input.type === "create" ? input.id : input.discussionId;
    const existing = yield* readMessage(input.threadId, input.messageId);
    if (existing) {
      if (input.type === "create") {
        const originals = yield* sql<{ original_message_id: string; anchor_json: string }>`
          SELECT original_message_id, anchor_json FROM review_discussions
          WHERE thread_id = ${input.threadId} AND id = ${discussionId}
        `.pipe(Effect.mapError(storageError));
        if (
          originals[0]?.original_message_id !== input.messageId ||
          originals[0]?.anchor_json !== encodeAnchor(input.anchor)
        ) {
          return yield* new ReviewDiscussionError({ code: "conflict" });
        }
      }
      if (
        existing.discussionId !== discussionId ||
        existing.author !== author ||
        existing.text !== input.text
      ) {
        return yield* new ReviewDiscussionError({ code: "conflict" });
      }
      return existing;
    }
    const timestamp = yield* nowIso;
    if (input.type === "create") {
      const existingDiscussions =
        yield* sql`SELECT 1 FROM review_discussions WHERE thread_id = ${input.threadId} AND id = ${input.id}`.pipe(
          Effect.mapError(storageError),
        );
      if (existingDiscussions.length > 0)
        return yield* new ReviewDiscussionError({ code: "conflict" });
      yield* sql`INSERT INTO review_discussions (thread_id, id, anchor_json, original_message_id, created_at, updated_at)
        VALUES (${input.threadId}, ${input.id}, ${encodeAnchor(input.anchor)}, ${input.messageId}, ${timestamp}, ${timestamp})`.pipe(
        Effect.mapError(storageError),
      );
    }
    const discussion = yield* readDiscussion(input.threadId, discussionId);
    const post: ReviewDiscussionMessage = {
      id: input.messageId,
      author,
      text: input.text,
      createdAt: timestamp,
      delivery: author === "user" ? "pending" : "none",
      deliveryError: null,
    };
    const prompt =
      author === "user"
        ? `${post.text}\n\n${formatComposerContextReference(discussionContextRecord(discussion, post.id))}`
        : "";
    const identity = `${encodeURIComponent(input.threadId)}:${encodeURIComponent(input.messageId)}`;
    const commandId = CommandId.make(`diff-discussion:command:${identity}`);
    const nativeMessageId = MessageId.make(`diff-discussion:message:${identity}`);
    yield* sql`INSERT INTO review_discussion_messages
      (thread_id, id, discussion_id, author, text, created_at, delivery, delivery_error, prompt, command_id, native_message_id)
      VALUES (${input.threadId}, ${post.id}, ${discussionId}, ${author}, ${post.text}, ${timestamp}, ${post.delivery}, NULL, ${prompt}, ${commandId}, ${nativeMessageId})`.pipe(
      Effect.mapError(storageError),
    );
    yield* sql`UPDATE review_discussions SET updated_at = ${timestamp} WHERE thread_id = ${input.threadId} AND id = ${discussionId}`.pipe(
      Effect.mapError(storageError),
    );
    return { ...post, discussionId, prompt, commandId, nativeMessageId };
  });

  const mutate = Effect.fn("ReviewDiscussionService.mutate")(function* (
    raw: ReviewDiscussionMutationInput,
    author: "user" | "assistant",
  ) {
    const input = yield* decodeMutationInput(raw).pipe(
      Effect.mapError((cause) => new ReviewDiscussionError({ code: "invalid_input", cause })),
    );
    yield* requireThread(input.threadId);
    if (input.type === "status") {
      yield* readDiscussion(input.threadId, input.discussionId);
      const timestamp = yield* nowIso;
      yield* sql`UPDATE review_discussions SET
        resolved = COALESCE(${input.resolved === undefined ? null : Number(input.resolved)}, resolved),
        hidden = COALESCE(${input.hidden === undefined ? null : Number(input.hidden)}, hidden), updated_at = ${timestamp}
        WHERE thread_id = ${input.threadId} AND id = ${input.discussionId}`.pipe(
        Effect.mapError(storageError),
      );
      return { discussion: yield* readDiscussion(input.threadId, input.discussionId) };
    }
    let message: MessageRow;
    if (input.type === "retry") {
      const existing = yield* readMessage(input.threadId, input.messageId);
      if (!existing) return yield* new ReviewDiscussionError({ code: "not_found" });
      if (existing.author !== author) return yield* new ReviewDiscussionError({ code: "conflict" });
      message = existing;
    } else {
      message = yield* sql
        .withTransaction(persistPost(input, author))
        .pipe(Effect.mapError((cause) => (isDiscussionError(cause) ? cause : storageError(cause))));
    }
    yield* deliver(input.threadId, message);
    return { discussion: yield* readDiscussion(input.threadId, message.discussionId) };
  }, mutationLock.withPermits(1));

  return ReviewDiscussionService.of({ list, mutate });
});
export const layer = Layer.effect(ReviewDiscussionService, make);
