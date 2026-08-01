// Browse — "other people's shelves". Manage is your stuff; this is everyone
// else's, queried LIVE from public catalogs and never mirrored (PLAN.md locked
// decision #10). Browse never installs anything: Track adds a row at verdict
// 'wanted' and nothing else, and Try only hands off to Manage's read-only
// trial plan.
//
// The whole view is rendered from here into the empty #view-browse container,
// so index.html carries no Browse markup to drift out of sync.
import { trackTool } from './api.js';
import { handlers } from './state.js';
import { $, esc, errToast, toast } from './util.js';
import type { CatalogItem, CatalogResults, CatalogSource } from '../../core/catalog.js';

/* ---------- source chips ---------- */

interface SourceChip {
  id: CatalogSource;
  label: string;
  hint: string;
}

const CHIPS: SourceChip[] = [
  { id: 'docker', label: '🐳 Docker MCP', hint: 'docker mcp catalog server ls — read from the local Docker MCP Toolkit' },
  { id: 'anthropic', label: '✳ Anthropic skills', hint: 'contents API for anthropics/skills' },
  { id: 'github', label: '⎇ GitHub', hint: 'api.github.com repository search — needs a filter, and costs rate limit' },
];

/** Sources the user has switched on. null until the first response decides it
 *  from Settings ("Catalogs — which sources Browse queries"). */
let active: Set<CatalogSource> | null = null;

/* ---------- state ---------- */

let items: CatalogItem[] = [];
let results: CatalogResults | null = null;
let loading = false;
let loadError: string | null = null;
let opened = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
/** Guards against a slow query overwriting a newer one. */
let seq = 0;

/* ---------- helpers ---------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Catalog text is third-party content. A `javascript:` or `data:` href from a
 * public catalog would execute in this page, so only http(s) survives.
 */
function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const SOURCE_CHIP_CLASS: Record<CatalogSource, string> = {
  docker: 'c-blue',
  anthropic: 'c-teal',
  github: 'c-vio',
};

function activeSources(): CatalogSource[] {
  const set = active;
  const all = CHIPS.map((c) => c.id);
  return set === null ? all : all.filter((id) => set.has(id));
}

function countFor(id: CatalogSource): number | null {
  const s = results?.sources.find((x) => x.id === id);
  return s ? s.count : null;
}

/* ---------- render ---------- */

/** Chips only. The filter box is a SIBLING built once in initBrowse(): if a
 *  re-render replaced it, the debounced query would steal focus mid-word. */
function renderChips(): void {
  $('#b-src').innerHTML = CHIPS.map((c) => {
    const on = active === null || active.has(c.id);
    const n = countFor(c.id);
    const badge = n === null ? '' : ` <em>${n}</em>`;
    return `<button class="src${on ? ' on' : ''}" data-src="${esc(c.id)}" aria-pressed="${on}" title="${esc(c.hint)}">${esc(c.label)}${badge}</button>`;
  }).join('');
}

/** Status strip: what each source actually answered, plus the GitHub quota. */
function renderMeta(): void {
  const el = $('#b-meta');
  if (loading) {
    el.innerHTML = `<span class="lbl">querying live…</span>`;
    return;
  }
  if (loadError !== null) {
    el.innerHTML = `<span class="chip c-crit">query failed</span><span style="font-size:12px;color:var(--ink2)">${esc(loadError)}</span>`;
    return;
  }
  if (results === null) {
    el.innerHTML = `<span class="lbl">nothing queried yet</span>`;
    return;
  }
  const chips = results.sources
    .map((s) => {
      const cls = s.ok ? 'c-mut' : 'c-warn';
      return `<span class="chip ${cls}" title="${esc(s.message)}">${esc(s.label)}: ${s.ok ? String(s.count) : 'unavailable'}</span>`;
    })
    .join('');
  const q = results.github_quota;
  const quota =
    q.remaining === null
      ? ''
      : `<span class="mono" style="font-size:11px;color:var(--ink3)" title="${esc(q.reset === null ? 'reset time unknown' : `resets ${q.reset}`)}">github ${esc(q.resource ?? 'api')} quota ${q.remaining}${q.limit === null ? '' : `/${q.limit}`}</span>`;
  el.innerHTML = `${chips}<span class="spacer"></span>${quota}<span class="mono" style="font-size:11px;color:var(--ink3)">${esc(results.queried_at)}</span>`;
}

function cardHTML(item: CatalogItem, i: number): string {
  const tracked = item.already_tracked;
  const href = safeHttpUrl(item.url);
  const stars = item.stars === undefined ? '' : `<span class="mono" style="font-size:11px;color:var(--ink3)" title="${item.stars} stars">★ ${esc(fmtStars(item.stars))}</span>`;

  const head =
    `<div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">` +
    `<b style="font-size:13.5px;letter-spacing:-.01em;word-break:break-word">${esc(item.name)}</b>` +
    `<span class="chip ${SOURCE_CHIP_CLASS[item.source]}">${esc(item.source)}</span>` +
    (tracked ? `<span class="chip c-ok">on your shelf</span>` : '') +
    `<span class="spacer"></span>${stars}</div>`;

  const body =
    `<div style="font-size:12.5px;color:var(--ink2);line-height:1.45">${esc(item.description)}</div>` +
    `<div class="mono" style="font-size:10px;color:var(--ink3);word-break:break-all">${esc(item.provenance)}</div>`;

  const open = href === null
    ? `<button class="btn gho" disabled title="the catalog gave no usable link">Open</button>`
    : `<a class="btn gho" href="${esc(href)}" target="_blank" rel="noopener">Open ↗</a>`;

  // Already on the shelf ⇒ no Track, no Try. The row is the truth; go there.
  const actions = tracked
    ? `${open}<button class="btn pri" data-go="${i}" title="jump to this row in Manage">Go to row</button>`
    : item.track === null
      ? `${open}<button class="btn" disabled title="${esc(item.track_hint ?? 'no canonical identity for this item')}">Track</button>` +
        `<button class="btn" disabled title="${esc(item.track_hint ?? 'no canonical identity for this item')}">Try…</button>`
      : `${open}<button class="btn pri" data-track="${i}" title="adds a row at verdict 'wanted' — no clone, no install">Track</button>` +
        `<button class="btn" data-try="${i}" title="tracks it, then opens the read-only trial plan in Manage — nothing runs">Try…</button>`;

  return `<article class="card" data-i="${i}"${tracked ? ' style="opacity:.55"' : ''}>
    ${head}${body}
    <span class="spacer"></span>
    <div class="acts">${actions}</div>
  </article>`;
}

function renderCards(): void {
  const el = $('#b-cards');
  if (loading) {
    el.innerHTML = `<div class="placeholder">Querying the catalogs live…</div>`;
    return;
  }
  if (loadError !== null) {
    el.innerHTML = `<div class="placeholder">${esc(loadError)} — <b>nothing was cached</b>, so there is nothing stale to show. Try again.</div>`;
    return;
  }
  if (results === null) {
    el.innerHTML = `<div class="placeholder">Pick a source and type a filter. Catalogs are queried live, never mirrored.</div>`;
    return;
  }
  if (activeSources().length === 0) {
    el.innerHTML = `<div class="placeholder">No sources selected — turn one on above (or enable it in <b>Settings → Catalogs</b>).</div>`;
    return;
  }
  if (items.length === 0) {
    const unavailable = results.sources.filter((s) => !s.ok);
    const why = unavailable.length > 0 ? ` ${unavailable.map((s) => `${s.label}: ${s.message}`).join(' · ')}` : '';
    el.innerHTML = `<div class="placeholder">Nothing matched.${esc(why)}</div>`;
    return;
  }
  el.innerHTML = items.map(cardHTML).join('');
}

function render(): void {
  renderChips();
  renderMeta();
  renderCards();
}

/* ---------- querying ---------- */

let lastQuery = '';

async function fetchCatalog(sources: CatalogSource[], q: string): Promise<CatalogResults> {
  const params = new URLSearchParams();
  params.set('sources', sources.join(','));
  if (q !== '') params.set('q', q);
  // GET is a non-mutating route shape — the server requires no X-OSM-Token for
  // it (same rule as /api/tools and /api/tools/:id/plan-trial).
  let res: Response;
  try {
    res = await fetch(`/api/catalog?${params.toString()}`);
  } catch {
    throw new Error('server unreachable — is `osm serve` running?');
  }
  let body: unknown = null;
  const text = await res.text();
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} — unreadable response`);
    }
  }
  if (isRecord(body) && body.ok === false) {
    throw new Error(typeof body.message === 'string' ? body.message : `request failed (${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('unexpected catalog response shape');
  return data as unknown as CatalogResults;
}

async function runQuery(): Promise<void> {
  if (debounce !== undefined) {
    clearTimeout(debounce);
    debounce = undefined;
  }
  const box = document.querySelector('#b-q');
  lastQuery = (box instanceof HTMLInputElement ? box.value : lastQuery).trim();
  const sources = activeSources();
  const mine = ++seq;

  if (sources.length === 0) {
    results = null;
    items = [];
    loadError = null;
    render();
    return;
  }

  loading = true;
  loadError = null;
  renderMeta();
  renderCards();
  try {
    const data = await fetchCatalog(sources, lastQuery);
    if (mine !== seq) return; // a newer query already answered
    results = data;
    items = data.items;
    // First response is authoritative about which sources ran: with no explicit
    // chip state yet, Settings decided, and the chips must show that.
    if (active === null) active = new Set(data.sources.map((s) => s.id));
  } catch (e) {
    if (mine !== seq) return;
    loadError = e instanceof Error ? e.message : String(e);
    results = null;
    items = [];
  }
  loading = false;
  render();
}

function scheduleQuery(): void {
  if (debounce !== undefined) clearTimeout(debounce);
  // Long enough that typing does not spend GitHub's 10-searches-per-minute.
  debounce = setTimeout(() => void runQuery(), 600);
}

/* ---------- actions ---------- */

/** Reuse main.ts's own tab handler rather than duplicating the switch logic. */
function switchToManage(): void {
  const tab = document.querySelector('#viewtabs .tab[data-view="manage"]');
  if (tab instanceof HTMLElement) tab.click();
}

/**
 * Jump to a shelf row. `openRun` selects the Run tab BEFORE the panel loads,
 * because detail.show() lazy-loads whichever pane is active when its fetch
 * lands — clicking it afterwards would race the load.
 */
function goToRow(id: number, openRun = false): void {
  switchToManage();
  if (openRun) {
    const dt = document.querySelector('.dtab[data-p="run"]');
    if (dt instanceof HTMLElement) dt.click();
  }
  handlers.select?.(id);
  setTimeout(() => {
    document.querySelector(`#rows tr[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  }, 0);
}

/**
 * Track one catalog item. This is the ONLY thing Browse writes, and all it
 * writes is a row at verdict 'wanted' — no clone, no install, no catalog data
 * copied into the DB. The card is patched in place instead of re-running the
 * query, so flipping a card to "on your shelf" never costs GitHub quota.
 */
async function trackItem(item: CatalogItem): Promise<number | null> {
  const url = item.track?.url;
  if (url === undefined || url === '') {
    toast(item.track_hint ?? 'this item has no URL OSM can track');
    return null;
  }
  const created = await trackTool(url, '');
  const id = isRecord(created) && typeof created.id === 'number' ? created.id : null;
  item.already_tracked = true;
  if (id !== null) item.tool_id = id;
  render();
  void handlers.reload?.(); // keep the Manage shelf in step
  return id;
}

function onTrack(item: CatalogItem): void {
  void (async () => {
    try {
      const id = await trackItem(item);
      toast(id === null ? `tracked ${item.name}` : `tracked ${item.name} — verdict 'wanted', nothing installed`);
    } catch (e) {
      errToast(e);
    }
  })();
}

function onTry(item: CatalogItem): void {
  void (async () => {
    try {
      const id = item.tool_id ?? (await trackItem(item));
      if (id === null) {
        toast('tracked, but the new row id came back empty — open it from Manage');
        return;
      }
      goToRow(id, true);
      toast('tracked — showing the planned command. Nothing has run.');
    } catch (e) {
      errToast(e);
    }
  })();
}

/* ---------- wiring ---------- */

export function initBrowse(): void {
  $('#view-browse').innerHTML = `
    <div class="srcbar">
      <span id="b-src" style="display:flex;gap:6px;flex-wrap:wrap"></span>
      <span class="spacer"></span>
      <input class="fld" id="b-q" placeholder="filter…" spellcheck="false" aria-label="Filter catalogs">
      <button class="btn" id="b-go" title="Run the query now — GitHub search only runs on demand">Search</button>
    </div>
    <div class="fbar" id="b-meta"></div>
    <div class="cards" id="b-cards"></div>
    <div class="placeholder" style="padding-top:0">
      <b>Nothing here is stored.</b> These catalogs are public and already searchable — OSM queries them live.
      A row enters your database only when you press Track, at verdict <b>wanted</b>: no clone, no install.
    </div>`;
  render();

  // Delegated: the chip bar, filter box and cards are all re-rendered.
  $('#view-browse').addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (!target) return;

    const chip = target.closest('[data-src]');
    if (chip instanceof HTMLElement && chip.dataset.src) {
      const id = chip.dataset.src as CatalogSource;
      if (active === null) active = new Set(CHIPS.map((c) => c.id));
      if (active.has(id)) active.delete(id);
      else active.add(id);
      renderChips();
      void runQuery();
      return;
    }

    if (target.closest('#b-go')) {
      void runQuery();
      return;
    }

    const go = target.closest('[data-go]');
    if (go instanceof HTMLElement && go.dataset.go) {
      const item = items[Number(go.dataset.go)];
      if (item?.tool_id !== undefined) goToRow(item.tool_id);
      else toast('that row is on the shelf but its id was not returned — find it in Manage');
      return;
    }

    const tr = target.closest('[data-track]');
    if (tr instanceof HTMLElement && tr.dataset.track) {
      const item = items[Number(tr.dataset.track)];
      if (item) onTrack(item);
      return;
    }

    const ty = target.closest('[data-try]');
    if (ty instanceof HTMLElement && ty.dataset.try) {
      const item = items[Number(ty.dataset.try)];
      if (item) onTry(item);
    }
  });

  $('#view-browse').addEventListener('input', (e) => {
    if ((e.target as Element | null)?.closest('#b-q')) scheduleQuery();
  });
  $('#view-browse').addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter' && (e.target as Element | null)?.closest('#b-q')) {
      e.preventDefault();
      void runQuery();
    }
  });

  // First open queries once; after that the results stay put until the user
  // changes something. Re-opening the tab must not silently spend API quota.
  document.addEventListener('click', (e) => {
    const tab = (e.target as Element | null)?.closest('#viewtabs .tab');
    if (tab instanceof HTMLElement && tab.dataset.view === 'browse') loadBrowseView();
  });
}

export function loadBrowseView(): void {
  if (opened) return;
  opened = true;
  void runQuery();
}
