import type { ReviewDiscussion, ScopedThreadRef } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import {
  DiffDiscussionAnnotation,
  type DiffDiscussionsController,
} from "./DiffDiscussionAnnotation";
import { useDiffDiscussions } from "./useDiffDiscussions";

export interface DiscussionListEntry {
  discussion: ReviewDiscussion;
  state: "current" | "outdated" | "unvalidated" | "loading" | "error";
}

export function DiffDiscussionHistory({
  entries,
  controller,
  navigatingId,
  onGo,
}: {
  entries: readonly DiscussionListEntry[];
  controller: DiffDiscussionsController;
  navigatingId?: string;
  onGo?: (discussion: ReviewDiscussion) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <details className="max-h-80 shrink-0 overflow-auto border-b border-border/30 px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Discussions ({entries.length})
      </summary>
      <div className="mt-2 space-y-2">
        {entries.map(({ discussion, state }) => (
          <div key={discussion.id} data-discussion-row={discussion.id}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {discussion.anchor.newPath ?? discussion.anchor.oldPath}
                  {" · "}
                  {discussion.anchor.side} L{discussion.anchor.startLine}–
                  {discussion.anchor.endLine}
                </p>
                <p className="text-muted-foreground">
                  {discussion.resolved ? "Resolved" : "Open"}
                  {discussion.hidden ? " · Hidden" : ""}
                  {" · "}
                  {state === "current"
                    ? "Current"
                    : state === "outdated"
                      ? "Outdated"
                      : state === "error"
                        ? "Patch could not load"
                        : state === "loading"
                          ? "Loading patch…"
                          : "Not validated — patch not loaded"}
                  {navigatingId === discussion.id && discussion.hidden
                    ? " · Waiting for Show confirmation"
                    : ""}
                </p>
                <p className="truncate text-muted-foreground">
                  {discussion.messages[0]?.text ?? discussion.anchor.excerpt}
                </p>
              </div>
              {onGo && !discussion.hidden && state !== "outdated" ? (
                <Button
                  variant="ghost-muted"
                  size="xs"
                  disabled={state === "loading"}
                  onClick={() => onGo(discussion)}
                >
                  {state === "error"
                    ? "Retry load and go"
                    : state === "unvalidated"
                      ? "Load and go"
                      : state === "loading"
                        ? "Loading…"
                        : "Go to discussion"}
                </Button>
              ) : null}
            </div>
            {discussion.hidden || state === "outdated" ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">Saved discussion</summary>
                <pre className="my-2 overflow-auto whitespace-pre-wrap">
                  {discussion.anchor.excerpt}
                </pre>
                <DiffDiscussionAnnotation
                  discussion={discussion}
                  controller={controller}
                  outdated={state === "outdated"}
                  {...(onGo && state !== "outdated" ? { onShowAndGo: () => onGo(discussion) } : {})}
                />
              </details>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

export function EmptyDiffDiscussionHistory({ thread }: { thread: ScopedThreadRef }) {
  const controller = useDiffDiscussions(thread);
  return (
    <DiffDiscussionHistory
      controller={controller}
      entries={controller.discussions.map((discussion) => ({ discussion, state: "outdated" }))}
    />
  );
}
