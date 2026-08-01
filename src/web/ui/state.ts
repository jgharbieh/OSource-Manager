// Shared UI state + cross-module handler registry (avoids import cycles).
import type { ToolView } from '../../core/types.js';

export const state = {
  tools: [] as ToolView[],
  filter: 'all',
  selectedId: null as number | null,
  loading: true,
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
