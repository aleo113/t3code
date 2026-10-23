import type { SelectionSide } from "@pierre/diffs";

export interface DiffPanelViewport {
  scrollTop: number;
  requestedFilePaths: string[];
  anchor?: {
    filePath: string;
    lineNumber?: number;
    side?: SelectionSide;
    offset: number;
  };
}
