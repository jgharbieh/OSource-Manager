// Ctrl+K command palette: fuzzy filter over shelf rows, `>` prefix action mode,
// and an honest Phase-4 placeholder for live catalog results.
import { state, handlers } from './state.js';
import { stateChips } from './manage.js';
import { $, esc, toast } from './util.js';

interface PalRow {
  n: string;
  d: string;
  k: string;
  fav?: boolean;
  id?: number;
  run?: () => void;
}

const CMDS: Array<{ q: string; n: string; d: string; run: () => void }> = [
  { q: 'refresh', n: '> Refresh everything', d: 'disk, package managers, configs, feeds', run: () => void handlers.refresh?.() },
  { q: 'never', n: '> Show no-evidence', d: 'the retire candidates', run: () => handlers.setFilter?.('never') },
  { q: 'updates', n: '> Show updates', d: 'rows with an upstream update', run: () => handlers.setFilter?.('upd') },
  { q: 'favorites', n: '> Show favorites', d: 'starred rows', run: () => handlers.setFilter?.('fav') },
  { q: 'all', n: '> Show all', d: 'clear the filter', run: () => handlers.setFilter?.('all') },
  { q: 'track', n: '> Track a URL', d: 'jump to the add bar', run: () => handlers.focusAdd?.() },
  { q: 'retire', n: '> Retire selected…', d: 'needs a reason', run: () => toast('Select a row first, then Actions ▾ → Retire…') },
];

function fuzzy(hay: string, needle: string): boolean {
  // subsequence match, cheap and good enough for a shelf
  let i = 0;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) i++;
  }
  return i === n.length;
}

function palRows(q: string): { rows: PalRow[]; catalogStub: boolean } {
  const s = q.trim();
  if (s.startsWith('>')) {
    const needle = s.slice(1).trim();
    const rows = CMDS.filter((c) => !needle || fuzzy(c.q + ' ' + c.n, needle)).map((c) => ({ n: c.n, d: c.d, k: 'action', run: c.run }));
    return { rows, catalogStub: false };
  }
  const rows: PalRow[] = state.tools
    .filter((t) => !s || fuzzy(`${t.name} ${t.why_i_want_it ?? ''} ${t.tags.map((x) => x.tag).join(' ')}`, s))
    .map((t) => ({
      n: t.name,
      d: t.why_i_want_it ?? t.canonical_key,
      k: stateChips(t)[0]?.label ?? t.verdict,
      fav: t.favorite === 1,
      id: t.id,
    }));
  rows.sort((a, b) => Number(b.fav ?? false) - Number(a.fav ?? false) || a.n.localeCompare(b.n));
  return { rows: rows.slice(0, 40), catalogStub: true };
}

let palI = 0;
let palCur: PalRow[] = [];

function drawPal(): void {
  const q = ($('#palq') as HTMLInputElement).value;
  const { rows, catalogStub } = palRows(q);
  palCur = rows;
  palI = Math.min(palI, Math.max(0, rows.length - 1));
  const list = rows
    .map(
      (r, i) =>
        `<button class="pal-row${i === palI ? ' cur' : ''}" data-pi="${i}">
      <span class="pn">${r.fav ? '★ ' : ''}${esc(r.n)}</span><span class="pd">${esc(r.d)}</span><span class="pk">${esc(r.k)}</span></button>`,
    )
    .join('');
  const stub = catalogStub
    ? `<div class="pal-row" style="cursor:default;opacity:.6"><span class="pn">⎇ live catalog results</span><span class="pd">Phase 4 — catalogs queried live, never stored</span><span class="pk">soon</span></div>`
    : '';
  $('#pallist').innerHTML =
    list + stub ||
    `<div style="padding:14px;color:var(--ink3);font-size:13px">No match on the shelf — paste the URL in the add bar to track it.</div>`;
  $('#palcount').textContent = `${rows.length} of ${state.tools.length}`;
  $('#pallist').querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}

function openPal(): void {
  const pal = $('#pal') as HTMLElement & { hidden: boolean };
  pal.hidden = false;
  ($('#palq') as HTMLInputElement).value = '';
  palI = 0;
  drawPal();
  ($('#palq') as HTMLInputElement).focus();
}

function closePal(): void {
  ($('#pal') as HTMLElement & { hidden: boolean }).hidden = true;
}

function pick(r: PalRow | undefined): void {
  if (!r) return;
  closePal();
  if (r.run) {
    r.run();
    return;
  }
  if (r.id !== undefined) {
    handlers.select?.(r.id);
    const tr = document.querySelector(`#rows tr[data-id="${r.id}"]`);
    tr?.scrollIntoView({ block: 'center' });
  }
}

export function initPalette(): void {
  // delegated: #palbtn is re-rendered with the filter bar
  document.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t?.closest('#palbtn')) openPal();
  });
  ($('#palq') as HTMLInputElement).addEventListener('input', () => {
    palI = 0;
    drawPal();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPal();
      return;
    }
    if (($('#pal') as HTMLElement & { hidden: boolean }).hidden) return;
    if (e.key === 'Escape') closePal();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      palI = Math.min(palI + 1, palCur.length - 1);
      drawPal();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      palI = Math.max(palI - 1, 0);
      drawPal();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(palCur[palI]);
    }
  });
  $('#pal').addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t && (t as HTMLElement).id === 'pal') {
      closePal();
      return;
    }
    const r = t?.closest('[data-pi]');
    if (r && r instanceof HTMLElement) pick(palCur[Number(r.dataset.pi)]);
  });
}
