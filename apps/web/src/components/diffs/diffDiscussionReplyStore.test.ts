import { EnvironmentId, ThreadId, type ReviewDiscussion } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { discussionReplyKey, useDiffDiscussionReplyStore } from "./diffDiscussionReplyStore";

const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const attemptedReply = {
  type: "reply" as const,
  threadId: thread.threadId,
  discussionId: "discussion",
  messageId: "reply",
  text: "An uncertain reply",
};
const saved: ReviewDiscussion = {
  id: "discussion",
  threadId: thread.threadId,
  hidden: false,
  resolved: false,
  createdAt: "now",
  updatedAt: "now",
  anchor: {
    sourceId: "working-tree",
    sourceKind: "working-tree",
    diffHash: "hash",
    baseRef: "HEAD",
    headRef: null,
    oldPath: "file.txt",
    newPath: "file.txt",
    side: "new",
    startLine: 1,
    endLine: 1,
    excerpt: "line",
  },
  messages: [
    {
      id: attemptedReply.messageId,
      author: "user",
      text: attemptedReply.text,
      createdAt: "now",
      delivery: "sent",
      deliveryError: null,
    },
  ],
};
const key = discussionReplyKey(thread, saved.id);

beforeEach(() => useDiffDiscussionReplyStore.setState({ replies: {} }));

it("isolates reply drafts and saved-ID reconciliation by environment, thread, and discussion", () => {
  const store = useDiffDiscussionReplyStore.getState();
  const otherEnvironment = { ...thread, environmentId: EnvironmentId.make("another-env") };
  const otherThread = { ...thread, threadId: ThreadId.make("another-thread") };
  const otherKeys = [
    discussionReplyKey(otherEnvironment, saved.id),
    discussionReplyKey(otherThread, saved.id),
    discussionReplyKey(thread, "another-discussion"),
  ];
  store.update(key, { attemptedReply });
  for (const otherKey of otherKeys) store.update(otherKey, { text: "Keep this draft" });
  store.reconcile(otherEnvironment, [saved]);
  expect(useDiffDiscussionReplyStore.getState().replies[key]?.attemptedReply).toEqual(
    attemptedReply,
  );
  store.reconcile(thread, [saved]);
  expect(useDiffDiscussionReplyStore.getState().replies[key]).toBeUndefined();
  for (const otherKey of otherKeys) {
    expect(useDiffDiscussionReplyStore.getState().replies[otherKey]?.text).toBe("Keep this draft");
  }
  // Delimiters in IDs must not alias a different environment/thread pair.
  expect(
    discussionReplyKey(
      { environmentId: EnvironmentId.make("env:a"), threadId: ThreadId.make("b") },
      "c",
    ),
  ).not.toBe(
    discussionReplyKey(
      { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("a:b") },
      "c",
    ),
  );
});

it("retains attempts through missing snapshots and keeps pending until the response settles", () => {
  const store = useDiffDiscussionReplyStore.getState();
  store.update(key, { text: attemptedReply.text, attemptedReply, pending: true });
  store.reconcile(thread, []);
  store.reconcile(thread, [{ ...saved, messages: [] }]);
  expect(useDiffDiscussionReplyStore.getState().replies[key]).toEqual({
    text: attemptedReply.text,
    attemptedReply,
    pending: true,
  });
  store.reconcile(thread, [saved]);
  expect(useDiffDiscussionReplyStore.getState().replies[key]).toEqual({
    text: "",
    attemptedReply: null,
    pending: true,
  });
  store.update(key, { pending: false });
  expect(useDiffDiscussionReplyStore.getState().replies).toEqual({});
});

it("keeps unsent text through polls and removes it when explicitly cancelled", () => {
  const store = useDiffDiscussionReplyStore.getState();
  store.update(key, { text: "A new draft" });
  store.reconcile(thread, [saved]);
  expect(useDiffDiscussionReplyStore.getState().replies[key]?.text).toBe("A new draft");
  store.update(key, { text: "" });
  expect(useDiffDiscussionReplyStore.getState().replies).toEqual({});
});
