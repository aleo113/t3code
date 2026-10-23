import {
  OrchestratorMcpFailure,
  ReviewDiscussionCreateFields,
  ReviewDiscussionError,
  ReviewDiscussionListInput,
  ReviewDiscussionListResult,
  ReviewDiscussionMutationResult,
  ReviewDiscussionReplyFields,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ReviewDiscussionService from "../../../review/ReviewDiscussionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, ReviewDiscussionError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ReviewDiscussionService.ReviewDiscussionService,
    ThreadManagementService.ThreadManagementService,
  ],
};
const ReviewDiscussionReadInput = Schema.Struct({
  includeHidden: ReviewDiscussionListInput.fields.includeHidden,
  includeDiff: ReviewDiscussionListInput.fields.includeDiff,
  baseRef: ReviewDiscussionListInput.fields.baseRef,
});
const Read = Tool.make("diff_discussions_read", {
  ...shared,
  description:
    "Read inline diff discussions in your own thread. Includes historical/outdated anchors; includeHidden opts into hidden discussions. Set includeDiff:true to get current native patches and public sourceId/diffHash values for diff_annotate. baseRef optionally selects a branch comparison. Use these native values, never a private renderer hash.",
  parameters: ReviewDiscussionReadInput,
  success: Schema.toCodecJson(ReviewDiscussionListResult),
}).annotate(Tool.Readonly, true);
const Reply = Tool.make("diff_discussion_reply", {
  ...shared,
  description:
    "Reply as the assistant to an existing inline discussion in your own thread. Reuse messageId only for an identical retry. Persists without starting another turn.",
  parameters: Schema.Struct(ReviewDiscussionReplyFields),
  success: ReviewDiscussionMutationResult,
}).annotate(Tool.Destructive, true);
const Annotate = Tool.make("diff_annotate", {
  ...shared,
  description:
    "Create an assistant inline annotation in your own thread. First read includeDiff:true, select a path/side/inclusive line range from the returned patch, copy its exact source excerpt and native comparison identity into anchor. Reuse id/messageId only for an identical retry. Does not start a turn.",
  parameters: Schema.Struct(ReviewDiscussionCreateFields),
  success: ReviewDiscussionMutationResult,
}).annotate(Tool.Destructive, true);
export const ReviewDiscussionsToolkit = Toolkit.make(Read, Reply, Annotate);
