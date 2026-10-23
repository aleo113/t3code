import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { ReviewDiscussionAnchor } from "@t3tools/contracts";

import { resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import { buildDiffReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";

export type DiscussionComparison = Pick<
  ReviewDiscussionAnchor,
  "sourceId" | "sourceKind" | "baseRef" | "headRef" | "diffHash"
>;

export function createDiscussionAnchor(
  file: FileDiffMetadata,
  comment: ReviewCommentContext,
  comparison: DiscussionComparison,
): ReviewDiscussionAnchor | null {
  const selection = comment.selection;
  // The native contract has one side. Mixed-side questions remain available via Add to chat.
  if (
    !selection ||
    selection.side !== selection.endSide ||
    Math.abs(selection.end - selection.start) >= 500 ||
    comment.diff.length > 32_768
  )
    return null;
  return {
    ...comparison,
    oldPath: file.type === "new" ? null : resolveFileDiffPreviousPath(file) || null,
    newPath: file.type === "deleted" ? null : resolveFileDiffPath(file) || null,
    side: selection.side === "deletions" ? "old" : "new",
    startLine: Math.min(selection.start, selection.end),
    endLine: Math.max(selection.start, selection.end),
    excerpt: comment.diff,
  };
}

function sourceExcerpt(patch: string, side: "old" | "new"): string {
  return patch
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith(side === "old" ? "+" : "-"))
    .map((line) => line.slice(1))
    .join("\n");
}

export function projectDiscussionAnchor(
  file: FileDiffMetadata,
  anchor: ReviewDiscussionAnchor,
  comparison: DiscussionComparison,
): SelectedLineRange | null {
  const newPath = file.type === "deleted" ? null : resolveFileDiffPath(file) || null;
  const oldPath = file.type === "new" ? null : resolveFileDiffPreviousPath(file) || null;
  if (
    anchor.side === "new"
      ? anchor.newPath !== newPath
      : anchor.oldPath !== oldPath || anchor.newPath !== newPath
  )
    return null;
  const sameVersion =
    anchor.diffHash === comparison.diffHash &&
    anchor.baseRef === comparison.baseRef &&
    anchor.headRef === comparison.headRef;
  // Named bases can move. Only an identical comparison or immutable base proves old-side identity.
  const sameOldVersion =
    anchor.baseRef !== null &&
    /^[a-f0-9]{40,64}$/i.test(anchor.baseRef) &&
    anchor.baseRef === comparison.baseRef;
  if (!sameVersion && anchor.side === "old" && !sameOldVersion) return null;
  const range: SelectedLineRange = {
    start: anchor.startLine,
    end: anchor.endLine,
    side: anchor.side === "old" ? "deletions" : "additions",
    endSide: anchor.side === "old" ? "deletions" : "additions",
  };
  const current = buildDiffReviewComment({
    id: "validate",
    sectionId: anchor.sourceId,
    sectionTitle: "",
    filePath: resolveFileDiffPath(file),
    fileDiff: file,
    range,
    text: "",
  });
  if (!current) return null;
  const selectedSource = sourceExcerpt(current.diff, anchor.side);
  // Agents can copy plain source lines; GUI drafts retain their full selected patch.
  const savedSource = /^@@ -\d+,\d+ \+\d+,\d+ @@\n/.test(anchor.excerpt)
    ? sourceExcerpt(anchor.excerpt, anchor.side)
    : anchor.excerpt;
  if (selectedSource !== savedSource) return null;
  if (!sameVersion) {
    const lines = (anchor.side === "old" ? file.deletionLines : file.additionLines).map((line) =>
      line.endsWith("\n") ? line.slice(0, -1) : line,
    );
    const selected = selectedSource.split("\n");
    let matches = 0;
    for (let index = 0; index <= lines.length - selected.length; index += 1) {
      if (selected.every((line, offset) => lines[index + offset] === line)) matches += 1;
    }
    if (matches !== 1) return null;
  }
  return range;
}
