// Shared UI state + cross-module handler registry (avoids import cycles).
import type { ToolView } from '../../core/types.js';

/** Columns the shelf can be ordered by. Favorites pin above the sort, always. */
export type SortKey = 'name' | 'state' | 'version' | 'upstream' | 'seen';

/** 1 = ascending, -1 = descending. */
export type SortDir = 1 | -1;

/** What the shelf is doing right now. Each phase gets its own empty-state copy —
 *  "still loading", "fetch failed" and "you own nothing yet" are three different
 *  facts and must never share one generic row. */
export type LoadPhase = 'loading' | 'ready' | 'error';

export const state = {
  tools: [] as ToolView[],
  /** Active filter pill: 'all' | 'fav' | 'upd' | 'never' | 'sys' | 'apps' | 'repo' | 'tag:<name>'. */
  filter: 'all',
  /** Free-text box beside the pills. Matched against name / note / tags. */
  query: '',
  sortKey: 'name' as SortKey,
  sortDir: 1 as SortDir,
  /** Row whose detail panel is open (at most one). */
  selectedId: null as number | null,
  /** Bulk-selection set — independent of selectedId, survives re-renders. */
  selected: new Set<number>(),
  /** Keyboard row cursor (j/k). null until the first key press. */
  cursorId: null as number | null,
  loading: true,
  phase: 'loading' as LoadPhase,
  /** Message from the last failed load; drives the error row + Retry button. */
  loadError: null as string | null,
};

export const handlers: {
  /** Reload tool list from the server and re-render everything. */
  reload?: () => Promise<void>;
  /** Select a row and open its detail panel. */
  select?: (id: number) => void;
  closeDetail?: () => void;
  /** Apply a filter pill value ('all' | 'fav' | 'upd' | 'never' | 'sys' | 'tag:<name>'). */
  setFilter?: (fq: string) => void;
  /** Trigger a full server refresh (POST /api/refresh) + reload. */
  refresh?: () => Promise<void>;
  /** Focus the add bar. */
  focusAdd?: () => void;
} = {};
