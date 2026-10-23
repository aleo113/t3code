import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ReviewDiscussion, ReviewDiscussionAnchor, ScopedThreadRef } from "@t3tools/contracts";
import { ReviewDiscussionMutationInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { randomUUID } from "~/lib/utils";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32, resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { nextFileCommentId } from "../files/fileCommentAnnotations";
import {
  createDiscussionAnchor,
  projectDiscussionAnchor,
  type DiscussionComparison,
} from "./discussionAnchors";
import {
  DiffDiscussionAnnotation,
  type DiffDiscussionsController,
} from "./DiffDiscussionAnnotation";
import { DiffDiscussionHistory, type DiscussionListEntry } from "./DiffDiscussionHistory";
import { useDiffDiscussions } from "./useDiffDiscussions";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";

const isDiscussionMutation = Schema.is(ReviewDiscussionMutationInput);

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  discussion?: ReviewDiscussion;
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup, undefined>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  pendingFiles: ReadonlyArray<FileDiffMetadata>;
  sectionId: string;
  sectionTitle: string;
  comparison?: DiscussionComparison;
  discussionFileStates?: ReadonlyMap<string, { error: boolean }>;
  onLoadDiscussionFile?: (path: string) => void;
  onGoToDiscussion?: (fileKey: string, range: SelectedLineRange, discussionId: string) => void;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderCodeViewFooter?: () => ReactNode;
  unsafeCSSExtra?: string;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  onRevealSearchMatch: (fileKey: string) => void;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView(props: AnnotatableCodeViewProps) {
  return typeof props.composerDraftTarget === "string" || !props.comparison ? (
    <AnnotatableCodeViewContent {...props} />
  ) : (
    <ThreadAnnotatableCodeView {...props} thread={props.composerDraftTarget} />
  );
}

function ThreadAnnotatableCodeView(props: AnnotatableCodeViewProps & { thread: ScopedThreadRef }) {
  const discussions = useDiffDiscussions(props.thread);
  return <AnnotatableCodeViewContent {...props} discussionController={discussions} />;
}

function AnnotatableCodeViewContent({
  codeViewKey,
  files,
  pendingFiles,
  sectionId,
  sectionTitle,
  comparison,
  discussionFileStates,
  onLoadDiscussionFile,
  onGoToDiscussion,
  discussionController,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
  onRevealSearchMatch,
}: AnnotatableCodeViewProps & { discussionController?: DiffDiscussionsController }) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<{
    fileKey: string;
    filePath: string;
    previousFilePath: string;
    annotation: DiffCommentLineAnnotation;
    comment: ReviewCommentContext;
    anchor: ReviewDiscussionAnchor | null;
    comparison: DiscussionComparison | undefined;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [posting, setPosting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [attemptedPost, setAttemptedPost] = useState<Extract<
    ReviewDiscussionMutationInput,
    { type: "create" }
  > | null>(null);
  if (
    attemptedPost &&
    discussionController?.discussions.some(
      (discussion) =>
        discussion.id === attemptedPost.id &&
        discussion.messages.some((message) => message.id === attemptedPost.messageId),
    )
  ) {
    setAttemptedPost(null);
    setDraft(null);
    setDraftText("");
    setSelectedLines(null);
  }

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  if (
    draft !== null &&
    attemptedPost === null &&
    !filesByKey.has(draft.fileKey) &&
    // Lazy placeholders have provisional change types, so match both paths instead.
    !pendingFiles.some(
      (file) =>
        resolveFileDiffPath(file) === draft.filePath &&
        resolveFileDiffPreviousPath(file) === draft.previousFilePath,
    )
  ) {
    setDraft(null);
    setDraftText("");
    setSelectedLines(null);
  }
  const draftFile = draft ? filesByKey.get(draft.fileKey) : undefined;
  const currentDraftComment =
    draft && draftFile
      ? buildDiffReviewComment({
          ...draft.comment,
          fileDiff: draftFile.fileDiff,
          range: draft.comment.selection!,
        })
      : null;
  const draftIsCurrent =
    draft !== null &&
    currentDraftComment?.diff === draft.comment.diff &&
    draft.comparison?.diffHash === comparison?.diffHash;
  const navigationScope = JSON.stringify([codeViewKey, composerDraftTarget, comparison]);
  const [navigation, setNavigation] = useState<{
    discussionId: string;
    path: string;
    scope: string;
  } | null>(null);
  if (navigation && navigation.scope !== navigationScope) setNavigation(null);
  const activeNavigation = navigation?.scope === navigationScope ? navigation : null;
  const navigated = useRef<typeof navigation>(null);
  const discussionEntries: DiscussionListEntry[] = (discussionController?.discussions ?? []).map(
    (discussion) => {
      const path = discussion.anchor.newPath ?? discussion.anchor.oldPath;
      const pending = pendingFiles.some((file) => resolveFileDiffPath(file) === path);
      const current =
        comparison &&
        files.some(
          ({ fileDiff }) =>
            !fileDiff.cacheKey?.endsWith(":pending") &&
            projectDiscussionAnchor(fileDiff, discussion.anchor, comparison),
        );
      return {
        discussion,
        state: current
          ? "current"
          : pending
            ? discussionFileStates?.get(path ?? "")?.error
              ? "error"
              : activeNavigation?.discussionId === discussion.id
                ? "loading"
                : "unvalidated"
            : "outdated",
      };
    },
  );
  useEffect(() => {
    if (!activeNavigation || navigated.current === activeNavigation || !comparison) return;
    const discussion = discussionController?.discussions.find(
      (entry) => entry.id === activeNavigation.discussionId,
    );
    if (!discussion || discussion.hidden) return;
    const file = files.find(
      (entry) =>
        entry.filePath === activeNavigation.path && !entry.fileDiff.cacheKey?.endsWith(":pending"),
    );
    if (!file) return;
    const range = projectDiscussionAnchor(file.fileDiff, discussion.anchor, comparison);
    if (!range) return;
    navigated.current = activeNavigation;
    onGoToDiscussion?.(file.fileKey, range, discussion.id);
  }, [activeNavigation, comparison, discussionController?.discussions, files, onGoToDiscussion]);
  const goToDiscussion = (discussion: ReviewDiscussion) => {
    const path = discussion.anchor.newPath ?? discussion.anchor.oldPath;
    if (!path) return;
    setNavigation({ discussionId: discussion.id, path, scope: navigationScope });
    onLoadDiscussionFile?.(path);
  };
  const items: CodeViewDiffItem<DiffCommentAnnotationGroup>[] = files.map(
    ({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
      const persisted = reviewComments
        .filter(
          (comment) =>
            comment.sectionId === sectionId &&
            comment.filePath === filePath &&
            (comment.fenceLanguage ?? "diff") === "diff",
        )
        .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
          const range = restoreDiffReviewCommentRange(fileDiff, comment);
          if (!range) return annotations;
          return appendAnnotationEntry(annotations, range, {
            id: comment.id,
            kind: "comment",
            range,
            rangeLabel: comment.rangeLabel,
            text: comment.text,
          });
        }, []);
      let annotations = persisted;
      for (const discussion of discussionController?.discussions ?? []) {
        if (discussion.hidden || !comparison) continue;
        const range = projectDiscussionAnchor(fileDiff, discussion.anchor, comparison);
        if (!range) continue;
        annotations = appendAnnotationEntry(annotations, range, {
          id: discussion.id,
          kind: "comment",
          range,
          rangeLabel: `${range.start}–${range.end}`,
          text: "",
          discussion,
        });
      }
      if (draftIsCurrent && draft?.fileKey === fileKey)
        annotations = [...annotations, draft.annotation];
      return {
        id: fileKey,
        type: "diff",
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(
          `${fileVersion}:${collapsed ? "1" : "0"}:${annotations
            .flatMap((annotation) =>
              annotation.metadata.entries.map(
                (entry) =>
                  `${entry.id}:${entry.rangeLabel}:${entry.text}:${JSON.stringify(entry.discussion)}`,
              ),
            )
            .join(":")}`,
        ),
      };
    },
  );

  const removeEntry = (entryId: string) => {
    if (posting || attemptedPost) return;
    setSelectedLines(null);
    if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setDraft(null);
      setDraftText("");
    } else {
      removeReviewComment(composerDraftTarget, entryId);
    }
  };

  const submitEntry = (entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
    if (!entry || !draft || attemptedPost || posting) return;
    addReviewComment(composerDraftTarget, { ...draft.comment, text: text.trim() });
    setSelectedLines(null);
    setDraft(null);
    setDraftText("");
  };

  const postEntry = async (entryId: string, text: string) => {
    if (
      !draft?.anchor ||
      !discussionController?.allowed ||
      posting ||
      typeof composerDraftTarget === "string"
    )
      return;
    const input = attemptedPost ?? {
      type: "create",
      threadId: composerDraftTarget.threadId,
      id: entryId,
      messageId: randomUUID(),
      text,
      anchor: draft.anchor,
    };
    if (!isDiscussionMutation(input)) {
      setValidationError(
        "Use at most 16,384 characters and a selection of up to 500 lines / 32,768 characters, or add it to chat.",
      );
      return;
    }
    setValidationError(null);
    setAttemptedPost(input);
    setPosting(true);
    await discussionController.mutate(input);
    setPosting(false);
  };

  const beginComment = (range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range) return;
    const item = context.item;
    if (item.type !== "diff") return;
    // Read from the item, not the file list, so the compiled callback keeps its identity
    // as patches arrive; the viewer re-applies its options whenever it changes.
    const id = nextFileCommentId();
    const filePath = resolveFileDiffPath(item.fileDiff);
    const comment = buildDiffReviewComment({
      id,
      sectionId,
      sectionTitle,
      filePath,
      fileDiff: item.fileDiff,
      range,
      text: "",
    });
    if (!comment) return;
    setDraftText("");
    setValidationError(null);
    setDraft({
      comment,
      anchor: comparison ? createDiscussionAnchor(item.fileDiff, comment, comparison) : null,
      comparison,
      fileKey: item.id,
      filePath,
      previousFilePath: resolveFileDiffPreviousPath(item.fileDiff),
      annotation: {
        side: annotationSide(range),
        lineNumber: range.end,
        metadata: {
          entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
        },
      },
    });
  };

  const renderCommentEntry = (entry: DiffCommentAnnotationEntry) => (
    <DiffCommentAnnotation
      key={entry.id}
      kind={entry.kind}
      rangeLabel={entry.rangeLabel}
      text={entry.kind === "draft" ? (attemptedPost?.text ?? draftText) : entry.text}
      onTextChange={(text) => {
        setDraftText(text);
        setValidationError(null);
      }}
      validationError={entry.kind === "draft" ? validationError : null}
      onCancel={() => removeEntry(entry.id)}
      pending={posting}
      awaitingConfirmation={entry.kind === "draft" && attemptedPost !== null}
      {...(entry.kind === "draft" && discussionController
        ? {
            submitLabel: attemptedPost ? "Retry post" : "Ask agent",
            disabled: !discussionController.allowed || !draft?.anchor,
            secondaryAction: {
              label: "Add to chat",
              onAction: (text: string) => submitEntry(entry.id, text),
            },
            placeholder: draft?.anchor
              ? "Ask about this selection…"
              : "Select up to 500 lines on one side, or add this question to chat…",
          }
        : {})}
      onComment={(text) =>
        discussionController ? void postEntry(entry.id, text) : submitEntry(entry.id, text)
      }
      onDelete={() => removeEntry(entry.id)}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {discussionController ? (
        <DiffDiscussionHistory
          controller={discussionController}
          entries={discussionEntries}
          {...(activeNavigation ? { navigatingId: activeNavigation.discussionId } : {})}
          {...(onGoToDiscussion ? { onGo: goToDiscussion } : {})}
        />
      ) : null}
      {draft && (draftFile || attemptedPost) && !draftIsCurrent ? (
        <div className="shrink-0 border-b border-border/30">
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            Selection changed — question uses saved context
          </p>
          <pre className="px-3 text-xs whitespace-pre-wrap">{draft.comment.diff}</pre>
          {draft.annotation.metadata.entries.map(renderCommentEntry)}
        </div>
      ) : null}
      <StyledDiffCodeView<DiffCommentAnnotationGroup>
        key={codeViewKey}
        {...(viewerRef ? { viewerRef } : {})}
        {...(className ? { className } : {})}
        {...(unsafeCSSExtra ? { unsafeCSSExtra } : {})}
        {...(renderHeaderMetadata
          ? {
              renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) =>
                item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null,
            }
          : {})}
        {...(renderCodeViewFooter ? { renderCodeViewFooter } : {})}
        items={items}
        selectedLines={selectedLines}
        onSelectedLinesChange={setSelectedLines}
        onRevealSearchMatch={(item) => onRevealSearchMatch(item.id)}
        options={{
          ...options,
          enableGutterUtility: draft === null && !posting,
          enableLineSelection: draft === null && !posting,
          onGutterUtilityClick: beginComment,
        }}
        renderHeaderFilenameSuffix={(item) =>
          item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
        }
        renderHeaderPrefix={(item) =>
          item.type === "diff"
            ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
            : null
        }
        renderAnnotation={(annotation) => {
          const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
          return (
            <div
              className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
            >
              {annotation.metadata.entries.map((entry) =>
                entry.discussion && discussionController ? (
                  <DiffDiscussionAnnotation
                    key={entry.id}
                    discussion={entry.discussion}
                    controller={discussionController}
                  />
                ) : (
                  renderCommentEntry(entry)
                ),
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
