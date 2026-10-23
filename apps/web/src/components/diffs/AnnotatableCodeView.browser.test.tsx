import type { CodeViewDiffItem, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import {
  EnvironmentId,
  ThreadId,
  type ReviewDiscussion,
  type ReviewDiscussionMutationInput,
} from "@t3tools/contracts";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { act, StrictMode, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileDiffIdentityKey } from "~/lib/diffRendering";

type ViewerProps = Omit<ComponentProps<typeof StyledDiffCodeView<unknown>>, "options"> & {
  options: {
    enableLineSelection: boolean;
    enableGutterUtility: boolean;
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { item: CodeViewDiffItem<unknown> },
    ) => void;
  };
};

// Replace only the virtualized viewer; comment editing and submission use the real components.
vi.mock("./StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: ViewerProps) =>
    props.items
      ?.filter((item) => item.type === "diff")
      .map((item) => (
        <section key={item.id}>
          <button
            disabled={!props.options?.enableLineSelection || !props.options?.enableGutterUtility}
            onClick={() => {
              props.onSelectedLinesChange?.({ id: item.id, range });
              props.options?.onGutterUtilityClick?.(range, { item });
            }}
          >
            Comment on {item.fileDiff.name}
          </button>
          {props.selectedLines?.id === item.id ? (
            <mark>Line {props.selectedLines.range.start}</mark>
          ) : null}
          {item.annotations?.map((annotation) => (
            <div key={`${annotation.side}:${annotation.lineNumber}`}>
              {props.renderAnnotation?.(annotation, item)}
            </div>
          ))}
        </section>
      )),
}));

import { AnnotatableCodeView } from "./AnnotatableCodeView";
import type { StyledDiffCodeView } from "./StyledDiffCodeView";
import { useDiffDiscussionReplyStore } from "./diffDiscussionReplyStore";

const native = vi.hoisted(() => ({
  discussions: [] as ReviewDiscussion[],
  allowed: true,
  mutate: vi.fn<(input: ReviewDiscussionMutationInput) => Promise<boolean>>(),
}));
vi.mock("./useDiffDiscussions", () => ({
  useDiffDiscussions: () => {
    useEffect(() => {
      useDiffDiscussionReplyStore.getState().reconcile(thread, native.discussions);
    });
    return { ...native, thread };
  },
}));

const thread = {
  environmentId: EnvironmentId.make("test-env"),
  threadId: ThreadId.make("test-thread"),
};
let nativeMode = false;
let nativeEnabled = true;
let nativeNavigation = false;
const navigate = vi.fn();
let sourceHash = "public-hash";
const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };
let root: Root;
let container: HTMLDivElement;

function file(
  name: string,
  fileVersion = 1,
  type: FileDiffMetadata["type"] = "change",
  prevName?: string,
) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`,
    name,
  )[0]!.files[0]!;
  fileDiff.type = type;
  if (prevName) fileDiff.prevName = prevName;
  return {
    fileDiff,
    filePath: name,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion,
    collapsed: false,
  };
}

function render(
  files: ReturnType<typeof file>[],
  codeViewKey = "initial",
  pendingFiles: FileDiffMetadata[] = [],
) {
  act(() =>
    root.render(
      <StrictMode>
        <AnnotatableCodeView
          codeViewKey={codeViewKey}
          files={files}
          pendingFiles={pendingFiles}
          sectionId="unstaged"
          sectionTitle="Uncommitted"
          composerDraftTarget={nativeMode ? thread : target}
          {...(nativeEnabled
            ? {
                comparison: {
                  sourceId: "working-tree",
                  sourceKind: "working-tree" as const,
                  baseRef: "HEAD",
                  headRef: null,
                  diffHash: sourceHash,
                },
              }
            : {})}
          {...(nativeNavigation ? { onGoToDiscussion: navigate } : {})}
          options={{}}
          renderHeaderFilenameSuffix={() => null}
          renderHeaderPrefix={() => null}
          onRevealSearchMatch={() => {}}
        />
      </StrictMode>,
    ),
  );
}

function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
}

function editor() {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Comment editor is not available");
  return textarea;
}

function typeComment(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor(),
      text,
    );
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  useDiffDiscussionReplyStore.setState({ replies: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  nativeMode = false;
  nativeEnabled = true;
  nativeNavigation = false;
  navigate.mockReset();
  sourceHash = "public-hash";
  native.discussions = [];
  native.allowed = true;
  native.mutate.mockReset();
  native.mutate.mockImplementation(async (input) => {
    if (input.type === "create")
      native.discussions = [
        {
          id: input.id,
          threadId: input.threadId,
          anchor: input.anchor,
          resolved: false,
          hidden: false,
          createdAt: "now",
          updatedAt: "now",
          messages: [
            {
              id: input.messageId,
              author: "user",
              text: input.text,
              createdAt: "now",
              delivery: "sent",
              deliveryError: null,
            },
          ],
        },
      ];
    if (input.type === "reply")
      native.discussions = native.discussions.map((discussion) => ({
        ...discussion,
        messages: [
          ...discussion.messages,
          {
            id: input.messageId,
            author: "user",
            text: input.text,
            createdAt: "now",
            delivery: "sent",
            deliveryError: null,
          },
        ],
      }));
    if (input.type === "status")
      native.discussions = native.discussions.map((discussion) => ({
        ...discussion,
        ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
        ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
      }));
    return true;
  });
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("diff comment drafts", () => {
  it.each(["removed file", "replaced rename"] as const)(
    "allows a fresh comment after a %s loses its draft",
    (scenario) => {
      const original =
        scenario === "removed file"
          ? file("a.ts")
          : file("shared.ts", 1, "rename-changed", "old.ts");
      render([original, file("b.ts")]);
      click(`Comment on ${original.filePath}`);
      typeComment("Discard this draft");
      const pending =
        scenario === "removed file"
          ? []
          : [
              {
                ...file("shared.ts", 2, "rename-changed", "other.ts").fileDiff,
                hunks: [],
                cacheKey: "replacement:pending",
              },
            ];

      render([file("b.ts")], "refreshed", pending);
      expect(container.querySelector("textarea")).toBeNull();
      click("Comment on b.ts");
      expect(editor().value).toBe("");
      typeComment("  Review b.ts  ");
      click("Comment");

      expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
        expect.objectContaining({
          filePath: "b.ts",
          text: "Review b.ts",
          selection: { ...range, endSide: "additions" },
        }),
      ]);
      render([original, file("b.ts")], "returned");
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector("mark")).toBeNull();
      expect(container.querySelector("p")?.textContent).toBe("Review b.ts");
    },
  );

  it("keeps the text and selected line through refresh and a provisional lazy patch", () => {
    const original = file("shared.ts", 1, "rename-pure", "old.ts");
    render([original]);
    click("Comment on shared.ts");
    typeComment("Keep this draft");
    const refreshed = file("shared.ts", 2, "rename-pure", "old.ts");
    render([refreshed], "refreshed");
    expect(editor().value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");

    render([], "loading", [
      { ...refreshed.fileDiff, type: "rename-changed", hunks: [], cacheKey: "shared:pending" },
    ]);
    expect(container.querySelector("textarea")).toBeNull();
    render([refreshed], "loaded");
    expect(editor().value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");
    click("Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        filePath: "shared.ts",
        text: "Keep this draft",
        selection: { ...range, endSide: "additions" },
      }),
    ]);
    expect(container.querySelector("p")?.textContent).toBe("Keep this draft");
  });
});

describe("native diff discussions", () => {
  it.each(["create", "reply"] as const)(
    "freezes an uncertain %s and retries the identical envelope until poll reconciliation",
    async (kind) => {
      nativeMode = true;
      render([file("a.ts")]);
      click("Comment on a.ts");
      if (kind === "reply") {
        typeComment("Existing question");
        await act(async () => click("Ask agent"));
        render([file("a.ts")]);
      }
      const persist = native.mutate.getMockImplementation()!;
      let saved: ReviewDiscussion[] = [];
      native.mutate.mockImplementationOnce(async (input) => {
        const before = native.discussions;
        const response = persist(input);
        saved = native.discussions;
        native.discussions = before;
        await response;
        return false;
      });
      typeComment("The immutable attempted post");
      await act(async () => click(kind === "create" ? "Ask agent" : "Reply"));
      const attempted = native.mutate.mock.calls.at(-1)![0];
      expect(editor().readOnly).toBe(true);
      const cancel = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Cancel",
      )!;
      expect(cancel.disabled).toBe(true);
      click("Cancel");
      typeComment("Must not overwrite the attempted payload");
      expect(editor().value).toBe("The immutable attempted post");
      sourceHash = "refreshed-comparison";
      render(kind === "create" ? [] : [file("a.ts", 2)]);
      expect(editor().value).toBe("The immutable attempted post");
      native.mutate.mockResolvedValueOnce(false);
      await act(async () => click("Retry post"));
      expect(native.mutate.mock.calls.at(-1)![0]).toEqual(attempted);
      native.discussions = saved;
      render([file("a.ts", 2)]);
      expect(editor().readOnly).toBe(false);
      expect(editor().value).toBe("");
      typeComment("Safe unsent cancellation");
      click("Cancel");
      expect(editor().value).toBe("");
      expect(
        native.discussions
          .at(-1)!
          .messages.filter((message) => message.text === "The immutable attempted post"),
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "reconciles a persisted reply after a lost response before the next reply (cancel=%s)",
    async (cancel) => {
      nativeMode = true;
      render([file("a.ts")]);
      click("Comment on a.ts");
      typeComment("Original question");
      await act(async () => click("Ask agent"));
      render([file("a.ts")]);
      const persist = native.mutate.getMockImplementation()!;
      let saved: ReviewDiscussion[] = [];
      native.mutate.mockImplementationOnce(async (input) => {
        const before = native.discussions;
        await persist(input);
        saved = native.discussions;
        native.discussions = before;
        return false;
      });
      typeComment("Persisted reply, lost response");
      await act(async () => click("Reply"));
      const attempted = native.mutate.mock.calls.at(-1)![0];
      native.discussions = saved;
      render([file("a.ts")]);
      if (cancel) {
        typeComment("Unsent text to discard");
        click("Cancel");
        expect(editor().value).toBe("");
      }
      typeComment("A distinct follow-up");
      await act(async () => click("Reply"));
      const followUp = native.mutate.mock.calls.at(-1)![0];
      expect(attempted.type).toBe("reply");
      expect(followUp).toMatchObject({ type: "reply", text: "A distinct follow-up" });
      if (attempted.type !== "reply" || followUp.type !== "reply")
        throw new Error("Expected replies");
      expect(followUp.messageId).not.toBe(attempted.messageId);
      expect(native.discussions[0]!.messages.map((message) => message.text)).toEqual([
        "Original question",
        "Persisted reply, lost response",
        "A distinct follow-up",
      ]);
    },
  );

  it("reconciles a persisted create after a lost response and allows a distinct next question", async () => {
    nativeMode = true;
    const persist = native.mutate.getMockImplementation()!;
    let saved: ReviewDiscussion[] = [];
    native.mutate.mockImplementationOnce(async (input) => {
      const response = persist(input);
      saved = native.discussions;
      native.discussions = [];
      await response;
      return false;
    });
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Persisted question, lost response");
    await act(async () => click("Ask agent"));
    const attempted = native.mutate.mock.calls.at(-1)![0];
    native.discussions = saved;
    render([file("a.ts")]);
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(editor().value).toBe("");
    click("Comment on a.ts");
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .findLast((button) => button.textContent === "Cancel")!
        .click(),
    );
    click("Comment on a.ts");
    // The existing discussion has its own reply editor before the new question editor.
    const question = container.querySelectorAll("textarea")[1]!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        question,
        "A distinct question",
      );
      question.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => click("Ask agent"));
    const next = native.mutate.mock.calls.at(-1)![0];
    expect(next).toMatchObject({ type: "create", text: "A distinct question" });
    if (attempted.type !== "create" || next.type !== "create") throw new Error("Expected creates");
    expect(next.messageId).not.toBe(attempted.messageId);
    expect(next.id).not.toBe(attempted.id);
  });

  it("recovers a saved pending message only on explicit retry with the original ID", async () => {
    nativeMode = true;
    native.discussions = [
      {
        id: "recovered",
        threadId: thread.threadId,
        resolved: false,
        hidden: false,
        createdAt: "before restart",
        updatedAt: "before restart",
        anchor: {
          sourceId: "working-tree",
          sourceKind: "working-tree",
          diffHash: "public-hash",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "a.ts",
          newPath: "a.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          excerpt: "new",
        },
        messages: [
          {
            id: "saved-message",
            author: "user",
            text: "Question saved before restart",
            createdAt: "before restart",
            delivery: "pending",
            deliveryError: null,
          },
        ],
      },
    ];
    render([file("a.ts")]);
    expect(container.textContent).toContain("awaiting delivery confirmation");
    expect(native.mutate).not.toHaveBeenCalled();
    render([file("a.ts")]);
    expect(native.mutate).not.toHaveBeenCalled();
    await act(async () => click("Retry"));
    expect(native.mutate).toHaveBeenCalledExactlyOnceWith({
      type: "retry",
      threadId: thread.threadId,
      messageId: "saved-message",
    });
  });
  it("keeps per-turn comments staged without native discussion actions", () => {
    nativeMode = true;
    nativeEnabled = false;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Turn context");
    click("Comment");
    expect(native.mutate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(thread)?.reviewComments).toEqual([
      expect.objectContaining({ text: "Turn context" }),
    ]);
  });

  it("shows a changed selection as saved history instead of attaching to another snippet", async () => {
    nativeMode = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Original question");
    await act(async () => click("Ask agent"));
    sourceHash = "changed";
    const changed = file("a.ts", 2);
    changed.fileDiff.additionLines = ["another line\n"];
    render([changed]);
    expect(container.querySelector("section [data-diff-discussion]")).toBeNull();
    expect(container.querySelector("details pre")?.textContent).toContain("+new");
    expect(container.querySelector("details")?.textContent).toContain("Original question");
  });

  it("disables native writes without disabling Add to chat", () => {
    nativeMode = true;
    native.allowed = false;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Question");
    const ask = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "Ask agent",
    )!;
    expect(ask.disabled).toBe(true);
    click("Add to chat");
    expect(native.mutate).not.toHaveBeenCalled();
  });
  it("posts immediately, replies, resolves, reopens and hides without touching composer text", async () => {
    nativeMode = true;
    useComposerDraftStore.getState().setPrompt(thread, "Unrelated composer draft");
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Why this change?");
    await act(async () => click("Ask agent"));
    expect(native.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create",
        text: "Why this change?",
        anchor: expect.objectContaining({
          diffHash: "public-hash",
          excerpt: "@@ -0,0 +1,1 @@\n+new",
        }),
      }),
    );
    render([file("a.ts")]);
    expect(container.textContent).toContain("Why this change?");
    typeComment("Follow up");
    await act(async () => click("Reply"));
    render([file("a.ts")]);
    expect(container.textContent).toContain("Follow up");
    await act(async () => click("Resolve"));
    render([file("a.ts")]);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Follow up");
    await act(async () => click("Reopen"));
    render([file("a.ts")]);
    expect(editor()).toBeTruthy();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Hide discussion"]')!.click(),
    );
    render([file("a.ts")]);
    expect(container.querySelector("details")?.textContent).toContain("Discussions (1)");
    await act(async () => click("Show in diff"));
    render([file("a.ts")]);
    expect(container.querySelector("details")?.textContent).toContain("Current");
    expect(container.querySelector("details textarea")).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(thread)?.prompt).toBe(
      "Unrelated composer draft",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(thread)?.reviewComments ?? []).toEqual(
      [],
    );
  });

  it("keeps oversized native questions editable and available for legacy staging", async () => {
    nativeMode = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    const oversized = "x".repeat(16_385);
    typeComment(oversized);
    await act(async () => click("Ask agent"));
    expect(native.mutate).not.toHaveBeenCalled();
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("16,384");
    typeComment(`${oversized} still editable`);
    click("Add to chat");
    expect(useComposerDraftStore.getState().getComposerDraft(thread)?.reviewComments[0]?.text).toBe(
      `${oversized} still editable`,
    );
    expect(native.mutate).not.toHaveBeenCalled();
  });

  it("rejects an oversized reply locally without freezing its text or identity", async () => {
    nativeMode = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Question");
    await act(async () => click("Ask agent"));
    render([file("a.ts")]);
    native.mutate.mockClear();
    typeComment("x".repeat(16_385));
    await act(async () => click("Reply"));
    expect(native.mutate).not.toHaveBeenCalled();
    expect(editor().readOnly).toBe(false);
    typeComment("Valid follow-up");
    await act(async () => click("Reply"));
    expect(native.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "reply", text: "Valid follow-up" }),
    );
  });

  it("guards Show and go while a hidden saved reply awaits reconciliation", async () => {
    nativeMode = true;
    nativeNavigation = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Original question");
    await act(async () => click("Ask agent"));
    render([file("a.ts")]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Hide discussion"]')!.click(),
    );
    render([file("a.ts")]);
    native.mutate.mockResolvedValue(false);
    typeComment("Unconfirmed hidden reply");
    await act(async () => click("Reply"));
    render([file("a.ts")]);
    const attempted = native.mutate.mock.calls.at(-1)![0];
    const show = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Show and go",
    )!;
    expect(show.disabled).toBe(true);
    await act(async () => show.click());
    expect(navigate).not.toHaveBeenCalled();
    expect(editor().value).toBe("Unconfirmed hidden reply");
    expect(native.mutate.mock.calls.at(-1)![0]).toBe(attempted);
    if (attempted.type !== "reply") throw new Error("Expected reply");
    native.discussions = native.discussions.map((entry) => ({
      ...entry,
      messages: [
        ...entry.messages,
        {
          id: attempted.messageId,
          author: "user",
          text: attempted.text,
          createdAt: "now",
          delivery: "sent",
          deliveryError: null,
        },
      ],
    }));
    render([file("a.ts")]);
    expect(show.disabled).toBe(false);
    expect(editor().value).toBe("");
    await act(async () => show.click());
    expect(native.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "status", hidden: false }),
    );
    expect(navigate).not.toHaveBeenCalled();
    native.discussions = native.discussions.map((entry) => ({ ...entry, hidden: false }));
    render([file("a.ts")]);
    expect(navigate).toHaveBeenCalledOnce();
    expect(container.querySelector("details textarea")).toBeNull();
  });

  it("freezes the selection while a draft survives changed source content", async () => {
    nativeMode = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Keep original context");
    sourceHash = "refreshed-hash";
    const refreshed = file("a.ts", 2);
    refreshed.fileDiff.additionLines = ["changed\n"];
    render([refreshed]);
    expect(editor().value).toBe("Keep original context");
    expect(container.textContent).toContain("Selection changed");
    await act(async () => click("Ask agent"));
    expect(native.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: expect.objectContaining({
          diffHash: "public-hash",
          excerpt: "@@ -0,0 +1,1 @@\n+new",
        }),
      }),
    );
  });

  it("keeps reply text and the focused editor through discussion refreshes", async () => {
    nativeMode = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Question");
    await act(async () => click("Ask agent"));
    render([file("a.ts")]);
    const textarea = editor();
    act(() => textarea.focus());
    typeComment("Unsent reply");
    native.discussions = native.discussions.map((discussion) => ({
      ...discussion,
      updatedAt: "later",
      messages: [
        ...discussion.messages,
        {
          id: "answer",
          author: "assistant",
          text: "Answer",
          createdAt: "later",
          delivery: "none",
          deliveryError: null,
        },
      ],
    }));
    render([file("a.ts")]);
    expect(editor()).toBe(textarea);
    expect(editor().value).toBe("Unsent reply");
    expect(document.activeElement).toBe(textarea);
    expect(container.textContent).toContain("Answer");
  });

  it("keeps Add to chat secondary and does not send staged comments", () => {
    nativeMode = true;
    render([file("a.ts")]);
    click("Comment on a.ts");
    typeComment("Stage this");
    click("Add to chat");
    expect(native.mutate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(thread)?.reviewComments).toEqual([
      expect.objectContaining({ text: "Stage this" }),
    ]);
  });
});
