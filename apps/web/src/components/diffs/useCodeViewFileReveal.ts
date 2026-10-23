import type {
  CodeView,
  CodeViewScrollTarget,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

interface DiscussionReveal {
  range: SelectedLineRange;
  discussionId: string;
  fileDiff: FileDiffMetadata;
}

// revealLine uses new-side coordinates. A collapsed unchanged gap has the same
// offset on both sides; changed old-side lines are already rendered in their hunk.
function contextLine(file: FileDiffMetadata, line: number, side: SelectedLineRange["side"]) {
  if (side !== "deletions") return line;
  for (const hunk of file.hunks) {
    if (line < hunk.deletionStart) return line + hunk.additionStart - hunk.deletionStart;
    if (line < hunk.deletionStart + hunk.deletionCount) return null;
  }
  const last = file.hunks.at(-1);
  return last
    ? line + last.additionStart + last.additionCount - last.deletionStart - last.deletionCount
    : line;
}

export function useCodeViewFileReveal<TScope>(
  viewer: FileRevealHandle | null,
  scope: TScope,
  readyFileKeys?: ReadonlyArray<string>,
) {
  const [request, setRequest] = useState<{
    fileKey: string;
    scope: TScope;
    discussion?: DiscussionReveal;
  } | null>(null);
  const handledRequest = useRef<typeof request>(null);

  useEffect(() => {
    if (request === null || handledRequest.current === request) return;
    if (request.scope !== scope) {
      handledRequest.current = request;
      return;
    }
    if (!viewer?.getInstance() || (readyFileKeys && !readyFileKeys.includes(request.fileKey)))
      return;
    if (!request.discussion) {
      viewer.scrollTo({ type: "item", id: request.fileKey, align: "start" });
      handledRequest.current = request;
      return;
    }

    const { discussion } = request;
    const instance = viewer.getInstance() as CodeView<unknown, undefined>;
    let frame = 0;
    let attempts = 0;
    let positioned = false;
    let mountedFile = false;
    const reveal = () => {
      // Scope cleanup cancels this loop. Bound retries if the renderer cannot
      // materialize a target; the row's Go button remains available for retry.
      if (++attempts > 120) return;
      const item = instance.getItem(request.fileKey);
      if (!item || item.type !== "diff") return;
      // Inline previews reparse the same patch on re-render. Their content cache
      // key stays stable even when the metadata object changes.
      if (
        item.fileDiff !== discussion.fileDiff &&
        (!discussion.fileDiff.cacheKey || item.fileDiff.cacheKey !== discussion.fileDiff.cacheKey)
      )
        return;
      if (item.collapsed) {
        frame = requestAnimationFrame(reveal);
        return;
      }
      const rendered = instance.getRenderedItems().find((entry) => entry.id === request.fileKey);
      if (!rendered || rendered.type !== "diff") {
        if (!mountedFile) {
          viewer.scrollTo({ type: "item", id: request.fileKey, align: "start" });
          mountedFile = true;
        }
        frame = requestAnimationFrame(reveal);
        return;
      }
      if (!positioned) {
        let expanded = false;
        for (const line of [discussion.range.start, discussion.range.end]) {
          const additionLine = contextLine(rendered.item.fileDiff, line, discussion.range.side);
          if (additionLine !== null)
            expanded = rendered.instance.revealLine(additionLine) || expanded;
        }
        if (expanded) {
          frame = requestAnimationFrame(reveal);
          return;
        }
        instance.setSelectedLines({ id: request.fileKey, range: discussion.range });
        // Annotations attach to the range end. Centering a taller-than-viewport
        // range aligns its start instead, leaving the discussion virtualized out.
        viewer.scrollTo({
          type: "line",
          id: request.fileKey,
          lineNumber: discussion.range.end,
          side: discussion.range.endSide ?? discussion.range.side ?? "additions",
          align: "center",
        });
        positioned = true;
        frame = requestAnimationFrame(reveal);
        return;
      }
      const thread = Array.from(
        rendered.element.querySelectorAll<HTMLElement>("[data-diff-discussion]"),
      ).find((element) => element.dataset.diffDiscussion === discussion.discussionId);
      if (!thread || thread.getBoundingClientRect().height === 0) {
        frame = requestAnimationFrame(reveal);
        return;
      }
      thread.focus({ preventScroll: true });
      thread.scrollIntoView({ block: "nearest", inline: "nearest" });
      handledRequest.current = request;
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [request, scope, viewer, readyFileKeys]);

  return (fileKey: string, discussion?: DiscussionReveal) =>
    setRequest({ fileKey, scope, ...(discussion ? { discussion } : {}) });
}
