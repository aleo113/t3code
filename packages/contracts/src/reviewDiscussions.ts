import * as Schema from "effect/Schema";
import { PositiveInt, ThreadId } from "./baseSchemas.ts";
import { ReviewDiffPreviewResult } from "./review.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const Text = Schema.NonEmptyString.check(Schema.isMaxLength(16_384));

export const ReviewDiscussionAnchor = Schema.Struct({
  sourceId: Identifier,
  sourceKind: Schema.Literals(["working-tree", "branch-range"]),
  diffHash: Identifier,
  baseRef: Schema.NullOr(Identifier),
  headRef: Schema.NullOr(Identifier),
  oldPath: Schema.NullOr(Identifier),
  newPath: Schema.NullOr(Identifier),
  side: Schema.Literals(["old", "new"]),
  startLine: PositiveInt,
  endLine: PositiveInt,
  excerpt: Schema.String.check(Schema.isMaxLength(32_768)),
}).check(
  Schema.makeFilter(
    (anchor) =>
      anchor.endLine >= anchor.startLine &&
      anchor.endLine - anchor.startLine < 500 &&
      (anchor.side === "old" ? anchor.oldPath !== null : anchor.newPath !== null),
    { expected: "an inclusive range of at most 500 lines on an existing side" },
  ),
);
export type ReviewDiscussionAnchor = typeof ReviewDiscussionAnchor.Type;

export const ReviewDiscussionMessage = Schema.Struct({
  id: Identifier,
  author: Schema.Literals(["user", "assistant"]),
  text: Text,
  createdAt: Schema.String,
  delivery: Schema.Literals(["pending", "sent", "failed", "none"]),
  deliveryError: Schema.NullOr(Schema.String),
});
export type ReviewDiscussionMessage = typeof ReviewDiscussionMessage.Type;

export const ReviewDiscussion = Schema.Struct({
  id: Identifier,
  threadId: ThreadId,
  anchor: ReviewDiscussionAnchor,
  resolved: Schema.Boolean,
  hidden: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messages: Schema.Array(ReviewDiscussionMessage),
});
export type ReviewDiscussion = typeof ReviewDiscussion.Type;

export const ReviewDiscussionListInput = Schema.Struct({
  threadId: ThreadId,
  includeHidden: Schema.optional(Schema.Boolean),
  includeDiff: Schema.optional(Schema.Boolean),
  baseRef: Schema.optional(Identifier),
});
export type ReviewDiscussionListInput = typeof ReviewDiscussionListInput.Type;
export const ReviewDiscussionListResult = Schema.Struct({
  discussions: Schema.Array(ReviewDiscussion),
  diff: Schema.optional(ReviewDiffPreviewResult),
});
export type ReviewDiscussionListResult = typeof ReviewDiscussionListResult.Type;

export const ReviewDiscussionCreateFields = {
  id: Identifier,
  messageId: Identifier,
  text: Text,
  anchor: ReviewDiscussionAnchor,
};
export const ReviewDiscussionReplyFields = {
  discussionId: Identifier,
  messageId: Identifier,
  text: Text,
};
export const ReviewDiscussionMutationInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    threadId: ThreadId,
    ...ReviewDiscussionCreateFields,
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    threadId: ThreadId,
    ...ReviewDiscussionReplyFields,
  }),
  Schema.Struct({ type: Schema.Literal("retry"), threadId: ThreadId, messageId: Identifier }),
  Schema.Struct({
    type: Schema.Literal("status"),
    threadId: ThreadId,
    discussionId: Identifier,
    resolved: Schema.optional(Schema.Boolean),
    hidden: Schema.optional(Schema.Boolean),
  }),
]);
export type ReviewDiscussionMutationInput = typeof ReviewDiscussionMutationInput.Type;
export const ReviewDiscussionMutationResult = Schema.Struct({ discussion: ReviewDiscussion });
export type ReviewDiscussionMutationResult = typeof ReviewDiscussionMutationResult.Type;

export class ReviewDiscussionError extends Schema.TaggedError<ReviewDiscussionError>()(
  "ReviewDiscussionError",
  {
    code: Schema.Literals([
      "invalid_input",
      "not_found",
      "conflict",
      "storage",
      "thread_unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "invalid_input":
        return "Invalid diff discussion input.";
      case "not_found":
        return "The diff discussion or message was not found in this thread.";
      case "conflict":
        return "This discussion or message ID already belongs to a different post.";
      case "storage":
        return "Could not read or save the diff discussion.";
      case "thread_unavailable":
        return "The discussion thread is unavailable.";
    }
  }
}
