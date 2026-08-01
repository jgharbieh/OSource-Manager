// DOM/format helpers, plus the shared UI primitives the detail panel and the
// action flows are built from.
//
// Why the widgets live here rather than in styles.css / index.html: those two
// files are shared surfaces. Everything below injects its own CSS through
// ensureStyles() and builds its own DOM, so a component is one import away from
// working and cannot be half-broken by an unrelated edit to the page shell.
//
// The three that matter:
//   emptyState()/errorState()/noteState() — a tab NEVER renders blank or with a
//     bare sentence: it says what is missing, why, and what to do next.
//   openFlow()  — one modal per action, with three phases: working → ask →
//     report. window.confirm/prompt/alert cannot show a pending state and
//     cannot gate a confirm button on a required reason, which is exactly what
//     "retire needs a reason" requires.
//   openTagEditor() — the tag popover, driven from both the row and the panel.

export function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as HTMLElement;
}

/** Same as $ but tolerant — for nodes that only exist in some views. */
export function $maybe(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Message from anything thrown. Never the useless '[object Object]'. */
export function msgOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  const s = String(e);
  return s === '[object Object]' ? 'unknown error' : s;
}

let toastT: ReturnType<typeof setTimeout> | undefined;
export function toast(m: string): void {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('show');
  if (toastT !== undefined) clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

export function errToast(e: unknown): void {
  toast(msgOf(e));
}

/** Absolute timestamp to the second: YYYY-MM-DD HH:mm:ss (local). */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Relative time, honest and coarse: '2h ago', 'today', 'never'. */
export function fmtRel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Relative time in the page, absolute time on hover. The relative label is what
 * a human reads ("3h ago"); the exact second is what an incident needs, so it
 * is one hover away instead of gone. Marked data-rel so the page clock below
 * keeps it truthful without a re-render.
 */
export function timeHTML(iso: string | null | undefined, cls = 'ts'): string {
  if (!iso) return `<span class="${esc(cls)}">—</span>`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `<span class="${esc(cls)}">${esc(iso)}</span>`;
  return `<time class="${esc(cls)}" data-rel="1" datetime="${esc(iso)}" title="${esc(fmtStamp(iso))}">${esc(fmtRel(iso))}</time>`;
}

/** repo web URL from a canonical git key 'host/owner/repo'; null if it isn't one. */
export function repoWebUrl(canonicalKey: string): string | null {
  return /^[\w.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+$/i.test(canonicalKey) ? `https://${canonicalKey}` : null;
}

/* ------------------------------------------------------------------ */
/* clipboard                                                           */
/* ------------------------------------------------------------------ */

/** Copy with a real fallback — clipboard access is blocked in some contexts. */
export async function copyText(text: string, okMsg: string, label = 'Copy:'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    window.prompt(label, text);
  }
}

/* ------------------------------------------------------------------ */
/* pending state                                                       */
/* ------------------------------------------------------------------ */

/**
 * Disable a button and label it while its work runs, then put it back exactly
 * as it was. Every action in this UI goes through here or through openFlow():
 * a click with no visible consequence is indistinguishable from a dead button.
 */
export async function withPending<T>(
  btn: HTMLButtonElement,
  pendingLabel: string,
  run: () => Promise<T>,
): Promise<T> {
  const prevHtml = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.dataset.pending = '1';
  btn.textContent = pendingLabel;
  try {
    return await run();
  } finally {
    if (btn.isConnected) {
      delete btn.dataset.pending;
      btn.innerHTML = prevHtml;
      btn.disabled = wasDisabled;
    }
  }
}

/* ------------------------------------------------------------------ */
/* tab states — empty / error / note                                   */
/* ------------------------------------------------------------------ */

export interface StateAction {
  /** id attribute, so the caller can wire it after inserting the HTML. */
  id: string;
  label: string;
  primary?: boolean;
  /** Renders an <a> instead of a <button>. */
  href?: string;
}

export interface StateOpts {
  title: string;
  /** Plain text, escaped here. */
  detail?: string;
  /** Already-escaped HTML, appended after `detail`. */
  html?: string;
  actions?: StateAction[];
}

function stateHTML(kind: string, o: StateOpts): string {
  const acts = (o.actions ?? [])
    .map((a) =>
      a.href !== undefined
        ? `<a class="btn${a.primary === true ? ' pri' : ''}" id="${esc(a.id)}" href="${esc(a.href)}" target="_blank" rel="noopener">${esc(a.label)}</a>`
        : `<button type="button" class="btn${a.primary === true ? ' pri' : ''}" id="${esc(a.id)}">${esc(a.label)}</button>`,
    )
    .join('');
  return `<div class="osm-state ${kind}">
    <span class="t">${esc(o.title)}</span>
    ${o.detail !== undefined ? `<span class="d">${esc(o.detail)}</span>` : ''}
    ${o.html ?? ''}
    ${acts ? `<span class="row">${acts}</span>` : ''}
  </div>`;
}

/** Nothing here — and the reason why. */
export function emptyState(o: StateOpts): string {
  return stateHTML('empty', o);
}

/** Something went wrong — shown in the tab, not in a toast that vanishes. */
export function errorState(o: StateOpts): string {
  return stateHTML('err', o);
}

/** Not an error and not empty: blocked, stale, or worth knowing. */
export function noteState(o: StateOpts): string {
  return stateHTML('note', o);
}

/** A pending state for a tab body while its fetch is in flight. */
export function loadingState(text: string): string {
  return `<div class="osm-work"><span class="osm-spin" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
}

/**
 * Server refusals that mean "there is nothing here yet", not "this broke".
 * Getting this wrong is how a perfectly normal empty tab ends up screaming red.
 */
const NOT_AN_ERROR = [
  /no trial recorded/i,
  /already torn down/i,
  /no docker run instructions/i,
  /has no present disk installation/i,
  /has no container to read logs/i,
  /unsupported host/i,
  /not found/i,
];

export function looksEmptyNotBroken(message: string): boolean {
  return NOT_AN_ERROR.some((re) => re.test(message));
}

/** Environment problems — real, but the user's machine, not a bug. */
export function looksBlocked(message: string): boolean {
  return /docker is not available|rate limit|network|ENOTFOUND|ECONNREFUSED|unreachable/i.test(message);
}

/* ------------------------------------------------------------------ */
/* flow dialog: working -> ask -> report                               */
/* ------------------------------------------------------------------ */

export interface AskChoice {
  id: string;
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface AskInput {
  label: string;
  placeholder?: string;
  hint?: string;
  /** Confirm stays disabled until this has content. */
  required?: boolean;
  multiline?: boolean;
  value?: string;
}

export interface AskOpts {
  lead?: string;
  /** For a destructive action: exactly what happens, one line each. */
  consequences?: string[];
  /** Monospace block — a command, a diff, a refusal list. Escaped here. */
  pre?: string;
  /** Already-escaped extra HTML. */
  html?: string;
  choices?: AskChoice[];
  input?: AskInput;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface AskResult {
  confirmed: boolean;
  value: string;
  selected: string[];
}

export interface ReportOpts {
  ok: boolean;
  /** The real message from the server. Never replaced with a generic one. */
  message: string;
  lead?: string;
  pre?: string;
  html?: string;
  closeLabel?: string;
}

export interface FlowDialog {
  /** Show an indeterminate pending state. Esc cannot dismiss it. */
  working(text: string): void;
  ask(opts: AskOpts): Promise<AskResult>;
  /** Final state. Resolves when the user closes it. */
  report(opts: ReportOpts): Promise<void>;
  close(): void;
}

let activeFlow: FlowDialog | null = null;

export function openFlow(title: string): FlowDialog {
  ensureStyles();
  activeFlow?.close();

  const dlg = document.createElement('dialog');
  dlg.className = 'osm-dlg';
  dlg.innerHTML = `<h4 class="osm-dlg-t"></h4>
    <div class="osm-dlg-b"></div>
    <div class="osm-dlg-f">
      <span class="osm-dlg-n"></span><span class="spacer"></span>
      <button type="button" class="btn" data-v="cancel">Cancel</button>
      <button type="button" class="btn pri" data-v="confirm">Confirm</button>
    </div>`;
  document.body.appendChild(dlg);

  const titleEl = dlg.querySelector('.osm-dlg-t') as HTMLElement;
  const bodyEl = dlg.querySelector('.osm-dlg-b') as HTMLElement;
  const footEl = dlg.querySelector('.osm-dlg-f') as HTMLElement;
  const noteEl = dlg.querySelector('.osm-dlg-n') as HTMLElement;
  const cancelBtn = dlg.querySelector('[data-v="cancel"]') as HTMLButtonElement;
  const confirmBtn = dlg.querySelector('[data-v="confirm"]') as HTMLButtonElement;
  titleEl.textContent = title;

  let phase: 'working' | 'ask' | 'report' = 'working';
  let settle: ((r: AskResult) => void) | null = null;
  let askOpts: AskOpts | null = null;
  let closed = false;

  function currentValue(): string {
    const f = dlg.querySelector('.osm-field-in') as HTMLInputElement | HTMLTextAreaElement | null;
    return f ? f.value.trim() : '';
  }

  function currentSelected(): string[] {
    return Array.from(dlg.querySelectorAll<HTMLInputElement>('.osm-choice input:checked')).map((i) => i.value);
  }

  function resolveWith(confirmed: boolean): void {
    const fn = settle;
    settle = null;
    fn?.({ confirmed, value: currentValue(), selected: currentSelected() });
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    if (activeFlow === api) activeFlow = null;
    resolveWith(false);
    if (dlg.open) dlg.close();
    dlg.remove();
  }

  // Esc: allowed everywhere except mid-flight, where "cancel" would be a lie —
  // the request is already on the wire and nothing here can call it back.
  dlg.addEventListener('cancel', (e) => {
    if (phase === 'working') {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    finish();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && phase !== 'working') finish(); // backdrop
  });
  cancelBtn.addEventListener('click', () => finish());
  confirmBtn.addEventListener('click', () => {
    if (confirmBtn.disabled) return;
    if (phase === 'report') {
      finish();
      return;
    }
    resolveWith(true);
  });
  // A modal owns the keyboard. Without this the page's global shortcuts still
  // see every keystroke typed into the dialog — Escape would close the detail
  // panel behind it, Enter would toggle the selected row, Ctrl+K would open the
  // palette on top of a confirmation.
  const swallow = (e: Event): void => e.stopPropagation();
  dlg.addEventListener('keyup', swallow);
  dlg.addEventListener('keypress', swallow);
  dlg.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement | null;
    const inTextarea = target instanceof HTMLTextAreaElement;
    // Ctrl/Cmd+Enter always submits; plain Enter submits from a single-line field.
    if ((e.ctrlKey || e.metaKey || !inTextarea) && phase !== 'working' && !confirmBtn.disabled) {
      e.preventDefault();
      confirmBtn.click();
    }
  });

  function syncConfirmEnabled(): void {
    const o = askOpts;
    if (phase !== 'ask' || !o) return;
    const needsText = o.input?.required === true && currentValue() === '';
    const needsPick = (o.choices?.length ?? 0) > 0 && currentSelected().length === 0;
    confirmBtn.disabled = needsText || needsPick;
    noteEl.textContent = needsText
      ? `${o.input?.label ?? 'A reason'} is required`
      : needsPick
        ? 'pick at least one'
        : '';
  }

  // Registered once. Re-adding these per ask() would leave stale listeners
  // gating the button on a previous step's requirements.
  bodyEl.addEventListener('input', syncConfirmEnabled);
  bodyEl.addEventListener('change', syncConfirmEnabled);

  function renderBlocks(o: AskOpts | ReportOpts): string {
    const parts: string[] = [];
    if ('lead' in o && o.lead) parts.push(`<p class="osm-lead">${esc(o.lead)}</p>`);
    if ('consequences' in o && o.consequences && o.consequences.length > 0) {
      parts.push(`<ul class="osm-cons">${o.consequences.map((c) => `<li><span>${esc(c)}</span></li>`).join('')}</ul>`);
    }
    if (o.pre !== undefined && o.pre !== '') parts.push(`<pre class="osm-pre">${esc(o.pre)}</pre>`);
    if (o.html !== undefined && o.html !== '') parts.push(o.html);
    return parts.join('');
  }

  const api: FlowDialog = {
    working(text: string): void {
      phase = 'working';
      askOpts = null;
      settle = null;
      bodyEl.innerHTML = `<div class="osm-work"><span class="osm-spin" aria-hidden="true"></span><span>${esc(text)}</span></div>
        <div class="osm-bar" aria-hidden="true"></div>`;
      footEl.classList.add('busy');
      noteEl.textContent = 'working — this dialog stays until it finishes';
      if (!dlg.open) dlg.showModal();
    },

    ask(o: AskOpts): Promise<AskResult> {
      phase = 'ask';
      askOpts = o;
      footEl.classList.remove('busy');
      const choices = (o.choices ?? [])
        .map(
          (c) =>
            `<label class="osm-choice"${c.disabled === true ? ' data-disabled="1"' : ''}>
              <input type="checkbox" value="${esc(c.id)}"${c.checked === true && c.disabled !== true ? ' checked' : ''}${c.disabled === true ? ' disabled' : ''}>
              <span><b>${esc(c.label)}</b>${c.hint !== undefined ? `<span class="h">${esc(c.hint)}</span>` : ''}</span>
            </label>`,
        )
        .join('');
      const inp = o.input;
      const field =
        inp === undefined
          ? ''
          : `<label class="osm-field">
              <span class="lbl">${esc(inp.label)}${inp.required === true ? ' <span class="osm-req">required</span>' : ''}</span>
              ${
                inp.multiline === false
                  ? `<input class="osm-field-in" type="text" placeholder="${esc(inp.placeholder ?? '')}" value="${esc(inp.value ?? '')}">`
                  : `<textarea class="osm-field-in" rows="3" placeholder="${esc(inp.placeholder ?? '')}">${esc(inp.value ?? '')}</textarea>`
              }
              ${inp.hint !== undefined ? `<span class="osm-hint">${esc(inp.hint)}</span>` : ''}
            </label>`;
      bodyEl.innerHTML =
        renderBlocks(o) + (choices ? `<div class="osm-choices">${choices}</div>` : '') + field;
      bodyEl.scrollTop = 0;

      cancelBtn.hidden = false;
      cancelBtn.textContent = o.cancelLabel ?? 'Cancel';
      confirmBtn.hidden = false;
      confirmBtn.textContent = o.confirmLabel ?? 'Confirm';
      confirmBtn.classList.toggle('danger', o.danger === true);
      syncConfirmEnabled();
      if (!dlg.open) dlg.showModal();
      const focusTarget = (bodyEl.querySelector('.osm-field-in') as HTMLElement | null) ?? confirmBtn;
      focusTarget.focus();

      return new Promise<AskResult>((res) => {
        settle = res;
      });
    },

    report(o: ReportOpts): Promise<void> {
      phase = 'report';
      askOpts = null;
      footEl.classList.remove('busy');
      bodyEl.innerHTML =
        `<div class="osm-res${o.ok ? '' : ' bad'}"><span class="ic">${o.ok ? '✓' : '✕'}</span><span>${esc(o.message)}</span></div>` +
        renderBlocks(o);
      bodyEl.scrollTop = 0;
      cancelBtn.hidden = true;
      confirmBtn.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.classList.remove('danger');
      confirmBtn.textContent = o.closeLabel ?? 'Close';
      noteEl.textContent = '';
      if (!dlg.open) dlg.showModal();
      confirmBtn.focus();
      return new Promise<void>((res) => {
        settle = () => res();
      });
    },

    close(): void {
      finish();
    },
  };

  activeFlow = api;
  return api;
}

/* ------------------------------------------------------------------ */
/* tag editor popover                                                  */
/* ------------------------------------------------------------------ */

/** Structurally compatible with core Tag — kept local so this stays pure UI. */
export interface TagChip {
  tag: string;
  detected: number;
}

export interface TagEditorOpts {
  anchor: HTMLElement;
  subject: string;
  /** Read live — the popover re-reads after every add/remove. */
  getTags: () => TagChip[];
  /** Every tag already in use anywhere, most used first. */
  suggestions: () => string[];
  /** Throw with a useful message to have it shown inline. */
  add: (tag: string) => Promise<void>;
  remove: (tag: string) => Promise<void>;
  onClose?: () => void;
}

let openTagPop: { el: HTMLElement; close: () => void } | null = null;

export function closeTagEditor(): void {
  openTagPop?.close();
}

/**
 * Add with autocomplete over tags already in use, remove with an ✕, custom tags
 * (detected = 0) coloured distinctly from machine-detected ones. Enter commits,
 * Esc cancels, a duplicate is a no-op that says so.
 */
export function openTagEditor(o: TagEditorOpts): void {
  ensureStyles();
  closeTagEditor();

  const pop = document.createElement('div');
  pop.className = 'osm-tagpop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Tags for ${o.subject}`);
  pop.innerHTML = `<div class="hd"><b>Tags</b><span class="sub"></span></div>
    <div class="chips"></div>
    <input class="tagin" type="text" placeholder="add a tag…" spellcheck="false" autocomplete="off" aria-label="Add a tag">
    <div class="osm-sug" role="listbox"></div>
    <div class="osm-note" role="status"></div>
    <div class="osm-legend"><span class="osm-chip det">detected</span><span class="osm-chip cust">yours</span></div>`;
  document.body.appendChild(pop);

  const sub = pop.querySelector('.sub') as HTMLElement;
  const chipsEl = pop.querySelector('.chips') as HTMLElement;
  const input = pop.querySelector('.tagin') as HTMLInputElement;
  const sugEl = pop.querySelector('.osm-sug') as HTMLElement;
  const noteEl = pop.querySelector('.osm-note') as HTMLElement;
  sub.textContent = o.subject;

  let cursor = -1;
  let busy = false;
  let destroyed = false;

  function note(text: string, bad = false): void {
    noteEl.textContent = text;
    noteEl.classList.toggle('bad', bad);
  }

  function place(): void {
    const r = o.anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 5;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 5) : below;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function drawChips(): void {
    const tags = o.getTags();
    chipsEl.innerHTML =
      tags.length === 0
        ? `<span class="osm-none">no tags yet</span>`
        : tags
            .map((t) => {
              const own = t.detected === 0;
              const title = own
                ? 'your tag — remove it and it stays gone'
                : 'detected by the scanner — removing it here is a local override, a refresh can bring it back';
              return `<span class="osm-chip ${own ? 'cust' : 'det'}" title="${esc(title)}">${esc(t.tag)}<button type="button" class="x" data-rm="${esc(t.tag)}" aria-label="Remove ${esc(t.tag)}">✕</button></span>`;
            })
            .join('');
  }

  function candidates(): string[] {
    const have = new Set(o.getTags().map((t) => t.tag.toLowerCase()));
    const q = input.value.trim().toLowerCase();
    return o
      .suggestions()
      .filter((s) => !have.has(s.toLowerCase()))
      .filter((s) => q === '' || s.toLowerCase().includes(q))
      .slice(0, 8);
  }

  function drawSug(): void {
    const list = candidates();
    if (cursor >= list.length) cursor = list.length - 1;
    sugEl.innerHTML = list
      .map(
        (s, i) =>
          `<button type="button" role="option" aria-selected="${i === cursor}" class="${i === cursor ? 'cur' : ''}" data-sug="${esc(s)}"><span>${esc(s)}</span><span class="n">in use</span></button>`,
      )
      .join('');
    sugEl.classList.toggle('hidden', list.length === 0);
    place();
  }

  async function commit(raw: string): Promise<void> {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name === '' || busy) return;
    if (o.getTags().some((t) => t.tag.toLowerCase() === name.toLowerCase())) {
      note(`already tagged “${name}” — no change`);
      input.value = '';
      cursor = -1;
      drawSug();
      return;
    }
    busy = true;
    // readOnly, NOT disabled: disabling the focused field moves focus to
    // <body>, and the rest of the page then reads the keystroke as a global
    // shortcut. Keeping focus here keeps the keyboard inside this popover.
    input.readOnly = true;
    note(`adding “${name}”…`);
    try {
      await o.add(name);
      if (destroyed) return;
      input.value = '';
      cursor = -1;
      note(`added “${name}”`);
      drawChips();
      drawSug();
    } catch (e) {
      if (!destroyed) note(msgOf(e), true);
    } finally {
      if (!destroyed) {
        busy = false;
        input.readOnly = false;
        input.focus();
      }
    }
  }

  async function drop(tag: string, chipBtn: HTMLElement): Promise<void> {
    if (busy) return;
    busy = true;
    chipBtn.closest('.osm-chip')?.setAttribute('data-busy', '1');
    note(`removing “${tag}”…`);
    try {
      await o.remove(tag);
      if (destroyed) return;
      note(`removed “${tag}”`);
      drawChips();
      drawSug();
    } catch (e) {
      if (!destroyed) {
        note(msgOf(e), true);
        drawChips();
      }
    } finally {
      if (!destroyed) {
        busy = false;
        input.focus();
      }
    }
  }

  pop.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    const rm = t?.closest('[data-rm]');
    if (rm instanceof HTMLElement && rm.dataset.rm !== undefined) {
      void drop(rm.dataset.rm, rm);
      return;
    }
    const sug = t?.closest('[data-sug]');
    if (sug instanceof HTMLElement && sug.dataset.sug !== undefined) {
      void commit(sug.dataset.sug);
    }
  });

  input.addEventListener('input', () => {
    cursor = -1;
    note('');
    drawSug();
  });

  // While this popover is open it owns Enter / Escape / the arrows. Without
  // stopPropagation they keep bubbling to the page's global shortcut handler,
  // which reads Enter on the selected row as "toggle the detail panel" and
  // closes the panel out from under the editor.
  input.addEventListener('keydown', (e) => {
    const list = candidates();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      cursor = Math.min(cursor + 1, list.length - 1);
      drawSug();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      cursor = Math.max(cursor - 1, -1);
      drawSug();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void commit(cursor >= 0 && list[cursor] !== undefined ? list[cursor] : input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  function outside(e: MouseEvent): void {
    const t = e.target as Node | null;
    if (t && (pop.contains(t) || o.anchor.contains(t))) return;
    close();
  }

  function close(): void {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    pop.remove();
    if (openTagPop?.el === pop) openTagPop = null;
    o.onClose?.();
  }

  openTagPop = { el: pop, close };
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  drawChips();
  drawSug();
  place();
  input.focus();
}

/* ------------------------------------------------------------------ */
/* relative-time clock                                                 */
/* ------------------------------------------------------------------ */

let relClock: ReturnType<typeof setInterval> | undefined;

/** Keeps every data-rel timestamp truthful without re-rendering its owner. */
function startRelClock(): void {
  if (relClock !== undefined) return;
  relClock = setInterval(() => {
    Array.from(document.querySelectorAll<HTMLTimeElement>('time[data-rel]')).forEach((el) => {
      const iso = el.getAttribute('datetime');
      if (iso) el.textContent = fmtRel(iso);
    });
  }, 30_000);
}

/* ------------------------------------------------------------------ */
/* component styles                                                    */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'osm-ui-components';

const CSS = `
/* --- long values wrap instead of pushing the panel sideways --- */
.det .kv dd,.det .ci,.det .notes,.det .osm-state .d{overflow-wrap:anywhere}
.det pre{white-space:pre-wrap;overflow-wrap:anywhere}
.det-r .kv dd{overflow-wrap:anywhere}

/* --- tab states --- */
.osm-state{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:16px 14px;margin-top:6px;
  border:1px dashed var(--line);border-radius:var(--r);background:var(--sunk)}
.osm-state .t{font-weight:650;font-size:13.5px;color:var(--ink2)}
.osm-state .d{font-size:12.5px;color:var(--ink3);line-height:1.55;max-width:70ch}
.osm-state .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:3px}
.osm-state.err{border-style:solid;border-color:var(--crit);background:var(--crit-soft)}
.osm-state.err .t{color:var(--crit)}
.osm-state.err .d{color:var(--ink2)}
.osm-state.note{border-style:solid;border-color:var(--warn);background:var(--warn-soft)}
.osm-state.note .t{color:var(--warn)}
.osm-state.note .d{color:var(--ink2)}
.osm-state a.btn{text-decoration:none}
.osm-state .kv{margin-top:2px}

/* --- pending --- */
.osm-work{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink2);padding:2px 0}
.osm-spin{width:13px;height:13px;border-radius:50%;flex:none;border:2px solid var(--line);border-top-color:var(--accent);
  animation:osm-spin .75s linear infinite}
@keyframes osm-spin{to{transform:rotate(360deg)}}
.osm-bar{height:2px;background:var(--line);border-radius:2px;overflow:hidden;position:relative}
.osm-bar::after{content:"";position:absolute;inset:0 auto 0 0;width:36%;background:var(--accent);
  animation:osm-slide 1.15s ease-in-out infinite}
@keyframes osm-slide{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){.osm-spin,.osm-bar::after{animation-duration:3s}}
[data-pending="1"]{opacity:.7;position:relative}
[data-pending="1"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--accent);
  animation:osm-slide 1.15s ease-in-out infinite}

/* --- flow dialog --- */
dialog.osm-dlg{padding:0;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);
  width:min(640px,94vw);max-height:84vh;overflow:hidden;font-family:var(--sans);font-size:14px;
  box-shadow:0 24px 70px -20px rgba(0,0,0,.6)}
dialog.osm-dlg::backdrop{background:rgba(6,8,12,.55)}
.osm-dlg-t{margin:0;padding:13px 16px 11px;font-size:15px;font-weight:750;letter-spacing:-.015em;
  border-bottom:1px solid var(--line)}
.osm-dlg-b{padding:14px 16px;display:flex;flex-direction:column;gap:11px;overflow:auto;max-height:58vh}
.osm-dlg-f{display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:1px solid var(--line);background:var(--sunk)}
.osm-dlg-f.busy .btn{display:none}
/* .btn sets display:inline-flex, which outranks the UA's [hidden] rule — the
   report phase hides Cancel through this, not through the attribute alone. */
.osm-dlg-f .btn[hidden]{display:none}
.osm-dlg-n{font-family:var(--mono);font-size:10px;color:var(--ink3)}
.osm-dlg .btn.danger{border-color:var(--crit);background:var(--crit);color:#fff}
.osm-dlg .btn.danger:hover{filter:brightness(1.08);color:#fff}
.osm-lead{margin:0;font-size:13.5px;color:var(--ink2);line-height:1.55}
.osm-cons{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--ink2)}
.osm-cons li{display:flex;gap:8px;align-items:flex-start}
.osm-cons li::before{content:"→";flex:none;color:var(--accent);font-family:var(--mono);font-size:11px;line-height:1.5}
.osm-pre{margin:0;padding:9px 11px;border:1px solid var(--line);border-radius:5px;background:var(--sunk);
  font-family:var(--mono);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;
  max-height:34vh;overflow:auto}
.osm-res{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:0 5px 5px 0;
  border-left:2px solid var(--ok);background:var(--ok-soft);font-size:13.5px;color:var(--ink);overflow-wrap:anywhere}
.osm-res.bad{border-left-color:var(--crit);background:var(--crit-soft)}
.osm-res .ic{font-weight:700;flex:none}
.osm-choices{display:flex;flex-direction:column;gap:4px}
.osm-choice{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border:1px solid var(--line);
  border-radius:5px;background:var(--sunk);font-size:13px;cursor:pointer}
.osm-choice:hover{border-color:var(--accent)}
.osm-choice[data-disabled="1"]{opacity:.5;cursor:not-allowed}
.osm-choice[data-disabled="1"]:hover{border-color:var(--line)}
.osm-choice input{accent-color:var(--accent);margin-top:3px;flex:none}
.osm-choice .h{display:block;font-family:var(--mono);font-size:10.5px;color:var(--ink3);margin-top:2px;overflow-wrap:anywhere}
.osm-field{display:flex;flex-direction:column;gap:5px}
.osm-field .osm-field-in{border:1px solid var(--line);border-radius:5px;padding:8px 10px;font-family:inherit;
  font-size:13px;line-height:1.5;background:var(--sunk);color:var(--ink);width:100%;resize:vertical}
.osm-field .osm-field-in:focus{outline:2px solid var(--accent);outline-offset:1px}
.osm-hint{font-size:11.5px;color:var(--ink3)}
.osm-req{color:var(--crit);font-family:var(--mono);font-size:9.5px;letter-spacing:.08em}

/* --- tag editor --- */
.osm-tagpop{position:fixed;z-index:130;width:min(330px,92vw);padding:10px;display:flex;flex-direction:column;gap:8px;
  background:var(--panel);border:1px solid var(--line);border-radius:8px;
  box-shadow:0 18px 48px -14px rgba(0,0,0,.55)}
.osm-tagpop .hd{display:flex;align-items:baseline;gap:7px;min-width:0}
.osm-tagpop .hd b{font-size:12.5px;font-weight:700}
.osm-tagpop .hd .sub{font-family:var(--mono);font-size:10px;color:var(--ink3);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.osm-tagpop .chips{display:flex;flex-wrap:wrap;gap:4px}
.osm-tagpop .osm-none{font-size:11.5px;color:var(--ink3)}
.osm-tagpop input.tagin{border:1px solid var(--line);border-radius:5px;padding:6px 9px;font-family:var(--mono);
  font-size:12px;background:var(--sunk);color:var(--ink);width:100%}
.osm-tagpop input.tagin:focus{outline:2px solid var(--accent);outline-offset:1px}
.osm-chip{display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:9.5px;font-weight:700;
  letter-spacing:.02em;padding:2px 3px 2px 6px;border-radius:3px}
.osm-chip.det{background:var(--violet-soft);color:var(--violet);border:1px solid transparent}
.osm-chip.cust{background:var(--accent-soft);color:var(--accent);border:1px dashed var(--accent)}
.osm-chip[data-busy="1"]{opacity:.45}
.osm-chip .x{border:0;background:none;color:inherit;font-size:9px;line-height:1;padding:2px 3px;border-radius:2px;
  opacity:.6;cursor:pointer}
.osm-chip .x:hover{opacity:1;background:rgba(127,127,127,.22)}
.osm-sug{display:flex;flex-direction:column;gap:1px;max-height:154px;overflow:auto}
.osm-sug.hidden{display:none}
.osm-sug button{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:5px 8px;
  border-radius:4px;font-size:12.5px;color:var(--ink2);font-family:var(--mono)}
.osm-sug button:hover{background:var(--sunk)}
.osm-sug button.cur{background:var(--accent-soft);color:var(--accent)}
.osm-sug .n{font-size:9.5px;color:var(--ink3)}
.osm-note{font-size:11.5px;color:var(--ink3);min-height:16px;overflow-wrap:anywhere}
.osm-note.bad{color:var(--crit)}
.osm-legend{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:10.5px;color:var(--ink3);
  border-top:1px solid var(--line);padding-top:7px}

/* --- row tags: the ✕ is the affordance, custom tags read as yours --- */
#rows .tag::after{content:"✕";margin-left:4px;font-size:8px;opacity:.4}
#rows .tag:hover::after{opacity:1}
.t-cust{background:var(--accent-soft);color:var(--accent);border:1px dashed var(--accent)}
.tag-add{border-style:dashed}
.tag-add::after{content:none}

/* --- detail panel tags block --- */
.osm-tagline{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:5px}

/* --- comments --- */
#pane-comments .cbox{align-items:flex-start}
#pane-comments textarea.fld{flex:1;min-width:0;min-height:54px;resize:vertical;font-family:inherit;font-size:12.5px;
  line-height:1.5;border:1px solid var(--line);border-radius:5px;padding:7px 10px;background:var(--panel);color:var(--ink)}
#pane-comments .chint{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px;font-size:11px;color:var(--ink3)}
#pane-comments .chint kbd{font-size:9px}
.det .stream{gap:5px}
.det .ci{border-radius:0 5px 5px 0}
.det .ci .bd{white-space:pre-wrap}
.det .ci.e{background:transparent;border-left-style:dashed}
.det .ci.u{box-shadow:inset 0 0 0 1px rgba(127,127,127,.15)}
.det .ci .ic{font-family:var(--mono);font-size:10.5px;margin-right:5px;opacity:.8}
.dtab em.hot{color:var(--accent)}
.dtab em.cold{color:var(--ink3)}
`;

/** Idempotent: safe to call from every entry point. */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    startRelClock();
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  startRelClock();
}
