import type {
  ReviewDiscussion,
  ReviewDiscussionMutationInput,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

interface DiscussionReply {
  text: string;
  pending: boolean;
  attemptedReply: Extract<ReviewDiscussionMutationInput, { type: "reply" }> | null;
}

export const EMPTY_DISCUSSION_REPLY: DiscussionReply = {
  text: "",
  pending: false,
  attemptedReply: null,
};

export function discussionReplyKey(thread: ScopedThreadRef, discussionId: string): string {
  return JSON.stringify([thread.environmentId, thread.threadId, discussionId]);
}

interface DiffDiscussionReplyStore {
  replies: Record<string, DiscussionReply>;
  update: (key: string, update: Partial<DiscussionReply>) => void;
  reconcile: (thread: ScopedThreadRef, discussions: readonly ReviewDiscussion[]) => void;
}

// Pierre unmounts offscreen annotations, and history uses separate annotation instances.
// Keep drafts and uncertain envelopes for the session, independently of either view.
export const useDiffDiscussionReplyStore = create<DiffDiscussionReplyStore>()((set, get) => ({
  replies: {},
  update: (key, update) =>
    set((state) => {
      const reply = { ...(state.replies[key] ?? EMPTY_DISCUSSION_REPLY), ...update };
      if (!reply.text && !reply.pending && !reply.attemptedReply) {
        const { [key]: _removed, ...replies } = state.replies;
        return { replies };
      }
      return { replies: { ...state.replies, [key]: reply } };
    }),
  reconcile: (thread, discussions) => {
    for (const discussion of discussions) {
      const key = discussionReplyKey(thread, discussion.id);
      const attempt = get().replies[key]?.attemptedReply;
      if (attempt && discussion.messages.some((message) => message.id === attempt.messageId)) {
        // Confirmation may precede the RPC response. Keep its pending guard until it settles.
        get().update(key, { text: "", attemptedReply: null });
      }
    }
  },
}));
