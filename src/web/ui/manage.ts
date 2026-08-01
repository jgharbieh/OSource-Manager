// Manage view: funnel strip, filter pills, shelf table, add bar, refresh stamp.
import {
  addTag as apiAddTag,
  listTools,
  patchTool,
  refreshAll,
  refreshUpstream,
  removeTag as apiRemoveTag,
  searchTools,
  trackTool,
} from './api.js';
import { registerFlow, retireFlow, tearDownFlow, tryFlow, unregisterFlow, updateFlow } from './actions.js';
import { state, handlers } from './state.js';
import { $, esc, errToast, fmtRel, fmtStamp, repoWebUrl, toast } from './util.js';
import type { Installation, Tag, ToolView } from '../../core/types.js';

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

function tagClass(tag: Tag): string {
  if (tag.detected === 0) return 't-cust';
  const known: Record<string, string> = { mcp: 't-mcp', skill: 't-skill', app: 't-app', api: 't-api', mine: 't-mine' };
  return known[tag.tag] ?? 't-cust';
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

/* ---------- filter pills ---------- */

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
  const fbar = $('#fbar');
  fbar.innerHTML = `${html}<span class="spacer"></span><button class="btn gho" id="palbtn"><kbd>Ctrl</kbd><kbd>K</kbd> search</button>`;
}

/* ---------- table ---------- */

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
  return `<tr data-id="${t.id}"${state.selectedId === t.id ? ' class="sel"' : ''}>
    <td><span class="nm"><button class="fav${fav ? ' on' : ''}" data-fav aria-label="Favorite" aria-pressed="${fav}">${fav ? '★' : '☆'}</button>${esc(t.name)}<span class="tags">${tags}${tagAdd}</span><span class="sub">${sub}</span></span></td>
    <td><span class="linkrow">${links}</span></td>
    <td><span class="statecell">${chips}</span></td>
    <td class="m">${esc(localVersion(t))}</td>
    <td class="m${upNew ? ' new' : ''}">${esc(up)}${upNew ? ' ↑' : ''}</td>
    <td class="m${seen ? '' : ' never'}">${seen ? fmtRel(seen) : '—'}</td>
    <td><span class="rowacts"><span class="menu"><button class="dd" data-menu>Actions ▾</button></span></span></td></tr>`;
}

export function renderRows(): void {
  // The default ('all') view hides OS/vendor noise tagged 'system'; the
  // dedicated 'system' pill (fq 'sys') brings those rows back. Funnel and
  // pill counts stay honest — they always cover every row.
  const rows = state.tools.filter(
    (t) => matchFilter(t, state.filter) && (state.filter !== 'all' || !isNoiseByDefault(t)),
  );
  // favorites pinned to the top, then name
  rows.sort((a, b) => b.favorite - a.favorite || a.name.localeCompare(b.name));
  parkDetail(); // rescue #det before the tbody wipe destroys it
  $('#rows').innerHTML =
    rows.map(rowHTML).join('') ||
    `<tr><td colspan="7" class="rowmsg">${state.tools.length === 0 ? 'Nothing tracked yet — paste a repo URL above and hit Track.' : 'No rows match this filter.'}</td></tr>`;
  mountDetail();
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
  td.colSpan = 7;
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
  neverIds = null;
  try {
    state.tools = await listTools();
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
    errToast(e);
  }
  state.loading = false;
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

export function initManage(): void {
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

    const rows = target.closest('#rows');
    if (!rows) return;

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
        if (state.selectedId === t.id) handlers.closeDetail?.();
        else handlers.select?.(t.id);
      }
    }
  });

  // A viewport-anchored menu must not outlive the position it was measured at.
  window.addEventListener('scroll', closeMenus, true);
  window.addEventListener('resize', closeMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });

  $('#trackbtn').addEventListener('click', () => void trackFromBar());
  ($('#addurl') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void trackFromBar();
  });
  $('#refresh').addEventListener('click', () => void refresh());
}
