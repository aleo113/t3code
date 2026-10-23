import "~/index.css";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type ReviewDiscussion,
  type ReviewDiscussionMutationInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useState } from "react";
import { CodeView, parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock("../hooks/useThreadRouteTarget", () => ({
  useThreadRouteRef: () => threadRef,
  useThreadRouteTarget: () => ({ ...threadRef, kind: "thread" }),
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => thread,
  useThreadCheckpointSummaries: () => turns,
  useProject: () => null,
}));
vi.mock("../state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: true }) }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => configAtom } }));
vi.mock("../state/vcs", () => ({ vcsEnvironment: { status: () => null, listRefs: () => null } }));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: () => previewAtom,
    discussions: () => discussionsAtom,
    mutateDiscussion: { permissionAtom: () => discussionPermissionAtom },
    diffFilePatch: ({ input }: { input: { request: { file: { path: string } } } }) =>
      patchAtoms(input.request.file.path),
  },
}));
const mutateDiscussion = vi.hoisted(() => vi.fn());
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mutateDiscussion }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    diffFilesCollapsed: useAtomValue(collapsedAtom),
  }),
  updateClientSettings: vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "dark",
  useTheme: () => ({ resolvedTheme: "dark" }),
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../fileContextMenu", () => ({ useFileContextMenuHandler: () => vi.fn() }));
vi.mock("../lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => {
    const diff = useAtomValue(checkpointAtom);
    return { data: diff === null ? null : { diff }, isPending: diff === null, error: null };
  },
}));

import DiffPanel from "./DiffPanel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useDiffDiscussionReplyStore } from "./diffs/diffDiscussionReplyStore";
import { useDiffPanelStore, useDiffPanelSessionStore } from "../diffPanelStore";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const thread = { ...threadRef, worktreePath: "/repo" };
const turns = [1, 2].map((ordinal) => ({
  runId: RunId.make(`turn-${ordinal}`),
  checkpointTurnCount: ordinal,
  completedAt: "2026-10-16T00:00:00Z",
}));
const paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
function filePatch(path: string) {
  const count = path === "e.txt" ? 30 : 4;
  const lines = Array.from({ length: count }, (_, index) => `+after ${index}`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${count} @@\n-before\n${lines}\n`;
}
const source: ReviewDiffPreviewSource = {
  id: "branch",
  kind: "branch-range",
  title: "Changes",
  baseRef: "main",
  headRef: "HEAD",
  diff: "",
  diffHash: "branch-diff",
  truncated: true,
  files: paths.map((path) => ({
    path,
    previousPath: null,
    additions: path === "e.txt" ? 30 : 4,
    deletions: 1,
  })),
};
const discussionsAtom = Atom.keepAlive(
  Atom.make(AsyncResult.success<{ discussions: readonly ReviewDiscussion[] }>({ discussions: [] })),
);
const discussionPermissionAtom = Atom.keepAlive(Atom.make(false));
const configAtom = Atom.make(null);
const collapsedAtom = Atom.make(true);
const checkpointAtom = Atom.make<string | null>(null);
let previewAtom = Atom.make(
  AsyncResult.success<ReviewDiffPreviewResult>({
    cwd: "/repo",
    generatedAt: DateTime.makeUnsafe("2026-10-16T00:00:00Z"),
    sources: [source, { ...source, id: "working", kind: "working-tree" }],
  }),
);
function loadedPatch(path: string): ReviewDiffPreviewSource {
  return {
    ...source,
    diff: filePatch(path),
    files: source.files?.filter((file) => file.path === path) ?? [],
    truncated: false,
  };
}
const patchAtoms = Atom.family((path: string) =>
  Atom.keepAlive(
    Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource>>(
      path === "e.txt" ? AsyncResult.initial() : AsyncResult.success(loadedPatch(path)),
    ),
  ),
);
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useDiffDiscussionReplyStore.setState({ replies: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("t3code.diffFileTreeOpen", "true");
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  mutateDiscussion.mockReset();
  mutateDiscussion.mockResolvedValue({ _tag: "Success" });
  registry = AtomRegistry.make();
  container = document.createElement("div");
  container.style.cssText = "width: 1000px; height: 300px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <DiffPanel
          visible
          mode="embedded"
          composerDraftTarget={threadRef}
          workspaceMutationId={null}
        />
      </RegistryContext.Provider>,
    ),
  );
}
const toggle = (path: string, expanded: boolean) =>
  page.getByRole("button", { name: `${expanded ? "Collapse" : "Expand"} ${path}`, exact: true });
const viewport = () => container.querySelector<HTMLElement>(".diff-render-surface")!;
async function selectTurn(path?: string, turn = turns[0]!) {
  await act(async () => useDiffPanelStore.getState().selectTurn(threadRef, turn.runId, path));
}
async function expectRevealed(path: string) {
  await expect.element(toggle(path, true)).toBeInTheDocument();
  await expect
    .poll(() => {
      const bounds = viewport().getBoundingClientRect();
      const header = toggle(path, true).element().getBoundingClientRect();
      return viewport().scrollTop > 0 && header.top >= bounds.top && header.bottom <= bounds.bottom;
    })
    .toBe(true);
}
async function scrollToStart() {
  await act(async () => {
    viewport().scrollTop = 0;
    viewport().dispatchEvent(new Event("scroll"));
    await new Promise(requestAnimationFrame);
  });
}
async function selectTreeFile(path: string) {
  const tree = container.querySelector("file-tree-container")!;
  const row = tree.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${path}"]`)!;
  await act(async () =>
    row.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true, button: 0, detail: 1 }),
    ),
  );
}

it("reveals a delayed turn selection, preserves siblings, and repeats after scope changes", async () => {
  await selectTurn("e.txt");
  await render();
  await expect
    .element(page.getByRole("status", { name: "Loading checkpoint diff..." }))
    .toBeInTheDocument();
  await act(async () => registry.set(checkpointAtom, paths.map(filePatch).join("")));
  await expectRevealed("e.txt");
  await act(async () => useDiffPanelStore.getState().selectGitScope(threadRef, "branch"));
  await expect.element(toggle("a.txt", false)).toBeInTheDocument();
  await selectTurn("e.txt");
  await expectRevealed("e.txt");
  await scrollToStart();
  await toggle("a.txt", false).click();
  await selectTurn("b.txt");
  await expect.element(toggle("b.txt", true)).toBeInTheDocument();
  await toggle("b.txt", true).click();
  await selectTurn("e.txt");
  await expectRevealed("e.txt");
  await scrollToStart();
  await expect.element(toggle("a.txt", true)).toBeInTheDocument();
  await expect.element(toggle("b.txt", false)).toBeInTheDocument();
  await expect.element(toggle("c.txt", false)).toBeInTheDocument();
  await selectTurn("e.txt");
  await expectRevealed("e.txt");

  await selectTurn(undefined, turns[1]!);
  await expect.element(toggle("a.txt", false)).toBeInTheDocument();
  await expect.element(toggle("e.txt", false)).toBeInTheDocument();
});

it("waits for a lazy Git patch while preserving sibling choices and expanded defaults", async () => {
  registry.set(collapsedAtom, false);
  await render();
  await toggle("b.txt", true).click();
  await selectTreeFile("b.txt");
  await expect.element(toggle("b.txt", true)).toBeInTheDocument();
  await toggle("b.txt", true).click();
  await scrollToStart();
  await selectTreeFile("e.txt");
  expect(viewport().scrollTop).toBe(0);
  await expect.element(toggle("e.txt", true)).not.toBeInTheDocument();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await expectRevealed("e.txt");
  await scrollToStart();
  await expect.element(toggle("a.txt", true)).toBeInTheDocument();
  await expect.element(toggle("b.txt", false)).toBeInTheDocument();
  await act(async () => useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged"));
  await expect.element(toggle("b.txt", true)).toBeInTheDocument();
});

function discussion(id: string, changes: Partial<ReviewDiscussion> = {}): ReviewDiscussion {
  return {
    id,
    threadId: threadRef.threadId,
    hidden: false,
    resolved: false,
    createdAt: "now",
    updatedAt: "now",
    anchor: {
      sourceId: source.id,
      sourceKind: source.kind,
      diffHash: source.diffHash,
      baseRef: source.baseRef,
      headRef: source.headRef,
      oldPath: "e.txt",
      newPath: "e.txt",
      side: "new",
      startLine: 30,
      endLine: 30,
      excerpt: "after 29",
    },
    messages: [
      {
        id: `${id}-message`,
        author: "assistant",
        text: `Question ${id}`,
        createdAt: "now",
        delivery: "none",
        deliveryError: null,
      },
    ],
    ...changes,
  };
}
async function publishDiscussions(discussions: readonly ReviewDiscussion[]) {
  await act(async () => registry.set(discussionsAtom, AsyncResult.success({ discussions })));
}
function discussionRow(id: string) {
  return page.elementLocator(
    container.querySelector<HTMLElement>(`[data-discussion-row="${id}"]`)!,
  );
}
async function expectDiscussionFocused(id: string) {
  await expect.poll(() => document.activeElement?.getAttribute("data-diff-discussion")).toBe(id);
  await expect
    .poll(() => {
      const rect = document.activeElement!.getBoundingClientRect();
      const bounds = viewport().getBoundingClientRect();
      return rect.top < bounds.bottom && rect.bottom > bounds.top && viewport().scrollTop > 0;
    })
    .toBe(true);
}

it("lists unvalidated discussions, loads a provisional added-file key, and focuses the exact same-line thread", async () => {
  container.style.height = "650px";
  const first = discussion("first");
  const second = discussion("second", { resolved: true });
  await publishDiscussions([first, second]);
  await render();
  await page.getByText("Discussions (2)", { exact: true }).click();
  await expect.poll(() => discussionRow("second").element().textContent).toContain("Not validated");
  await expect.poll(() => discussionRow("second").element().textContent).not.toContain("Outdated");
  await discussionRow("second").getByRole("button", { name: "Load and go", exact: true }).click();
  await expect.poll(() => discussionRow("second").element().textContent).toContain("Loading patch");
  expect(document.activeElement?.getAttribute("data-diff-discussion")).toBeNull();
  const added = {
    ...loadedPatch("e.txt"),
    diff: filePatch("e.txt")
      .replace("--- a/e.txt", "--- /dev/null")
      .replace("@@ -1 +1,30 @@\n-before", "@@ -0,0 +1,30 @@"),
  };
  // Replacing the selection object with the same comparison while unfolding
  // must not cancel the first queued jump (e.g. a reconciled store snapshot).
  const stopReplacingSelection = useDiffPanelSessionStore.subscribe(() =>
    useDiffPanelStore.getState().selectGitScope(threadRef, "branch"),
  );
  await act(async () => registry.set(patchAtoms("e.txt"), AsyncResult.success(added)));
  stopReplacingSelection();
  await expectDiscussionFocused("second");
  await expect
    .poll(() => discussionRow("second").element().textContent)
    .toContain("Resolved · Current");
  expect(container.querySelector("details textarea")).toBeNull();
  expect(mutateDiscussion).not.toHaveBeenCalled();
  await discussionRow("first")
    .getByRole("button", { name: "Go to discussion", exact: true })
    .click();
  await expectDiscussionFocused("first");
  await scrollToStart();
  await expect.element(toggle("a.txt", false)).toBeInTheDocument();
});

it.each(["new", "old"] as const)(
  "reveals the exact discussion after one pointer click on a multi-viewport %s-side range",
  async (side) => {
    container.style.height = "650px";
    const before = Array.from({ length: 600 }, (_, index) => `before ${index}`);
    const after = Array.from({ length: 600 }, (_, index) => `after ${index}`);
    const saved = discussion("long-range");
    const entry = {
      ...saved,
      anchor: {
        ...saved.anchor,
        side,
        startLine: 50,
        endLine: 500,
        excerpt: (side === "old" ? before : after).slice(49, 500).join("\n"),
      },
    };
    const patch = {
      ...loadedPatch("e.txt"),
      diff: `diff --git a/e.txt b/e.txt\n--- a/e.txt\n+++ b/e.txt\n@@ -1,600 +1,600 @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}\n`,
    };
    await publishDiscussions([{ ...entry, id: "same-range" }, entry]);
    const selection = vi.spyOn(CodeView.prototype, "setSelectedLines");
    try {
      await render();
      await selectTreeFile("e.txt");
      await act(async () => registry.set(patchAtoms("e.txt"), AsyncResult.success(patch)));
      await page.getByText("Discussions (2)", { exact: true }).click();
      await expect.poll(() => discussionRow(entry.id).element().textContent).toContain("Current");
      const go = discussionRow(entry.id).getByRole("button", {
        name: "Go to discussion",
        exact: true,
      });
      const pointerDown = vi.fn();
      go.element().addEventListener("pointerdown", pointerDown);
      await go.click();
      expect(pointerDown).toHaveBeenCalledTimes(1);
      await expect
        .poll(() => document.activeElement?.getAttribute("data-diff-discussion"), { timeout: 5000 })
        .toBe(entry.id);
      await expect
        .poll(() => {
          const thread = document.activeElement!;
          const comment = Array.from(thread.querySelectorAll("p")).find(
            (element) => element.textContent === `Question ${entry.id}`,
          );
          const header = thread
            .closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-diffs-header]");
          if (!comment || !header) return false;
          const rect = comment.getBoundingClientRect();
          const bounds = viewport().getBoundingClientRect();
          return (
            rect.height > 0 &&
            rect.top >= Math.max(bounds.top, header.getBoundingClientRect().bottom) &&
            rect.bottom <= bounds.bottom
          );
        })
        .toBe(true);
      const viewer = selection.mock.contexts.at(-1) as CodeView | undefined;
      expect(viewer?.getSelectedLines()?.range).toEqual({
        start: 50,
        end: 500,
        side: side === "old" ? "deletions" : "additions",
        endSide: side === "old" ? "deletions" : "additions",
      });
    } finally {
      selection.mockRestore();
    }
  },
);

it.each([
  { path: "a.txt", start: 15, end: 15 },
  { path: "d.txt", start: 48, end: 75 },
])(
  "reveals $path lines $start–$end in a reparsed inline preview with many discussions",
  async ({ path, start, end }) => {
    container.style.height = "650px";
    const lines = Array.from({ length: 80 }, (_, index) => `after ${index}`);
    const filePaths = ["a.txt", "b.txt", "c.txt", "d.txt"];
    const entries = filePaths.flatMap((filePath) =>
      [15, 25, 35, 45, 55, 65, 75].map((line) => {
        const entry = discussion(`${filePath}:${line}`);
        return {
          ...entry,
          anchor: {
            ...entry.anchor,
            oldPath: filePath,
            newPath: filePath,
            startLine: line === 75 ? 48 : line,
            endLine: line,
            excerpt: lines.slice(line === 75 ? 47 : line - 1, line).join("\n"),
          },
          messages: entry.messages.map((message) => ({
            ...message,
            text: `Discussion ${entry.id}. ${"An explanation of this small selection. ".repeat(9)}`,
          })),
        };
      }),
    );
    const savedPreview = previewAtom;
    previewAtom = Atom.make(
      AsyncResult.success<ReviewDiffPreviewResult>({
        cwd: "/repo",
        generatedAt: DateTime.makeUnsafe("2026-10-16T00:00:00Z"),
        sources: [
          {
            ...source,
            truncated: false,
            diff: filePaths
              .map(
                (filePath) =>
                  `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1,80 @@\n-before\n${lines.map((line) => `+${line}`).join("\n")}\n`,
              )
              .join(""),
          },
        ],
      }),
    );
    const selection = vi.spyOn(CodeView.prototype, "setSelectedLines");
    try {
      await publishDiscussions(entries);
      await render();
      await page.getByText("Discussions (28)", { exact: true }).click();
      const id = `${path}:${end}`;
      const go = discussionRow(id).getByRole("button", { name: "Go to discussion", exact: true });
      const pointerDown = vi.fn();
      go.element().addEventListener("pointerdown", pointerDown);
      await go.click();
      expect(pointerDown).toHaveBeenCalledTimes(1);
      await expect
        .poll(() => document.activeElement?.getAttribute("data-diff-discussion"), { timeout: 3000 })
        .toBe(id);
      await expect
        .poll(() => {
          const thread = document.activeElement!;
          const comment = thread.querySelector("p")!;
          const header = thread
            .closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-diffs-header]");
          if (!comment || !header) return false;
          const rect = comment.getBoundingClientRect();
          const bounds = viewport().getBoundingClientRect();
          return (
            rect.height > 0 &&
            rect.top >= Math.max(bounds.top, header.getBoundingClientRect().bottom) &&
            rect.bottom <= bounds.bottom
          );
        })
        .toBe(true);
      const viewer = selection.mock.contexts.at(-1) as CodeView | undefined;
      expect(viewer?.getSelectedLines()?.range).toEqual({
        start,
        end,
        side: "additions",
        endSide: "additions",
      });
    } finally {
      selection.mockRestore();
      previewAtom = savedPreview;
    }
  },
);

it("waits for a confirmed Show poll before navigating and does not reopen a resolved discussion", async () => {
  container.style.height = "650px";
  registry.set(discussionPermissionAtom, true);
  const hidden = discussion("hidden", { hidden: true, resolved: true });
  await publishDiscussions([hidden]);
  await render();
  await page.getByText("Discussions (1)", { exact: true }).click();
  // The fifth lazy file still needs to be requested before it can be validated.
  await discussionRow("hidden").getByText("Saved discussion", { exact: true }).click();
  await discussionRow("hidden").getByRole("button", { name: "Show and go", exact: true }).click();
  await expect.poll(() => mutateDiscussion.mock.calls.length).toBe(1);
  expect(mutateDiscussion.mock.calls[0]![0].input).toEqual({
    type: "status",
    threadId: threadRef.threadId,
    discussionId: hidden.id,
    hidden: false,
  } satisfies ReviewDiscussionMutationInput);
  await expect
    .poll(() => discussionRow("hidden").element().textContent)
    .toContain("Waiting for Show confirmation");
  expect(container.querySelector(".diff-render-surface [data-diff-discussion]")).toBeNull();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await publishDiscussions([{ ...hidden, hidden: false }]);
  await expectDiscussionFocused("hidden");
  await expect
    .element(page.getByRole("button", { name: "Reopen", exact: true }))
    .toBeInTheDocument();
  expect(container.querySelector("details textarea")).toBeNull();
});

it("cancels queued navigation on comparison switch and keeps mismatched loaded excerpts outdated", async () => {
  container.style.height = "650px";
  await publishDiscussions([discussion("queued")]);
  await render();
  await page.getByText("Discussions (1)", { exact: true }).click();
  await discussionRow("queued").getByRole("button", { name: "Load and go", exact: true }).click();
  await act(async () => useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged"));
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await page.getByText("Discussions (1)", { exact: true }).click();
  await expect
    .element(discussionRow("queued").getByRole("button", { name: "Load and go", exact: true }))
    .toBeInTheDocument();
  expect(document.activeElement?.getAttribute("data-diff-discussion")).toBeNull();
  const changed = {
    ...loadedPatch("e.txt"),
    diff: filePatch("e.txt").replace("+after 29", "+different content"),
  };
  await act(async () => registry.set(patchAtoms("e.txt"), AsyncResult.success(changed)));
  await expect.poll(() => discussionRow("queued").element().textContent).toContain("Outdated");
  await expect
    .element(discussionRow("queued").getByRole("button", { name: "Go to discussion", exact: true }))
    .not.toBeInTheDocument();
  expect(document.activeElement?.getAttribute("data-diff-discussion")).toBeNull();
});

it("offers explicit retry for a patch load failure without calling the discussion outdated", async () => {
  container.style.height = "650px";
  await render();
  await publishDiscussions([discussion("retry")]);
  await page.getByText("Discussions (1)", { exact: true }).click();
  await discussionRow("retry").getByRole("button", { name: "Load and go", exact: true }).click();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success({ ...loadedPatch("e.txt"), diff: "" })),
  );
  await expect
    .poll(() => discussionRow("retry").element().textContent)
    .toContain("Patch could not load");
  await expect.poll(() => discussionRow("retry").element().textContent).not.toContain("Outdated");
  const refresh = vi.spyOn(registry, "refresh");
  await discussionRow("retry")
    .getByRole("button", { name: "Retry load and go", exact: true })
    .click();
  expect(refresh).toHaveBeenCalled();
  refresh.mockRestore();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await expectDiscussionFocused("retry");
});

async function openReplyDiscussion() {
  container.style.height = "650px";
  registry.set(discussionPermissionAtom, true);
  const entry = discussion("reply-owner");
  await publishDiscussions([entry]);
  await render();
  await page.getByText("Discussions (1)", { exact: true }).click();
  await discussionRow(entry.id)
    .getByRole("button", { name: /^(Load and go|Go to discussion)$/ })
    .click();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await expectDiscussionFocused(entry.id);
  return entry;
}

const replyEditor = () => page.getByRole("textbox", { name: "Comment on lines 30–30" });

async function remountReplyPanel() {
  await act(async () => root.render(null));
  expect(container.querySelector("[data-diff-discussion]")).toBeNull();
  await render();
  await page.getByText("Discussions (1)", { exact: true }).click();
  await discussionRow("reply-owner")
    .getByRole("button", { name: /^(Load and go|Go to discussion)$/ })
    .click();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await expectDiscussionFocused("reply-owner");
}

it("retains an unsent discussion reply when the real viewer unmounts and remounts", async () => {
  await openReplyDiscussion();
  await replyEditor().fill("Keep this unsent reply");
  const previousEditor = replyEditor().element();
  await remountReplyPanel();
  expect(previousEditor.isConnected).toBe(false);
  await expect.element(replyEditor()).toHaveValue("Keep this unsent reply");
  expect(mutateDiscussion).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await remountReplyPanel();
  await expect.element(replyEditor()).toHaveValue("");
});

it("retains a draft through Pierre portal virtualization and reconciles an offscreen reply", async () => {
  const entry = await openReplyDiscussion();
  const lines = Array.from({ length: 2000 }, (_, index) => `+after ${index}`).join("\n");
  await scrollToStart();
  await toggle("a.txt", false).click();
  await act(async () =>
    registry.set(
      patchAtoms("a.txt"),
      AsyncResult.success({
        ...loadedPatch("a.txt"),
        diff: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2000 @@\n-before\n${lines}\n`,
      }),
    ),
  );
  await discussionRow(entry.id)
    .getByRole("button", { name: "Go to discussion", exact: true })
    .click();
  await expectDiscussionFocused(entry.id);
  const editor = replyEditor();
  await editor.fill("Keep the offscreen draft");
  const original = editor.element();
  await page.getByText("Discussions (1)", { exact: true }).click();
  await scrollToStart();
  await expect.poll(() => original.isConnected).toBe(false);
  await page.getByText("Discussions (1)", { exact: true }).click();
  await discussionRow(entry.id)
    .getByRole("button", { name: "Go to discussion", exact: true })
    .click();
  await expectDiscussionFocused(entry.id);
  await expect.element(editor).toHaveValue("Keep the offscreen draft");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect.poll(() => mutateDiscussion.mock.calls.length).toBe(1);
  const attempted = mutateDiscussion.mock.calls[0]![0].input;
  const submitted = editor.element();
  await page.getByText("Discussions (1)", { exact: true }).click();
  await scrollToStart();
  await expect.poll(() => submitted.isConnected).toBe(false);
  await publishDiscussions([
    {
      ...entry,
      messages: [
        ...entry.messages,
        {
          id: attempted.messageId,
          text: attempted.text,
          author: "user",
          createdAt: "now",
          delivery: "sent",
          deliveryError: null,
        },
      ],
    },
  ]);
  await page.getByText("Discussions (1)", { exact: true }).click();
  await discussionRow(entry.id)
    .getByRole("button", { name: "Go to discussion", exact: true })
    .click();
  await expectDiscussionFocused(entry.id);
  await expect.element(editor).toHaveValue("");
  await expect.element(editor).not.toHaveAttribute("readonly");
});

it.each(["remounted viewer", "outdated history"] as const)(
  "retains an in-flight and lost-response reply envelope in the %s",
  async (destination) => {
    const entry = await openReplyDiscussion();
    let loseResponse!: () => void;
    mutateDiscussion.mockReturnValueOnce(
      new Promise<{ _tag: "Failure" }>((resolve) => {
        loseResponse = () => resolve({ _tag: "Failure" });
      }),
    );
    await replyEditor().fill("One uncertain post");
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect.poll(() => mutateDiscussion.mock.calls.length).toBe(1);
    const attempted = mutateDiscussion.mock.calls[0]![0];
    const previousEditor = replyEditor().element();
    if (destination === "remounted viewer") {
      await remountReplyPanel();
    } else {
      await act(async () =>
        registry.set(
          patchAtoms("e.txt"),
          AsyncResult.success({
            ...loadedPatch("e.txt"),
            diff: filePatch("e.txt").replace("+after 29", "+changed target"),
          }),
        ),
      );
      await expect.poll(() => discussionRow(entry.id).element().textContent).toContain("Outdated");
      await discussionRow(entry.id).getByText("Saved discussion", { exact: true }).click();
    }
    expect(previousEditor.isConnected).toBe(false);
    await expect.element(replyEditor()).toHaveValue("One uncertain post");
    await expect.element(replyEditor()).toHaveAttribute("readonly");
    await expect
      .element(page.getByRole("button", { name: "Retry post", exact: true }))
      .toBeDisabled();
    await act(async () => loseResponse());
    if (destination === "remounted viewer") await remountReplyPanel();
    await expect
      .element(page.getByRole("button", { name: "Retry post", exact: true }))
      .toBeEnabled();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Resolve", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Hide discussion", exact: true }))
      .toBeDisabled();
    await act(async () => registry.set(discussionPermissionAtom, false));
    await expect
      .element(page.getByRole("button", { name: "Retry post", exact: true }))
      .toBeDisabled();
    await act(async () => registry.set(discussionPermissionAtom, true));
    await page.getByRole("button", { name: "Retry post", exact: true }).click();
    await expect.poll(() => mutateDiscussion.mock.calls.length).toBe(2);
    expect(mutateDiscussion.mock.calls[1]![0]).toEqual(attempted);
    // A successful response still needs saved-ID confirmation from the poll.
    await expect.element(replyEditor()).toHaveAttribute("readonly");
    await publishDiscussions([
      {
        ...entry,
        messages: [
          ...entry.messages,
          {
            id: attempted.input.messageId,
            text: attempted.input.text,
            author: "user",
            createdAt: "now",
            delivery: "sent",
            deliveryError: null,
          },
        ],
      },
    ]);
    await expect.element(replyEditor()).toHaveValue("");
    await expect.element(replyEditor()).not.toHaveAttribute("readonly");
    await replyEditor().fill("A distinct follow-up");
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect.poll(() => mutateDiscussion.mock.calls.length).toBe(3);
    expect(mutateDiscussion.mock.calls[2]![0].input.messageId).not.toBe(attempted.input.messageId);
    expect(mutateDiscussion.mock.calls[2]![0].input.text).toBe("A distinct follow-up");
  },
);

function ContextDiscussionView({ fileDiff }: { fileDiff: FileDiffMetadata }) {
  const [viewer, setViewer] = useState<AnnotatableCodeViewHandle | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const requestReveal = useCodeViewFileReveal(viewer, "context", ["context"]);
  return (
    <AnnotatableCodeView
      viewerRef={setViewer}
      codeViewKey="context"
      className="h-full min-h-0 overflow-auto"
      files={[{ fileDiff, filePath: "context.txt", fileKey: "context", fileVersion: 1, collapsed }]}
      pendingFiles={[]}
      sectionId="branch"
      sectionTitle="Changes"
      composerDraftTarget={threadRef}
      comparison={{
        sourceId: source.id,
        sourceKind: source.kind,
        diffHash: source.diffHash,
        baseRef: source.baseRef,
        headRef: source.headRef,
      }}
      onGoToDiscussion={(fileKey, range, discussionId) => {
        setCollapsed(false);
        requestReveal(fileKey, { range, discussionId, fileDiff });
      }}
      options={{}}
      renderHeaderFilenameSuffix={() => null}
      renderHeaderPrefix={() => null}
      onRevealSearchMatch={() => setCollapsed(false)}
    />
  );
}

it.each(["new", "old"] as const)(
  "reveals collapsed %s-side context before focusing its exact discussion",
  async (side) => {
    container.style.height = "650px";
    const before = Array.from({ length: 1000 }, (_, index) => `context ${index}`);
    const after = before.with(899, "changed line");
    const fileDiff = parseDiffFromFile(
      { name: "context.txt", contents: before.join("\n") },
      { name: "context.txt", contents: after.join("\n") },
    );
    const entry = discussion("context");
    await publishDiscussions([
      {
        ...entry,
        anchor: {
          ...entry.anchor,
          oldPath: "context.txt",
          newPath: "context.txt",
          side,
          startLine: 400,
          endLine: 400,
          excerpt: "context 399",
        },
      },
    ]);
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ContextDiscussionView fileDiff={fileDiff} />
        </RegistryContext.Provider>,
      ),
    );
    await page.getByText("Discussions (1)", { exact: true }).click();
    await discussionRow("context")
      .getByRole("button", { name: "Go to discussion", exact: true })
      .click();
    await expectDiscussionFocused("context");
    const diff = container.querySelector("diffs-container")!;
    await expect.poll(() => diff.shadowRoot?.textContent).toContain("context 399");
    await expect
      .poll(() =>
        Array.from(diff.shadowRoot?.querySelectorAll("[data-line][data-selected-line]") ?? []).some(
          (line) => line.textContent?.includes("context 399"),
        ),
      )
      .toBe(true);
  },
);
