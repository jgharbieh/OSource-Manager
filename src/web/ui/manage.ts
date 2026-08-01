// Manage view: funnel strip, filter pills + inline filter box, the shelf table
// (sortable columns, bulk selection, keyboard cursor), add bar, refresh stamp.
import {
  addTag as apiAddTag,
  listTools,
  patchTool,
  refreshAll,
  refreshUpstream,
  removeTag as apiRemoveTag,
  retireTool,
  searchTools,
  trackTool,
} from './api.js';
import { registerFlow, retireFlow, tearDownFlow, tryFlow, unregisterFlow, updateFlow } from './actions.js';
import { state, handlers } from './state.js';
import type { SortDir, SortKey } from './state.js';
import { $, esc, errToast, fmtRel, fmtStamp, repoWebUrl, toast } from './util.js';
import type { Installation, Tag, ToolView } from '../../core/types.js';

/** querySelector that tolerates a not-yet-built node (unlike $, which throws). */
function qs(sel: string): HTMLElement | null {
  const el = document.querySelector(sel);
  return el instanceof HTMLElement ? el : null;
}

/* ---------- derived helpers ---------- */

export function stateChips(t: ToolView): Array<{ label: string; cls: string }> {
  const chips: Array<{ label: string; cls: string }> = [];
  const v = t.verdict;
  chips.push({
    label: v,
    cls: v === 'kept' ? 'c-ok' : v === 'trying' ? 'c-blue' : v === 'retired' ? 'c-crit' : 'c-mut',
  });
  const o = t.observations;
  if (o && o.serving_count > 0) chips.push({ label: `serving ×${o.serving_count}`, cls: 'c-acc' });
  if (o && o.trial_running) chips.push({ label: 'trial', cls: 'c-blue' });
  if (o && o.update_available) chips.push({ label: 'update', cls: 'c-warn' });
  return chips;
}

function localVersion(t: ToolView): string {
  for (const inst of t.installations) {
    if (inst.version_local) return inst.version_local;
  }
  return t.installations.length ? 'local' : '—';
}

function lastSeen(t: ToolView): string | null {
  let best: string | null = null;
  for (const inst of t.installations) {
    if (inst.last_seen_at && (!best || inst.last_seen_at > best)) best = inst.last_seen_at;
  }
  return best;
}

function copyablePath(t: ToolView): string | null {
  const disk = t.installations.find((i: Installation) => i.where_.includes(':') || i.where_.startsWith('/'));
  return (disk ?? t.installations[0])?.where_ ?? null;
}

/**
 * "No evidence of use" needs comment/trial counts that ToolView doesn't carry,
 * so the exact set comes from GET /api/search?noEvidenceOfUse=1 (fetched lazily).
 * The local approximation below only backs the pill count before the first fetch.
 */
let neverIds: Set<number> | null = null;

async function ensureNeverIds(): Promise<void> {
  const rows = await searchTools({ noEvidenceOfUse: '1' });
  neverIds = new Set(rows.map((r) => r.id));
}

/** Local approximation: not retired, nothing serving, never touched since first discovery. */
function noEvidence(t: ToolView): boolean {
  if (t.verdict === 'retired') return false;
  if (t.observations && t.observations.serving_count > 0) return false;
  return t.updated_at === t.added_at;
}

function hasUpdate(t: ToolView): boolean {
  return t.observations?.update_available === 1;
}

/** OS/vendor noise auto-tagged by the winget scanner (detected=1). */
function isSystem(t: ToolView): boolean {
  return t.tags.some((x: Tag) => x.tag === 'system');
}

/** Anything winget reports. Kept — some deps are winget-only — but off by
 *  default: winget answers "what is installed on this Windows box", which is a
 *  different question from "what did I acquire and am I still using it". */
function isWinget(t: ToolView): boolean {
  return (t.installations ?? []).some((i) => i.where_ === 'winget') || t.source === 'winget';
}

/** Rows the default view hides. The 'apps' and 'system' pills bring them back. */
function isNoiseByDefault(t: ToolView): boolean {
  return isSystem(t) || isWinget(t);
}

export function matchFilter(t: ToolView, fq: string): boolean {
  if (!fq || fq === 'all') return true;
  if (fq === 'fav') return t.favorite === 1;
  if (fq === 'upd') return hasUpdate(t);
  if (fq === 'sys') return isSystem(t);
  if (fq === 'apps') return isWinget(t);
  if (fq === 'repo') return t.kind === 'repo';
  if (fq === 'never') return neverIds ? neverIds.has(t.id) : noEvidence(t);
  if (fq.startsWith('tag:')) return t.tags.some((x: Tag) => x.tag === fq.slice(4));
  return true;
}

/** Human label for a filter value — used in the "nothing matched" copy. */
function pillLabel(fq: string): string {
  const known: Record<string, string> = {
    all: 'All',
    repo: 'repos',
    fav: '★ Favorites',
    never: 'no evidence',
    upd: 'has update',
    apps: 'apps (winget)',
    sys: 'system',
  };
  return known[fq] ?? (fq.startsWith('tag:') ? fq.slice(4) : fq);
}

function tagClass(tag: Tag): string {
  if (tag.detected === 0) return 't-cust';
  const known: Record<string, string> = { mcp: 't-mcp', skill: 't-skill', app: 't-app', api: 't-api', mine: 't-mine' };
  return known[tag.tag] ?? 't-cust';
}

/* ---------- inline text filter ---------- */

/** Every space-separated term must appear somewhere in the row's text. */
function queryTerms(): string[] {
  const q = state.query.trim().toLowerCase();
  return q ? q.split(/\s+/) : [];
}

/** Searched surface = everything the row actually shows: its name, the note or
 *  source under it, and its tags. The canonical key rides along because that is
 *  what the ↗ link points at and how most tools are remembered. */
function haystack(t: ToolView): string {
  return [t.name, t.why_i_want_it ?? '', t.source ?? '', t.kind, t.canonical_key, t.tags.map((x) => x.tag).join(' ')]
    .join(' ')
    .toLowerCase();
}

function matchQuery(t: ToolView, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const h = haystack(t);
  return terms.every((term) => h.includes(term));
}

/* ---------- sorting ---------- */

interface Col {
  key: SortKey | null;
  label: string;
  right?: boolean;
  /** Direction a first click on this column applies. Dates and versions read
   *  newest-first; text reads A→Z. */
  defDir?: SortDir;
}

const COLS: Col[] = [
  { key: null, label: '' }, // bulk checkbox
  { key: 'name', label: 'Tool', defDir: 1 },
  { key: null, label: 'Links' },
  { key: 'state', label: 'State', defDir: 1 },
  { key: 'version', label: 'Version', defDir: -1 },
  { key: 'upstream', label: 'Upstream', defDir: -1 },
  { key: 'seen', label: 'Last seen', defDir: -1 },
  { key: null, label: 'Do', right: true },
];

/** Column count — every colspan and the detail panel's holder cell key off this. */
const NCOLS = COLS.length;

const VERDICT_RANK: Record<string, number> = { wanted: 0, trying: 1, kept: 2, retired: 3 };

/** Sort value as a string; '' means "blank", which always sinks to the bottom. */
function sortValue(t: ToolView, key: SortKey): string {
  if (key === 'name') return t.name;
  if (key === 'state') return String(VERDICT_RANK[t.verdict] ?? 9);
  if (key === 'version') {
    const v = localVersion(t);
    return v === '—' ? '' : v;
  }
  if (key === 'upstream') return t.observations?.version_upstream ?? '';
  return lastSeen(t) ?? '';
}

/** Natural compare: '1.10.0' sorts after '1.9.0', unlike a plain string compare. */
function cmpNat(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function sortRows(rows: ToolView[]): ToolView[] {
  const { sortKey, sortDir } = state;
  return rows.sort((a, b) => {
    // Favorites pin above the sort, in every column and both directions.
    if (a.favorite !== b.favorite) return b.favorite - a.favorite;
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const ablank = av === '';
    const bblank = bv === '';
    // Blanks last regardless of direction — reversing a column should not
    // bury every real value under a wall of '—'.
    if (ablank !== bblank) return ablank ? 1 : -1;
    if (!ablank) {
      const c = cmpNat(av, bv);
      if (c !== 0) return c * sortDir;
    }
    return cmpNat(a.name, b.name);
  });
}

function setSort(key: SortKey): void {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 1 ? -1 : 1;
  } else {
    state.sortKey = key;
    state.sortDir = COLS.find((c) => c.key === key)?.defDir ?? 1;
  }
  renderRows();
}

/* ---------- funnel ---------- */

function renderFunnel(): void {
  const tools = state.tools;
  const count = (fn: (t: ToolView) => boolean): number => tools.filter(fn).length;
  const set = (id: string, n: number): void => {
    const el = $('#' + id);
    el.textContent = String(n);
    el.classList.toggle('zero', n === 0);
  };
  set('fn-wanted', count((t) => t.verdict === 'wanted'));
  set('fn-trying', count((t) => t.verdict === 'trying'));
  set('fn-kept', count((t) => t.verdict === 'kept'));
  set('fn-serving', count((t) => (t.observations?.serving_count ?? 0) > 0));
  set('fn-retired', count((t) => t.verdict === 'retired'));
}

/* ---------- filter bar ---------- */

/** The filter bar is built once so the text input keeps focus and caret across
 *  re-renders; renderPills() only ever rewrites the #pills span inside it. */
function buildFilterBar(): void {
  const fbar = qs('#fbar');
  if (!fbar) return;
  fbar.innerHTML = `<span class="lbl">filters</span><span class="pills" id="pills"></span>
    <span class="spacer"></span>
    <span class="qwrap">
      <input class="fld qfld" id="qfilter" placeholder="filter name, note, tag…" spellcheck="false" autocomplete="off" aria-label="Filter the shelf">
      <button class="qx hidden" id="qclear" title="Clear (esc)" aria-label="Clear filter">✕</button>
    </span>
    <span class="qcount" id="qcount"></span>
    <button class="btn gho" id="palbtn"><kbd>Ctrl</kbd><kbd>K</kbd> search</button>`;
}

export function renderPills(): void {
  const tools = state.tools;
  const tagCounts = new Map<string, number>();
  for (const t of tools) {
    for (const tag of t.tags) tagCounts.set(tag.tag, (tagCounts.get(tag.tag) ?? 0) + 1);
  }
  const pills: Array<{ fq: string; label: string; count: number; dim: boolean }> = [
    { fq: 'all', label: 'All', count: tools.filter((t) => !isNoiseByDefault(t)).length, dim: false },
    { fq: 'repo', label: 'repos', count: tools.filter((t) => t.kind === 'repo').length, dim: false },
    { fq: 'fav', label: '★ Favorites', count: tools.filter((t) => t.favorite === 1).length, dim: false },
  ];
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // 'system' gets a dedicated dim pill (fq 'sys') instead of the generic tag pill.
  const tagPills = tags
    .filter(([name]) => name !== 'system')
    .map(([name, count]) => ({ fq: `tag:${name}`, label: name, count, dim: false }));
  const tail = [
    { fq: 'never', label: 'no evidence', count: neverIds ? neverIds.size : tools.filter(noEvidence).length, dim: true },
    { fq: 'upd', label: 'has update', count: tools.filter(hasUpdate).length, dim: true },
    { fq: 'apps', label: 'apps (winget)', count: tools.filter(isWinget).length, dim: true },
    { fq: 'sys', label: 'system', count: tools.filter(isSystem).length, dim: true },
  ];
  const all = [...pills, null, ...tagPills, null, ...tail];
  const html = all
    .map((p) => {
      if (p === null) return '<span class="vsep"></span>';
      return `<button class="pil${p.dim ? ' dim' : ''}${state.filter === p.fq ? ' on' : ''}" data-fq="${esc(p.fq)}">${esc(p.label)} <em>${p.count}</em></button>`;
    })
    .join('');
  const pillHost = qs('#pills');
  if (pillHost) pillHost.innerHTML = html;
}

/* ---------- table head ---------- */

function headRow(): HTMLElement | null {
  const table = document.querySelector('#rows')?.closest('table') ?? null;
  const tr = table?.querySelector('thead tr') ?? null;
  return tr instanceof HTMLElement ? tr : null;
}

/** Header markup is owned here (not in index.html) because the bulk-select
 *  column and the sort buttons have to stay in lockstep with COLS. */
function buildHead(): void {
  const tr = headRow();
  if (!tr) return;
  tr.innerHTML = COLS.map((c, i) => {
    if (c.key === null) {
      if (i === 0) {
        return `<th class="selth"><input type="checkbox" id="selall" aria-label="Select all visible rows" title="Select every visible row"></th>`;
      }
      return `<th${c.right === true ? ' class="right"' : ''}>${esc(c.label)}</th>`;
    }
    return `<th class="sortth" data-col="${c.key}" aria-sort="none"><button class="sortbtn" data-sort="${c.key}" title="Sort by ${esc(c.label.toLowerCase())}">${esc(c.label)}<span class="sar"></span></button></th>`;
  }).join('');
}

function syncHead(): void {
  const tr = headRow();
  if (!tr) return;
  tr.querySelectorAll('th[data-col]').forEach((th) => {
    if (!(th instanceof HTMLElement)) return;
    const on = th.dataset.col === state.sortKey;
    th.setAttribute('aria-sort', on ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none');
    th.classList.toggle('on', on);
    const sar = th.querySelector('.sar');
    if (sar) sar.textContent = on ? (state.sortDir === 1 ? '▲' : '▼') : '';
  });
  const all = document.querySelector('#selall');
  if (all instanceof HTMLInputElement) {
    const n = visibleIds.filter((id) => state.selected.has(id)).length;
    all.checked = visibleIds.length > 0 && n === visibleIds.length;
    all.indeterminate = n > 0 && n < visibleIds.length;
    all.disabled = visibleIds.length === 0;
  }
}

/* ---------- bulk selection ---------- */

/** Ids of the rows currently rendered, in render order. Shift-click ranges and
 *  the j/k cursor both index into this. */
let visibleIds: number[] = [];
/** Last row clicked with a checkbox — the other end of a shift-click range. */
let anchorIdx = -1;
/** True while a bulk run is in flight; the bar's buttons go dead. */
let bulkBusy = false;

function selectedTools(): ToolView[] {
  const order = new Map<number, number>();
  visibleIds.forEach((id, i) => order.set(id, i));
  return state.tools
    .filter((t) => state.selected.has(t.id))
    .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || a.name.localeCompare(b.name));
}

function clearSelection(): void {
  if (state.selected.size === 0) return;
  state.selected.clear();
  anchorIdx = -1;
  renderRows();
}

function pruneSelection(): void {
  const live = new Set(state.tools.map((t) => t.id));
  for (const id of [...state.selected]) {
    if (!live.has(id)) state.selected.delete(id);
  }
  if (state.cursorId !== null && !live.has(state.cursorId)) state.cursorId = null;
}

function toggleSelect(id: number, shift: boolean, want: boolean, refocus = false): void {
  const idx = visibleIds.indexOf(id);
  if (shift && anchorIdx >= 0 && idx >= 0) {
    // Shift extends the range with the clicked row's new state, the way every
    // file list does it — the anchor is the previous checkbox interaction.
    const lo = Math.min(anchorIdx, idx);
    const hi = Math.max(anchorIdx, idx);
    for (let i = lo; i <= hi; i++) {
      if (want) state.selected.add(visibleIds[i]);
      else state.selected.delete(visibleIds[i]);
    }
  } else if (want) {
    state.selected.add(id);
  } else {
    state.selected.delete(id);
  }
  if (idx >= 0) anchorIdx = idx;
  state.cursorId = id;
  renderRows();
  // The tbody was just rewritten, so the checkbox that was clicked no longer
  // exists; give focus back to its replacement or tabbing dies mid-list.
  if (refocus) {
    const box = document.querySelector(`#rows tr[data-id="${id}"] input[data-sel]`);
    if (box instanceof HTMLInputElement) box.focus();
  }
}

function ensureBulkBar(): void {
  const tw = qs('#view-manage .tw');
  if (!tw || document.querySelector('#bulkbar')) return;
  const bb = document.createElement('div');
  bb.id = 'bulkbar';
  bb.className = 'bulkbar hidden';
  tw.parentElement?.insertBefore(bb, tw);
}

function renderBulk(): void {
  const bb = qs('#bulkbar');
  if (!bb) return;
  const n = state.selected.size;
  bb.classList.toggle('hidden', n === 0);
  if (n === 0) return;
  const hidden = n - visibleIds.filter((id) => state.selected.has(id)).length;
  const sel = selectedTools();
  const allFav = sel.length > 0 && sel.every((t) => t.favorite === 1);
  const dis = bulkBusy ? ' disabled' : '';
  bb.innerHTML = `<span class="bn">${n} selected</span>
    ${hidden > 0 ? `<span class="bhid">· ${hidden} hidden by the current filter (still included)</span>` : ''}
    <span class="spacer"></span>
    <button class="btn" data-bulk="tag"${dis}>Tag…</button>
    <button class="btn" data-bulk="untag"${dis}>Untag…</button>
    <button class="btn" data-bulk="fav"${dis}>${allFav ? '☆ Unfavorite' : '★ Favorite'}</button>
    <button class="btn danger" data-bulk="retire"${dis}>Retire…</button>
    <button class="btn gho" data-bulk="clear"${dis}>Clear</button>`;
}

/** Run a bulk op one row at a time, reporting progress as it goes. Sequential on
 *  purpose: every mutation writes a journal event server-side, and a failure
 *  halfway through must leave a legible trail rather than a race. */
async function bulkApply(
  verb: string,
  tools: ToolView[],
  fn: (t: ToolView) => Promise<void>,
  clearAfter = false,
): Promise<void> {
  const total = tools.length;
  if (total === 0) return;
  bulkBusy = true;
  renderBulk();
  let done = 0;
  const failed: string[] = [];
  for (const t of tools) {
    toast(`${verb} ${done + failed.length + 1}/${total} — ${t.name}`);
    try {
      await fn(t);
      done++;
    } catch (e) {
      failed.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  bulkBusy = false;
  if (clearAfter) {
    state.selected.clear();
    anchorIdx = -1;
  }
  toast(failed.length === 0 ? `${verb}: ${done}/${total} done` : `${verb}: ${done}/${total} done · ${failed.length} failed`);
  if (failed.length > 0) {
    window.alert(`${verb} — these did not go through:\n\n${failed.map((f) => `  • ${f}`).join('\n')}`);
  }
  await (handlers.reload?.() ?? loadTools());
}

async function bulkTag(): Promise<void> {
  const sel = selectedTools();
  const name = (window.prompt(`Add a tag to ${sel.length} selected tool(s):`) ?? '').trim();
  if (!name) return;
  const todo = sel.filter((t) => !t.tags.some((x) => x.tag === name));
  if (todo.length === 0) {
    toast(`every selected row already has "${name}"`);
    return;
  }
  await bulkApply(`tagging "${name}"`, todo, async (t) => {
    await apiAddTag(t.id, name);
  });
}

async function bulkUntag(): Promise<void> {
  const sel = selectedTools();
  const counts = new Map<string, number>();
  for (const t of sel) {
    for (const x of t.tags) counts.set(x.tag, (counts.get(x.tag) ?? 0) + 1);
  }
  if (counts.size === 0) {
    toast('none of the selected rows carries a tag');
    return;
  }
  const list = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, c]) => `  ${tag} (${c})`)
    .join('\n');
  const name = (window.prompt(`Remove which tag from ${sel.length} selected tool(s)?\n\ntags on the selection:\n${list}\n`) ?? '').trim();
  if (!name) return;
  const todo = sel.filter((t) => t.tags.some((x) => x.tag === name));
  if (todo.length === 0) {
    toast(`no selected row has "${name}"`);
    return;
  }
  if (!window.confirm(`Remove the tag "${name}" from ${todo.length} tool(s)?`)) return;
  await bulkApply(`untagging "${name}"`, todo, async (t) => {
    await apiRemoveTag(t.id, name);
  });
}

async function bulkFav(): Promise<void> {
  const sel = selectedTools();
  if (sel.length === 0) return;
  const next = !sel.every((t) => t.favorite === 1);
  const todo = sel.filter((t) => (t.favorite === 1) !== next);
  if (todo.length === 0) return;
  await bulkApply(next ? 'favoriting' : 'unfavoriting', todo, async (t) => {
    await patchTool(t.id, { favorite: next });
  });
}

async function bulkRetire(): Promise<void> {
  const sel = selectedTools().filter((t) => t.verdict !== 'retired');
  if (sel.length === 0) {
    toast('every selected row is already retired');
    return;
  }
  const reason = (window.prompt(`Retire ${sel.length} tool(s) — why? (required, kept forever, applied to all of them)`) ?? '').trim();
  if (!reason) {
    toast('Retire needs a reason — that is the whole point.');
    return;
  }
  const preview = sel.slice(0, 12).map((t) => `  • ${t.name}`).join('\n') + (sel.length > 12 ? `\n  … and ${sel.length - 12} more` : '');
  const serving = sel.filter((t) => (t.observations?.serving_count ?? 0) > 0).length;
  const lines = [
    `Retire ${sel.length} tool(s)?`,
    '',
    preview,
    '',
    `Reason: ${reason}`,
    '',
    'Rows and journals stay; the verdict becomes retired.',
    serving > 0 ? `${serving} of these are still registered as MCP servers — unregister those from the row menu afterwards.` : '',
  ].filter((l) => l !== '');
  if (!window.confirm(lines.join('\n'))) return;
  await bulkApply(
    'retiring',
    sel,
    async (t) => {
      await retireTool(t.id, reason);
      if (state.selectedId === t.id) state.selectedId = null;
    },
    // Retired rows stay on the shelf, so drop them from the selection here —
    // leaving them checked invites a second Retire… on the same rows.
    true,
  );
}

function runBulk(act: string): void {
  if (bulkBusy) return;
  if (act === 'clear') {
    clearSelection();
    return;
  }
  if (act === 'tag') void bulkTag();
  else if (act === 'untag') void bulkUntag();
  else if (act === 'fav') void bulkFav();
  else if (act === 'retire') void bulkRetire();
}

/* ---------- table body ---------- */

function rowHTML(t: ToolView): string {
  const fav = t.favorite === 1;
  const tags = t.tags
    .map((tag: Tag) => `<span class="tag ${tagClass(tag)}" data-rmtag="${esc(tag.tag)}" title="click to remove">${esc(tag.tag)}</span>`)
    .join('');
  const tagAdd = `<button class="tag-add" data-addtag title="add a tag">+</button>`;
  const web = repoWebUrl(t.canonical_key);
  const links = [
    web
      ? `<a class="lk" href="${esc(web)}" target="_blank" rel="noopener" title="Open repo ↗">↗</a>`
      : `<button class="lk" disabled title="no upstream repo">↗</button>`,
    `<button class="lk" data-lk="readme" title="README (detail tab)">▤</button>`,
    `<button class="lk" data-lk="copy" title="Copy path">⧉</button>`,
    `<button class="lk" data-lk="ide" title="Open in IDE — placeholder">◧</button>`,
  ].join('');
  const chips = stateChips(t)
    .map((c) => `<span class="chip ${c.cls}">${esc(c.label)}</span>`)
    .join('');
  const up = t.observations?.version_upstream ?? '—';
  const upNew = hasUpdate(t);
  const seen = lastSeen(t);
  const sub = t.why_i_want_it ? esc(t.why_i_want_it) : esc(t.source ? `via ${t.source}` : t.kind);
  const picked = state.selected.has(t.id);
  const cls = [state.selectedId === t.id ? 'sel' : '', picked ? 'picked' : '', state.cursorId === t.id ? 'cur' : '']
    .filter(Boolean)
    .join(' ');
  return `<tr data-id="${t.id}"${cls ? ` class="${cls}"` : ''}>
    <td class="selcell"><input type="checkbox" data-sel${picked ? ' checked' : ''} aria-label="Select ${esc(t.name)}"></td>
    <td><span class="nm"><button class="fav${fav ? ' on' : ''}" data-fav aria-label="Favorite" aria-pressed="${fav}">${fav ? '★' : '☆'}</button>${esc(t.name)}<span class="tags">${tags}${tagAdd}</span><span class="sub">${sub}</span></span></td>
    <td><span class="linkrow">${links}</span></td>
    <td><span class="statecell">${chips}</span></td>
    <td class="m">${esc(localVersion(t))}</td>
    <td class="m${upNew ? ' new' : ''}">${esc(up)}${upNew ? ' ↑' : ''}</td>
    <td class="m${seen ? '' : ' never'}">${seen ? fmtRel(seen) : '—'}</td>
    <td class="right"><span class="rowacts"><span class="menu"><button class="dd" data-menu>Actions ▾</button></span></span></td></tr>`;
}

function msgRow(cls: string, html: string): string {
  return `<tr class="msgrow"><td colspan="${NCOLS}" class="rowmsg ${cls}">${html}</td></tr>`;
}

/** Loading / failed / nothing-tracked / nothing-matched are four different
 *  facts. Each gets its own copy and its own way out. */
function emptyRow(): string {
  if (state.phase === 'loading') {
    return msgRow('load', `<span class="spin" aria-hidden="true"></span><b>Reading the shelf…</b><span class="sub2">Pulling tools, installations and observations from the local database.</span>`);
  }
  if (state.phase === 'error') {
    return msgRow(
      'err',
      `<b>Could not load the shelf.</b><span class="sub2">${esc(state.loadError ?? 'unknown error')}</span><button class="btn" data-retry>Retry</button>`,
    );
  }
  if (state.tools.length === 0) {
    return msgRow(
      'empty',
      `<b>Nothing tracked yet.</b><span class="sub2">Paste a repo URL in the <b>Add</b> bar above and hit <b>Track</b> — or hit <b>↻</b> to scan this machine and import what is already here.</span>`,
    );
  }
  const q = state.query.trim();
  const filtered = state.filter !== 'all' || q !== '';
  if (filtered) {
    const parts = [q ? `“${esc(q)}”` : '', state.filter !== 'all' ? `the <b>${esc(pillLabel(state.filter))}</b> filter` : ''].filter(Boolean);
    return msgRow(
      'nomatch',
      `<b>No rows match ${parts.join(' + ')}.</b><span class="sub2">${state.tools.length} tool(s) on the shelf.</span><button class="btn" data-clearfilters>Clear ${q && state.filter !== 'all' ? 'filter + text' : q ? 'text' : 'filter'}</button>`,
    );
  }
  // 'all', no text, still nothing: everything discovered is default-hidden noise.
  return msgRow(
    'empty',
    `<b>Everything found is winget/system noise.</b><span class="sub2">The <b>apps (winget)</b> and <b>system</b> pills bring those ${state.tools.length} row(s) back.</span>`,
  );
}

/** Shown when the text filter matches rows the default view hides — otherwise
 *  searching for a winget app looks like the shelf simply does not have it. */
function hiddenHintRow(): string {
  const terms = queryTerms();
  if (terms.length === 0 || state.filter !== 'all') return '';
  const n = state.tools.filter((t) => isNoiseByDefault(t) && matchQuery(t, terms)).length;
  if (n === 0) return '';
  return `<tr class="hintrow"><td colspan="${NCOLS}">${n} more match “${esc(state.query.trim())}” among the rows hidden by default —
    <button class="pil dim" data-fq="apps">apps (winget)</button> <button class="pil dim" data-fq="sys">system</button></td></tr>`;
}

/** Stale-data banner: a failed reload keeps the last good rows on screen, so
 *  say so out loud instead of pretending the table is current. */
function errorBannerRow(): string {
  if (state.phase !== 'error') return '';
  return `<tr class="hintrow err"><td colspan="${NCOLS}"><b>Last load failed:</b> ${esc(state.loadError ?? '')} — these rows are the last good data. <button class="btn" data-retry>Retry</button></td></tr>`;
}

function visibleTools(): ToolView[] {
  // The default ('all') view hides OS/vendor noise tagged 'system'; the
  // dedicated 'system' pill (fq 'sys') brings those rows back. Funnel and
  // pill counts stay honest — they always cover every row.
  const terms = queryTerms();
  const rows = state.tools.filter(
    (t) =>
      matchFilter(t, state.filter) &&
      (state.filter !== 'all' || !isNoiseByDefault(t)) &&
      matchQuery(t, terms),
  );
  return sortRows(rows);
}

/**
 * The ONLY place that writes #rows.
 *
 * parkDetail() is baked in on purpose: the detail panel is re-parented into a
 * <tr>, so any tbody write that skips the rescue deletes the element itself and
 * kills the detail view for the rest of the session. Making that impossible to
 * forget is worth one extra function.
 */
function writeRows(html: string): void {
  parkDetail();
  $('#rows').innerHTML = html;
}

export function renderRows(): void {
  const rows = visibleTools();
  visibleIds = rows.map((t) => t.id);
  if (state.cursorId !== null && !visibleIds.includes(state.cursorId)) state.cursorId = null;
  syncHead();
  renderBulk();
  const qc = qs('#qcount');
  if (qc) qc.textContent = state.query.trim() ? `${rows.length}/${state.tools.length}` : '';
  const qx = qs('#qclear');
  if (qx) qx.classList.toggle('hidden', state.query === '');
  // The hidden-match hint is appended in BOTH cases on purpose: "no rows match
  // microsoft" while 40 winget rows quietly match it is the exact moment the
  // user needs to be told the default view is hiding things.
  const body = rows.length > 0 ? errorBannerRow() + rows.map(rowHTML).join('') : emptyRow();
  writeRows(body + hiddenHintRow());
  mountDetail();
}

/** Cursor moves are class-only — no tbody rewrite, so holding j stays smooth. */
function paintCursor(): void {
  document.querySelectorAll('#rows tr[data-id]').forEach((tr) => {
    if (tr instanceof HTMLElement) tr.classList.toggle('cur', tr.dataset.id === String(state.cursorId));
  });
}

/** Where #det lives when it is not parented under a row. Captured once, because
 *  the panel's markup home in index.html is outside the table. */
let detHome: HTMLElement | null = null;

/** Move #det out of the table before anything rewrites #rows.
 *
 *  MUST be called before `$('#rows').innerHTML = …`. The panel is re-parented
 *  into a <tr>, so wiping the tbody would otherwise delete the element itself —
 *  after which no click can ever find it again and the whole detail view is
 *  dead for the rest of the session. */
function parkDetail(): void {
  const det = document.querySelector('#det');
  if (!det) return;
  if (!detHome) detHome = det.parentElement as HTMLElement | null;
  if (detHome && det.parentElement !== detHome) detHome.appendChild(det);
}

/** Re-parent the detail panel directly beneath its own row. Anchored at the
 *  bottom of the page it is unreachable once the shelf is a hundred rows long.
 *  The node is moved, not rebuilt, so every id and handler in detail.ts
 *  survives — which is also why parkDetail() has to run before each re-render. */
function mountDetail(): void {
  const det = document.querySelector('#det');
  if (!det) return;
  if (state.selectedId === null) {
    det.classList.add('hidden');
    return;
  }
  const tr = document.querySelector(`#rows tr[data-id="${state.selectedId}"]`);
  if (!tr) return; // selected row is filtered out — panel stays parked at home
  const holder = document.createElement('tr');
  holder.className = 'detrow';
  const td = document.createElement('td');
  td.colSpan = NCOLS;
  td.appendChild(det);
  holder.appendChild(td);
  tr.after(holder);
}

function renderStamp(): void {
  let best: string | null = null;
  for (const t of state.tools) {
    const c = t.observations?.upstream_checked_at;
    if (c && (!best || c > best)) best = c;
  }
  $('#stamp').textContent = best ? `refreshed ${fmtStamp(best)}` : 'never refreshed';
}

export function renderAll(): void {
  renderFunnel();
  renderPills();
  renderRows();
  renderStamp();
}

/* ---------- data loading ---------- */

export async function loadTools(): Promise<void> {
  state.loading = true;
  state.phase = 'loading';
  state.loadError = null;
  neverIds = null;
  renderRows(); // paints the loading row while the shelf is still empty
  try {
    state.tools = await listTools();
    state.phase = 'ready';
    if (state.selectedId !== null && !state.tools.some((t) => t.id === state.selectedId)) {
      state.selectedId = null;
    }
    if (state.filter === 'never') {
      try {
        await ensureNeverIds();
      } catch (e) {
        errToast(e);
      }
    }
  } catch (e) {
    state.phase = 'error';
    state.loadError = e instanceof Error ? e.message : String(e);
    errToast(e);
  }
  state.loading = false;
  pruneSelection();
  renderAll();
}

export async function refresh(): Promise<void> {
  const btn = $('#refresh') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const summary = await refreshAll();
    toast(summary);
  } catch (e) {
    errToast(e);
  }
  await loadTools();
  btn.disabled = false;
  // Phase 2: upstream checks ride along after the scan — non-blocking, and a
  // failure here must never take the scan report down with it.
  void (async () => {
    try {
      const r = await refreshUpstream(25);
      await loadTools(); // pick up fresh update badges
      const updates = state.tools.filter(hasUpdate).length;
      const rateLimited = r.errors.some((x) => /rate limit/i.test(x));
      toast(
        `upstream: checked ${r.checked} · ${updates} update(s) on the shelf` +
          (r.errors.length > 0 ? ` · ${r.errors.length} error(s)${rateLimited ? ' (rate-limited)' : ''}` : ''),
      );
    } catch (e) {
      errToast(e);
    }
  })();
}

/* ---------- interactions ---------- */

function toolFromRow(el: Element): ToolView | null {
  const tr = el.closest('tr');
  if (!tr || !(tr instanceof HTMLElement) || !tr.dataset.id) return null;
  return state.tools.find((t) => t.id === Number(tr.dataset.id)) ?? null;
}

async function toggleFav(t: ToolView): Promise<void> {
  const next = t.favorite !== 1;
  try {
    await patchTool(t.id, { favorite: next });
    t.favorite = next ? 1 : 0;
    renderFunnel();
    renderPills();
    renderRows();
    toast(next ? `★ ${t.name} favorited — pinned to the top` : `${t.name} unfavorited`);
  } catch (e) {
    errToast(e);
  }
}

async function removeTag(t: ToolView, tag: string): Promise<void> {
  try {
    await apiRemoveTag(t.id, tag);
    t.tags = t.tags.filter((x) => x.tag !== tag);
    renderPills();
    renderRows();
    toast(`tag removed: ${tag}`);
  } catch (e) {
    errToast(e);
  }
}

async function addTag(t: ToolView): Promise<void> {
  const name = (window.prompt(`Add a tag to ${t.name}:`) ?? '').trim();
  if (!name) return;
  if (t.tags.some((x) => x.tag === name)) {
    toast('tag already there');
    return;
  }
  try {
    await apiAddTag(t.id, name);
    t.tags = [...t.tags, { tool_id: t.id, tag: name, detected: 0 }];
    renderPills();
    renderRows();
    toast(`tag added: ${name}`);
  } catch (e) {
    errToast(e);
  }
}

/** Actions ▾ items, built from the row's real state. Nothing is offered that
 *  the server would only refuse: teardown needs a running trial, update needs
 *  a kind that can be updated at all. */
export function menuItems(t: ToolView): Array<{ act: string; label: string; hint: string; on: boolean; danger?: boolean }> {
  const retired = t.verdict === 'retired';
  const running = t.observations?.trial_running === 1;
  const updatable = t.kind === 'repo' || t.kind === 'global-cli';
  return [
    {
      act: 'try',
      label: running ? 'Trial running' : 'Try in Docker…',
      hint: running ? 'tear it down first' : 'plan shown first',
      on: !running && !retired,
    },
    { act: 'teardown', label: 'Tear down', hint: running ? 'osm-created only' : 'no trial running', on: running },
    {
      act: 'update',
      label: 'Update…',
      hint: updatable ? 'fast-forward only' : `${t.kind} cannot update`,
      on: updatable && !retired,
    },
    { act: 'register', label: 'Register MCP…', hint: 'dry run first', on: !retired },
    { act: 'unregister', label: 'Unregister MCP…', hint: 'the inverse', on: true },
    { act: 'retire', label: 'Retire…', hint: retired ? 'already retired' : 'needs a reason', on: !retired, danger: true },
  ];
}

export function runAction(act: string, t: ToolView): void {
  switch (act) {
    case 'try':
      void tryFlow(t);
      return;
    case 'teardown':
      void tearDownFlow(t);
      return;
    case 'update':
      void updateFlow(t);
      return;
    case 'register':
      void registerFlow(t);
      return;
    case 'unregister':
      void unregisterFlow(t);
      return;
    case 'retire':
      retireFlow(t);
      return;
    default:
      toast(`unknown action: ${act}`);
  }
}

/** Close every open menu. Exported-by-use: also fired on scroll/resize, since a
 *  fixed-position popup would otherwise float away from its row. */
function closeMenus(): void {
  document.querySelectorAll('.menu-pop').forEach((p) => p.remove());
}

function openActionsMenu(dd: Element, t: ToolView): void {
  closeMenus();
  const m = document.createElement('div');
  m.className = 'menu-pop';
  const items = menuItems(t);
  m.innerHTML = items
    .map((it, i) => {
      const hr = it.act === 'retire' && i > 0 ? '<hr>' : '';
      const cls = it.danger ? ' class="danger"' : '';
      return it.on
        ? `${hr}<button${cls} data-act="${esc(it.act)}"><span>${esc(it.label)}</span><span class="mhint">${esc(it.hint)}</span></button>`
        : `${hr}<button disabled title="${esc(it.hint)}"><span>${esc(it.label)}</span><span class="mhint">${esc(it.hint)}</span></button>`;
    })
    .join('');
  m.addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest('[data-act]');
    if (!btn || !(btn instanceof HTMLElement) || !btn.dataset.act) return;
    const act = btn.dataset.act;
    m.remove();
    runAction(act, t);
  });

  // The table wrapper is a scroll container (overflow-x:auto ⇒ both axes clip),
  // so an absolutely-positioned menu gets cut off on short tables. Anchor it to
  // the viewport instead and flip it above the button when it would hang off
  // the bottom — an action you cannot reach is an action that does not exist.
  const r = dd.getBoundingClientRect();
  m.style.position = 'fixed';
  m.style.right = 'auto';
  m.style.top = '0';
  m.style.left = '0';
  m.style.visibility = 'hidden';
  document.body.appendChild(m);
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 4;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  m.style.visibility = 'visible';
}

async function linkAction(kind: string, t: ToolView): Promise<void> {
  if (kind === 'readme') {
    handlers.select?.(t.id);
    return;
  }
  if (kind === 'copy') {
    const p = copyablePath(t);
    if (!p) {
      toast('no path on record for this tool');
      return;
    }
    try {
      await navigator.clipboard.writeText(p);
      toast('path copied');
    } catch {
      window.prompt('Copy path:', p);
    }
    return;
  }
  if (kind === 'ide') {
    toast('Open in IDE — placeholder, ships in a later phase');
  }
}

async function trackFromBar(): Promise<void> {
  const urlEl = $('#addurl') as HTMLInputElement;
  const whyEl = $('#addwhy') as HTMLInputElement;
  const url = urlEl.value.trim();
  if (!url) {
    toast('Paste a repo URL first');
    urlEl.focus();
    return;
  }
  try {
    await trackTool(url, whyEl.value.trim());
    toast(`tracked: ${url.split('/').filter(Boolean).pop() ?? url}`);
    urlEl.value = '';
    whyEl.value = '';
    await handlers.reload?.();
  } catch (e) {
    errToast(e);
  }
}

/* ---------- keyboard ---------- */

function palOpen(): boolean {
  const p = document.querySelector('#pal');
  return p instanceof HTMLElement && !p.hidden;
}

/** True when a text field owns the keyboard. Checkboxes and buttons do not
 *  count — clicking a row's checkbox must not kill j/k for the rest of the day. */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type);
  }
  return false;
}

function manageVisible(): boolean {
  const v = qs('#view-manage');
  return v !== null && !v.classList.contains('hidden');
}

function cursorTool(): ToolView | null {
  if (state.cursorId === null) return null;
  return state.tools.find((t) => t.id === state.cursorId) ?? null;
}

function moveCursor(delta: number): void {
  if (visibleIds.length === 0) return;
  const cur = state.cursorId === null ? -1 : visibleIds.indexOf(state.cursorId);
  const next =
    cur < 0
      ? delta > 0
        ? 0
        : visibleIds.length - 1
      : Math.max(0, Math.min(visibleIds.length - 1, cur + delta));
  state.cursorId = visibleIds[next];
  paintCursor();
  document.querySelector(`#rows tr[data-id="${state.cursorId}"]`)?.scrollIntoView({ block: 'nearest' });
}

function focusQuery(): void {
  const el = document.querySelector('#qfilter');
  if (el instanceof HTMLInputElement) {
    el.focus();
    el.select();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    closeMenus();
    if (palOpen()) return; // the palette owns its own Escape
    if (isTyping()) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    if (state.selectedId !== null) {
      handlers.closeDetail?.();
      return;
    }
    if (state.selected.size > 0) clearSelection();
    return;
  }
  if (palOpen() || isTyping() || !manageVisible()) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+K et al belong elsewhere
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'j' || k === 'ArrowDown') {
    e.preventDefault();
    moveCursor(1);
    return;
  }
  if (k === 'k' || k === 'ArrowUp') {
    e.preventDefault();
    moveCursor(-1);
    return;
  }
  if (e.key === 'Enter') {
    const t = cursorTool();
    if (!t) return;
    e.preventDefault();
    if (state.selectedId === t.id) handlers.closeDetail?.();
    else handlers.select?.(t.id);
    return;
  }
  if (k === 'x') {
    const t = cursorTool();
    if (!t) return;
    e.preventDefault();
    toggleSelect(t.id, e.shiftKey, !state.selected.has(t.id));
    return;
  }
  if (k === '/') {
    e.preventDefault();
    focusQuery();
    return;
  }
  if (k === 'f') {
    const t = cursorTool();
    if (!t) return;
    e.preventDefault();
    void toggleFav(t);
  }
}

/* ---------- wiring ---------- */

export function initManage(): void {
  buildFilterBar();
  buildHead();
  ensureBulkBar();

  // filter pills + palette button (fbar is re-rendered, so delegate on document)
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (!target) return;

    if (target.closest('#palbtn')) {
      // handled by palette module through its own delegated listener
      return;
    }

    const pil = target.closest('.pil');
    if (pil && pil instanceof HTMLElement && pil.dataset.fq !== undefined) {
      state.filter = pil.dataset.fq || 'all';
      if (state.filter === 'never' && !neverIds) {
        void (async () => {
          try {
            await ensureNeverIds();
          } catch (err) {
            errToast(err);
          }
          renderPills();
          renderRows();
        })();
      }
      renderPills();
      renderRows();
      return;
    }

    // close menus on any outside click (the menu's own handler has already run
    // by the time this bubbles up, so a chosen action is never lost)
    if (!target.closest('.menu-pop')) closeMenus();
    // clicks inside an open action menu are handled by the menu itself
    if (target.closest('.menu-pop')) return;

    // --- chrome outside the tbody: sort headers, select-all, bulk bar ---
    const sortBtn = target.closest('[data-sort]');
    if (sortBtn && sortBtn instanceof HTMLElement && sortBtn.dataset.sort) {
      setSort(sortBtn.dataset.sort as SortKey);
      return;
    }

    const selAll = target.closest('#selall');
    if (selAll && selAll instanceof HTMLInputElement) {
      const want = selAll.checked;
      for (const id of visibleIds) {
        if (want) state.selected.add(id);
        else state.selected.delete(id);
      }
      anchorIdx = -1;
      renderRows();
      return;
    }

    const bulk = target.closest('[data-bulk]');
    if (bulk && bulk instanceof HTMLElement && bulk.dataset.bulk) {
      if (!(bulk instanceof HTMLButtonElement) || !bulk.disabled) runBulk(bulk.dataset.bulk);
      return;
    }

    const clearF = target.closest('[data-clearfilters]');
    if (clearF) {
      state.filter = 'all';
      state.query = '';
      const qi = document.querySelector('#qfilter');
      if (qi instanceof HTMLInputElement) qi.value = '';
      renderPills();
      renderRows();
      return;
    }

    const retry = target.closest('[data-retry]');
    if (retry) {
      void (handlers.reload?.() ?? loadTools());
      return;
    }

    const rows = target.closest('#rows');
    if (!rows) return;

    const sel = target.closest('[data-sel]');
    if (sel && sel instanceof HTMLInputElement) {
      const t = toolFromRow(sel);
      // .checked is already the post-click value; renderRows repaints from state.
      if (t) toggleSelect(t.id, (e as MouseEvent).shiftKey, sel.checked, true);
      return;
    }

    const fav = target.closest('[data-fav]');
    if (fav) {
      const t = toolFromRow(fav);
      if (t) void toggleFav(t);
      return;
    }

    const rm = target.closest('[data-rmtag]');
    if (rm && rm instanceof HTMLElement && rm.dataset.rmtag) {
      const t = toolFromRow(rm);
      if (t) void removeTag(t, rm.dataset.rmtag);
      return;
    }

    const at = target.closest('[data-addtag]');
    if (at) {
      const t = toolFromRow(at);
      if (t) void addTag(t);
      return;
    }

    const lk = target.closest('[data-lk]');
    if (lk && lk instanceof HTMLElement && lk.dataset.lk) {
      const t = toolFromRow(lk);
      if (t) void linkAction(lk.dataset.lk, t);
      return;
    }

    if (target.closest('a.lk')) return; // repo link navigates

    const dd = target.closest('[data-menu]');
    if (dd) {
      const t = toolFromRow(dd);
      if (t) openActionsMenu(dd, t);
      return;
    }

    const tr = target.closest('tr');
    if (tr) {
      // Clicks inside the inline panel land on the .detrow, which carries no
      // data-id — toolFromRow returns null and the click is correctly ignored.
      const t = toolFromRow(tr);
      if (t) {
        state.cursorId = t.id;
        if (state.selectedId === t.id) handlers.closeDetail?.();
        else handlers.select?.(t.id);
      }
    }
  });

  // Inline text filter. The bar is built once precisely so this input survives
  // every re-render with its focus and caret intact.
  const qi = document.querySelector('#qfilter');
  if (qi instanceof HTMLInputElement) {
    qi.addEventListener('input', () => {
      state.query = qi.value;
      renderRows();
    });
    qi.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // this Escape clears the box, it does not close the panel
        if (qi.value === '') {
          qi.blur();
          return;
        }
        qi.value = '';
        state.query = '';
        renderRows();
      }
    });
  }
  const qx = document.querySelector('#qclear');
  qx?.addEventListener('click', () => {
    state.query = '';
    if (qi instanceof HTMLInputElement) {
      qi.value = '';
      qi.focus();
    }
    renderRows();
  });

  // A viewport-anchored menu must not outlive the position it was measured at.
  window.addEventListener('scroll', closeMenus, true);
  window.addEventListener('resize', closeMenus);
  document.addEventListener('keydown', onKeydown);

  $('#trackbtn').addEventListener('click', () => void trackFromBar());
  ($('#addurl') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void trackFromBar();
  });
  $('#refresh').addEventListener('click', () => void refresh());
}
