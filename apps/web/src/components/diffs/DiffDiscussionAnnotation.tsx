import {
  type ReviewDiscussion,
  ReviewDiscussionMutationInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { X } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import {
  discussionReplyKey,
  EMPTY_DISCUSSION_REPLY,
  useDiffDiscussionReplyStore,
} from "./diffDiscussionReplyStore";

const isDiscussionMutation = Schema.is(ReviewDiscussionMutationInput);

export interface DiffDiscussionsController {
  thread: ScopedThreadRef;
  discussions: readonly ReviewDiscussion[];
  allowed: boolean;
  mutate: (input: ReviewDiscussionMutationInput) => Promise<boolean>;
}

export function DiffDiscussionAnnotation({
  discussion,
  controller,
  outdated = false,
  onShowAndGo,
}: {
  discussion: ReviewDiscussion;
  controller: DiffDiscussionsController;
  outdated?: boolean;
  onShowAndGo?: () => void;
}) {
  const replyKey = discussionReplyKey(controller.thread, discussion.id);
  const { text, pending, attemptedReply } = useDiffDiscussionReplyStore(
    (state) => state.replies[replyKey] ?? EMPTY_DISCUSSION_REPLY,
  );
  const updateReply = useDiffDiscussionReplyStore((state) => state.update);
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutate = async (input: ReviewDiscussionMutationInput) => {
    const current = useDiffDiscussionReplyStore.getState().replies[replyKey];
    if (current?.pending || !controller.allowed) return false;
    if (current?.attemptedReply && input.type !== "reply") return false;
    updateReply(replyKey, {
      pending: true,
      ...(input.type === "reply" ? { attemptedReply: input } : {}),
    });
    try {
      return await controller.mutate(input);
    } finally {
      updateReply(replyKey, { pending: false });
    }
  };
  return (
    <div
      data-diff-discussion={discussion.id}
      tabIndex={-1}
      className="border-s-2 border-primary/55 bg-primary/[0.045] font-sans text-foreground focus:outline-2 focus:outline-primary"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
        <span className="mr-auto">
          {discussion.resolved ? "Resolved" : "Discussion"}
          {outdated ? " · Outdated — saved selection" : ""}
        </span>
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={pending || attemptedReply !== null || !controller.allowed}
          onClick={() =>
            void mutate({
              type: "status",
              threadId: discussion.threadId,
              discussionId: discussion.id,
              resolved: !discussion.resolved,
            })
          }
        >
          {discussion.resolved ? "Reopen" : "Resolve"}
        </Button>
        {discussion.hidden ? (
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={pending || attemptedReply !== null || !controller.allowed}
            onClick={() => {
              if (pending || attemptedReply || !controller.allowed) return;
              onShowAndGo?.();
              void mutate({
                type: "status",
                threadId: discussion.threadId,
                discussionId: discussion.id,
                hidden: false,
              });
            }}
          >
            {onShowAndGo ? "Show and go" : "Show in diff"}
          </Button>
        ) : (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Hide discussion"
            disabled={pending || attemptedReply !== null || !controller.allowed}
            onClick={() =>
              void mutate({
                type: "status",
                threadId: discussion.threadId,
                discussionId: discussion.id,
                hidden: true,
              })
            }
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
      {!discussion.resolved &&
        discussion.messages.map((message) => (
          <div key={message.id} className="px-3 py-2">
            <span className="text-3xs text-muted-foreground">
              {message.author === "assistant" ? "Agent" : "You"}
              {message.delivery === "pending" ? " · Saved — awaiting delivery confirmation" : ""}
            </span>
            <p className="whitespace-pre-wrap text-sm leading-5">{message.text}</p>
            {message.delivery === "failed" || message.delivery === "pending" ? (
              <div
                role={message.delivery === "failed" ? "alert" : "status"}
                className="text-xs text-muted-foreground"
              >
                {message.delivery === "failed"
                  ? (message.deliveryError ?? "Could not deliver question")
                  : "Retry safely if delivery was interrupted."}{" "}
                <Button
                  variant="ghost-muted"
                  size="xs"
                  disabled={pending || attemptedReply !== null || !controller.allowed}
                  onClick={() =>
                    void mutate({
                      type: "retry",
                      threadId: discussion.threadId,
                      messageId: message.id,
                    })
                  }
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      {!discussion.resolved ? (
        <DiffCommentAnnotation
          kind="draft"
          rangeLabel={`${discussion.anchor.startLine}–${discussion.anchor.endLine}`}
          text={attemptedReply?.text ?? text}
          onTextChange={(text) => {
            updateReply(replyKey, { text });
            setValidationError(null);
          }}
          validationError={validationError}
          onCancel={() => {
            if (!attemptedReply && !pending) {
              updateReply(replyKey, { text: "" });
              setValidationError(null);
            }
          }}
          focusOnMount={false}
          placeholder="Reply to this discussion…"
          submitLabel={attemptedReply ? "Retry post" : "Reply"}
          pending={pending}
          awaitingConfirmation={attemptedReply !== null}
          disabled={!controller.allowed}
          onComment={async (reply) => {
            const current = useDiffDiscussionReplyStore.getState().replies[replyKey];
            if (current?.pending || !controller.allowed) return;
            const input = current?.attemptedReply ?? {
              type: "reply",
              threadId: discussion.threadId,
              discussionId: discussion.id,
              messageId: randomUUID(),
              text: reply,
            };
            if (!isDiscussionMutation(input)) {
              setValidationError("Use at most 16,384 characters for a reply.");
              return;
            }
            setValidationError(null);
            await mutate(input);
          }}
        />
      ) : null}
    </div>
  );
}
