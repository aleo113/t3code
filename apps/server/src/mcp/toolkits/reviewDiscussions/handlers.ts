import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ReviewDiscussionService from "../../../review/ReviewDiscussionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ReviewDiscussionsToolkit } from "./tools.ts";

const callerThread = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const scope = yield* McpInvocationContext.requireThreadScope(invocation, "Diff discussions");
  if (!scope.capabilities.has("orchestration"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Diff discussions require orchestration capability.",
    });
  return scope.thread.threadId;
});

export const layer = McpToolAccess.toLayer(ReviewDiscussionsToolkit, {
  diff_discussions_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ReviewDiscussionService.ReviewDiscussionService;
      return yield* service.list({ ...input, threadId: yield* callerThread });
    }),
  ),
  diff_discussion_reply: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ReviewDiscussionService.ReviewDiscussionService;
      return yield* service.mutate(
        { ...input, type: "reply", threadId: yield* callerThread },
        "assistant",
      );
    }),
  ),
  diff_annotate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ReviewDiscussionService.ReviewDiscussionService;
      return yield* service.mutate(
        { ...input, type: "create", threadId: yield* callerThread },
        "assistant",
      );
    }),
  ),
});
