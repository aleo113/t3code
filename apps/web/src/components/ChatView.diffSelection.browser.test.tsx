import "~/index.css";

import { EnvironmentId, RunId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
  useLocation: () => "/",
}));
vi.mock("../hooks/useThreadRouteTarget", () => ({
  useThreadRouteRef: () => routeRef,
  useThreadRouteTarget: () => routeRef && { ...routeRef, kind: "thread" },
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useQuietThreadShell: (ref: ScopedThreadRef | null) => ref ? threads.get(ref.threadId) ?? null : null,
  useThreadCheckpointSummaries: () => turns,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../state/vcs", async (original) => ({
  ...(await original<typeof import("../state/vcs")>()),
  vcsEnvironment: {
    ...(await original<typeof import("../state/vcs")>()).vcsEnvironment,
    status: () => null,
    listRefs: () => null,
  },
}));
vi.mock("../state/review", async (original) => ({
  ...(await original<typeof import("../state/review")>()),
  reviewEnvironment: {
    ...(await original<typeof import("../state/review")>()).reviewEnvironment,
    diffPreview: ({ input }: { input: { baseRef?: string } }) => previewAtoms(input.baseRef ?? "main"),
  },
}));
vi.mock("../lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => ({ data: { diff: "" }, isPending: false, error: null }),
}));
vi.mock("./chat/ChatComposer", () => ({ ChatComposer: () => null }));
vi.mock("./chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("./chat/RightPanelSurfaceContent", () => ({
  RightPanelSurfaceContent: (props: { surface: { kind: string } | null; threadRef: ScopedThreadRef; visible: boolean }) =>
    props.surface?.kind === "diff" ? <DiffPanel composerDraftTarget={props.threadRef} workspaceMutationId={null} visible={props.visible} /> : null,
}));

import ChatView from "./ChatView";
import DiffPanel from "./DiffPanel";

const environmentId = EnvironmentId.make("diff-selection-test");
const threadA = { environmentId, threadId: ThreadId.make("selection-a") };
const threadB = { environmentId, threadId: ThreadId.make("selection-b") };
const threads = new Map([threadA, threadB].map((ref) => [ref.threadId, makeThreadFixture({ environmentId, id: ref.threadId, worktreePath: "/repo" })]));
const turns = [1, 2].map((ordinal) => ({
  runId: RunId.make(`selection-turn-${ordinal}`),
  checkpointTurnCount: ordinal,
  completedAt: "2026-10-16T00:00:00Z",
}));
const previewAtoms = Atom.family((baseRef: string) => Atom.make(AsyncResult.success({
  cwd: "/repo",
  generatedAt: DateTime.makeUnsafe("2026-10-16T00:00:00Z"),
  sources: ["branch-range", "working-tree"].map((kind) => ({
    id: kind,
    kind,
    title: kind,
    baseRef,
    headRef: "HEAD",
    diff: "",
    diffHash: kind,
    truncated: false,
  })),
})));
let routeRef: ScopedThreadRef | null;
let root: Root;
let container: HTMLDivElement;

function Navigation() {
  const [ref, setRef] = useState<ScopedThreadRef | null>(threadA);
  routeRef = ref;
  return <AppAtomRegistryProvider>
    <nav>
      <button onClick={() => setRef(null)}>Usage</button>
      <button onClick={() => setRef(threadA)}>Thread A</button>
      <button onClick={() => setRef(threadB)}>Thread B</button>
    </nav>
    {ref ? <ChatView {...ref} routeKind="server" /> : <div>Usage page</div>}
  </AppAtomRegistryProvider>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {}, closeRevisionByThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  for (const ref of [threadA, threadB]) useRightPanelStore.getState().open(ref, "diff");
  routeRef = threadA;
  container = document.createElement("div");
  container.style.cssText = "width: 1200px; height: 700px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function clickButton(name: string) {
  const button = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === name);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

const choices = [
  { label: "Uncommitted", select: () => useDiffPanelStore.getState().selectGitScope(threadA, "unstaged") },
  { label: "Changes", select: () => useDiffPanelStore.getState().selectBranchBaseRef(threadA, "release/base") },
  { label: "Turn 1", select: () => useDiffPanelStore.getState().selectTurn(threadA, turns[0]!.runId) },
];

for (const destination of ["Usage", "Thread B"]) {
  it.each(choices)(`keeps $label and its comparison after ${destination} → Thread A`, async ({ label, select }) => {
    await act(async () => root.render(<Navigation />));
    console.info("mounted", JSON.stringify(useRightPanelStore.getState().byThreadKey), container.textContent?.slice(0, 1500), Array.from(container.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label")));
    await act(async () => select());
    const selection = selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadA);
    expect(container.querySelector(`[aria-label="Diff scope: ${label}"]`)).not.toBeNull();
    await clickButton(destination);
    await clickButton("Thread A");
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadA)).toEqual(selection);
    expect(container.querySelector(`[aria-label="Diff scope: ${label}"]`)).not.toBeNull();
    if (label === "Changes") {
      expect(container.querySelector('[aria-label="Change comparison target. Currently release/base"]')).not.toBeNull();
    }
  });
}
