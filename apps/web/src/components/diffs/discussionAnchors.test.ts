import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { buildDiffReviewComment } from "~/reviewCommentContext";
import {
  createDiscussionAnchor,
  projectDiscussionAnchor,
  type DiscussionComparison,
} from "./discussionAnchors";

const comparison: DiscussionComparison = {
  sourceId: "working-tree",
  sourceKind: "working-tree",
  diffHash: "public-source-hash",
  baseRef: "HEAD",
  headRef: null,
};
const branch: DiscussionComparison = {
  sourceId: "branch-range",
  sourceKind: "branch-range",
  diffHash: "different-public-hash",
  baseRef: "main",
  headRef: "HEAD",
};
function file(body = "@@ -1,2 +1,2 @@\n-old\n+new\n tail") {
  return parsePatchFiles(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${body}\n`, "test")[0]!
    .files[0]!;
}
function anchor(side: "additions" | "deletions" = "additions") {
  const source = file();
  const comment = buildDiffReviewComment({
    id: "a",
    sectionId: "unstaged",
    sectionTitle: "Uncommitted",
    filePath: "a.ts",
    fileDiff: source,
    range: { start: 1, end: 1, side },
    text: "Why?",
  })!;
  return createDiscussionAnchor(source, comment, comparison)!;
}

describe("discussion anchor placement", () => {
  it.each(["added", "renamed"] as const)(
    "projects %s-file new-side anchors in both comparison directions",
    (change) => {
      const branchPatch =
        change === "added"
          ? "diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+new\n+tail\n"
          : "diff --git a/previous.ts b/a.ts\nsimilarity index 50%\nrename from previous.ts\nrename to a.ts\n--- a/previous.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n tail\n";
      const branchFile = parsePatchFiles(branchPatch, "branch")[0]!.files[0]!;
      const workingFile = file();
      for (const [fromFile, fromComparison, toFile, toComparison] of [
        [branchFile, branch, workingFile, comparison],
        [workingFile, comparison, branchFile, branch],
      ] as const) {
        const comment = buildDiffReviewComment({
          id: "a",
          sectionId: "test",
          sectionTitle: "Test",
          filePath: "a.ts",
          fileDiff: fromFile,
          range: { start: 1, end: 1, side: "additions" },
          text: "Question",
        })!;
        const saved = createDiscussionAnchor(fromFile, comment, fromComparison)!;
        expect(projectDiscussionAnchor(toFile, saved, toComparison)).toEqual({
          start: 1,
          end: 1,
          side: "additions",
          endSide: "additions",
        });
      }
    },
  );

  it("rejects new-side placement at another destination path", () => {
    const renamed = file();
    renamed.name = "different.ts";
    expect(projectDiscussionAnchor(renamed, anchor(), branch)).toBeNull();
  });

  it("keeps old-side path and immutable-base checks strict", () => {
    const commit = "a".repeat(40);
    const saved = { ...anchor("deletions"), baseRef: commit };
    const current = { ...branch, baseRef: commit };
    expect(projectDiscussionAnchor(file(), saved, current)).not.toBeNull();
    const renamed = file();
    renamed.prevName = "different.ts";
    expect(projectDiscussionAnchor(renamed, saved, current)).toBeNull();
    expect(
      projectDiscussionAnchor(file(), saved, { ...current, baseRef: "b".repeat(40) }),
    ).toBeNull();
  });

  it("accepts a proactive public-source anchor with plain selected source lines", () => {
    const proactive = {
      sourceId: "working-tree",
      sourceKind: "working-tree" as const,
      diffHash: "public-source-hash",
      baseRef: "HEAD",
      headRef: null,
      oldPath: "a.ts",
      newPath: "a.ts",
      side: "new" as const,
      startLine: 1,
      endLine: 1,
      excerpt: "new",
    };
    expect(projectDiscussionAnchor(file(), proactive, comparison)).toEqual({
      start: 1,
      end: 1,
      side: "additions",
      endSide: "additions",
    });
  });
  it("projects the same new-side change across uncommitted and branch tabs with different hashes", () => {
    expect(projectDiscussionAnchor(file(), anchor(), branch)).not.toBeNull();
    expect(projectDiscussionAnchor(file(), anchor("deletions"), branch)).toBeNull();
  });
  it("rejects a changed excerpt even when a caller supplies the same hash", () => {
    expect(
      projectDiscussionAnchor(file("@@ -1 +1 @@\n-old\n+changed"), anchor(), comparison),
    ).toBeNull();
  });
  it("does not search for a selection moved by inserted lines", () => {
    expect(
      projectDiscussionAnchor(
        file("@@ -1,2 +1,3 @@\n+inserted\n-old\n+new\n tail"),
        anchor(),
        branch,
      ),
    ).toBeNull();
  });
  it.each([branch, { ...comparison, diffHash: "changed" }])(
    "rejects repeated snippets when the source hash changes",
    (currentComparison) => {
      expect(
        projectDiscussionAnchor(
          file("@@ -1,2 +1,2 @@\n-old\n+new\n-newer\n+new"),
          anchor(),
          currentComparison,
        ),
      ).toBeNull();
    },
  );
  it("retains an unchanged selection when an unrelated edit changes the comparison hash", () => {
    expect(
      projectDiscussionAnchor(file(), anchor(), { ...comparison, diffHash: "changed" }),
    ).not.toBeNull();
  });
  it("does not collapse a cross-side selection into a one-side anchor", () => {
    const source = file();
    const comment = buildDiffReviewComment({
      id: "a",
      sectionId: "x",
      sectionTitle: "x",
      filePath: "a.ts",
      fileDiff: source,
      range: { start: 1, side: "deletions", end: 1, endSide: "additions" },
      text: "Why?",
    })!;
    expect(createDiscussionAnchor(source, comment, comparison)).toBeNull();
  });
});
