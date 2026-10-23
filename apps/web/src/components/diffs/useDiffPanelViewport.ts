import { useCallback, useEffect, useMemo } from "react";
import { useDiffPanelSessionStore, type DiffPanelSelection } from "~/diffPanelStore";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import type { AnnotatableCodeViewHandle } from "./AnnotatableCodeView";
import type { DiffPanelViewport } from "./diffPanelViewport";

type Viewer = NonNullable<ReturnType<AnnotatableCodeViewHandle["getInstance"]>>;

interface ViewportOptions {
  scope: string;
  viewer: AnnotatableCodeViewHandle | null;
  visible: boolean;
  loading: boolean;
  selection: DiffPanelSelection;
  files: ReadonlyArray<{ filePath: string; fileKey: string; collapsed: boolean }>;
  requestedFilePaths: string[];
  fileStates: ReadonlyMap<string, { error: boolean; pending: boolean }>;
  requestPaths: (paths: ReadonlyArray<string>) => void;
}

// The lifetime is the logical comparison, not the patch generation or React handle.
// Every callback closes over its own session so a retiring viewer cannot save into
// the next thread/comparison. Capture while mounted; Pierre is already cleaned at ref(null).
export function useDiffPanelViewport(options: ViewportOptions) {
  const session = useMemo(() => ({
    pending: useDiffPanelSessionStore.getState().viewportByScopeKey[options.scope] ?? null,
    element: null as HTMLDivElement | null,
    options,
    frame: 0,
    captureFrame: 0,
    attempts: 0,
    stableFrames: 0,
    disposed: false,
  }), [options.scope]);
  session.options = options;

  const cancel = useCallback(() => {
    session.pending = null;
    cancelAnimationFrame(session.frame);
    const selection = session.options.selection;
    if (selection.kind === "turn" && selection.filePath) {
      useDiffPanelSessionStore.getState().consumedTurnFileSelections.add(selection);
    }
  }, [session]);

  const capture = useCallback((scrollTop: number, viewer: Viewer, geometry: boolean) => {
    const current = session.options;
    const element = session.element;
    if (session.disposed || session.pending || !current.visible || current.loading ||
      !element?.isConnected || element.clientHeight === 0 ||
      viewer !== current.viewer?.getInstance()) return;
    const snapshot: DiffPanelViewport = {
      scrollTop,
      requestedFilePaths: current.requestedFilePaths,
    };
    if (geometry) {
      const bounds = element.getBoundingClientRect();
      for (const rendered of viewer.getRenderedItems()) {
        if (rendered.type !== "diff" || rendered.item.fileDiff.cacheKey?.endsWith(":pending")) continue;
        const top = viewer.getTopForItem(rendered.id);
        const rect = rendered.element.getBoundingClientRect();
        if (top === undefined || rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
        const filePath = resolveFileDiffPath(rendered.item.fileDiff);
        const line = rendered.instance.getNumericScrollAnchor(Math.max(0, scrollTop - top));
        const position = line && rendered.instance.getLinePosition(line.lineNumber, line.side);
        // onScroll precedes render. Only accept a line whose current geometry
        // actually intersects this viewport; a fast jump otherwise keeps numbers only.
        const visibleLine = line && Array.from(rendered.element.shadowRoot?.querySelectorAll<HTMLElement>(`[data-line="${line.lineNumber}"]`) ?? [])
          .some((node) => {
            const rect = node.getBoundingClientRect();
            return rect.height > 0 && rect.top >= bounds.top && rect.top < bounds.bottom;
          });
        if (visibleLine && line && position && top + position.top >= scrollTop &&
          top + position.top < scrollTop + element.clientHeight) {
          snapshot.anchor = { filePath, lineNumber: line.lineNumber, side: line.side ?? "additions",
            offset: scrollTop - top - position.top };
        } else if (top >= scrollTop && top < scrollTop + element.clientHeight) {
          snapshot.anchor = { filePath, offset: scrollTop - top };
        }
        break;
      }
    }
    useDiffPanelSessionStore.getState().saveViewport(current.scope, snapshot);
  }, [session]);

  const onScroll = useCallback((scrollTop: number, viewer: Viewer) => {
    capture(scrollTop, viewer, false);
    cancelAnimationFrame(session.captureFrame);
    session.captureFrame = requestAnimationFrame(() => {
      capture(viewer.getScrollTop(), viewer, true);
    });
  }, [capture, session]);

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    session.element = element;
  }, [session]);

  useEffect(() => {
    session.disposed = false;
    return () => {
      session.disposed = true;
      cancelAnimationFrame(session.frame);
      cancelAnimationFrame(session.captureFrame);
    };
  }, [session]);

  useEffect(() => {
    const element = session.element;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancel();
    };
    element.addEventListener("wheel", cancel, { passive: true });
    element.addEventListener("touchstart", cancel, { passive: true });
    element.addEventListener("pointerdown", cancel);
    element.addEventListener("keydown", onKey);
    return () => {
      element.removeEventListener("wheel", cancel);
      element.removeEventListener("touchstart", cancel);
      element.removeEventListener("pointerdown", cancel);
      element.removeEventListener("keydown", onKey);
    };
  }, [options.viewer, session, cancel]);

  useEffect(() => {
    cancelAnimationFrame(session.frame);
    const snapshot = session.pending;
    const viewer = options.viewer?.getInstance();
    if (!snapshot || !viewer || !options.visible || options.loading) return;
    if (options.selection.kind === "turn" && options.selection.filePath &&
      !useDiffPanelSessionStore.getState().consumedTurnFileSelections.has(options.selection)) {
      session.pending = null;
      return;
    }
    const anchorIndex = options.files.findIndex((file) => file.filePath === snapshot.anchor?.filePath);
    const needed = [...new Set([
      ...snapshot.requestedFilePaths,
      ...options.files.slice(0, anchorIndex + 1).filter((file) => !file.collapsed).map((file) => file.filePath),
      ...(snapshot.anchor ? [snapshot.anchor.filePath] : []),
    ])];
    options.requestPaths(needed);
    if (needed.some((path) => options.fileStates.get(path)?.error)) {
      session.pending = null;
      return;
    }
    // Network has no frame deadline. The retry budget starts only with real patches.
    if (needed.some((path) => options.fileStates.get(path)?.pending)) return;
    const restore = () => {
      if (!session.pending || session.disposed || !session.element?.clientHeight) return;
      if (++session.attempts > 120) { session.pending = null; return; }
      let target = snapshot.scrollTop;
      const file = options.files.find((file) => file.filePath === snapshot.anchor?.filePath);
      if (file && snapshot.anchor) {
        const top = viewer.getTopForItem(file.fileKey);
        if (top === undefined) { session.frame = requestAnimationFrame(restore); return; }
        target = top + snapshot.anchor.offset;
        if (snapshot.anchor.lineNumber !== undefined && !file.collapsed) {
          const rendered = viewer.getRenderedItems().find((item) => item.id === file.fileKey);
          if (!rendered || rendered.type !== "diff") {
            viewer.scrollTo({ type: "item", id: file.fileKey, align: "start" });
            session.frame = requestAnimationFrame(restore);
            return;
          }
          if (snapshot.anchor.side !== "deletions") rendered.instance.revealLine(snapshot.anchor.lineNumber);
          const position = rendered.instance.getLinePosition(snapshot.anchor.lineNumber, snapshot.anchor.side);
          if (position) target += position.top;
          else target = snapshot.scrollTop;
        }
      }
      target = Math.max(0, target);
      if (Math.abs(viewer.getScrollTop() - target) < 1) session.stableFrames++;
      else session.stableFrames = 0;
      // Pierre's public position target subtracts the sticky header, including
      // numeric targets. Compensate using the mounted header's actual height.
      const headerHeight = viewer.getRenderedItems()[0]?.element.shadowRoot
        ?.querySelector("[data-diffs-header]")?.getBoundingClientRect().height ?? 0;
      viewer.scrollTo({ type: "position", position: target + headerHeight });
      if (session.stableFrames >= 3) {
        session.pending = null;
        capture(viewer.getScrollTop(), viewer, true);
        return;
      }
      session.frame = requestAnimationFrame(restore);
    };
    session.frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(session.frame);
  });

  return { cancel, containerRef, onScroll };
}
