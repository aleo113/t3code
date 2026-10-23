import { useAtomValue } from "@effect/atom-react";
import type {
  ReviewDiscussion,
  ReviewDiscussionMutationInput,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";
import { useDiffDiscussionReplyStore } from "./diffDiscussionReplyStore";

function selectDiscussions(
  result: AsyncResult.AsyncResult<{ readonly discussions: readonly ReviewDiscussion[] }, unknown>,
) {
  return JSON.stringify(Option.getOrNull(AsyncResult.value(result))?.discussions ?? []);
}

export function useDiffDiscussions(thread: ScopedThreadRef) {
  const result = useAtomValue(
    reviewEnvironment.discussions({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId, includeHidden: true },
    }),
    selectDiscussions,
  );
  const permission = useAtomValue(
    reviewEnvironment.mutateDiscussion.permissionAtom(thread.environmentId),
  );
  const runMutation = useAtomCommand(reviewEnvironment.mutateDiscussion);
  const discussions = JSON.parse(result) as readonly ReviewDiscussion[];
  useEffect(() => {
    useDiffDiscussionReplyStore.getState().reconcile(thread, discussions);
  }, [thread, discussions]);
  return {
    thread,
    discussions,
    allowed: permission,
    mutate: async (input: ReviewDiscussionMutationInput) => {
      const result = await runMutation({ environmentId: thread.environmentId, input });
      return result._tag === "Success";
    },
  };
}
