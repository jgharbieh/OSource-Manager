// Detail panel: tabs (Details/Readme/Changelog/Run/Log/Comments), comment stream,
// auto-update toggle, and the Phase-3/4 actions. Changelog/Run/Log are live
// read-only panels; Readme remains an honest phase placeholder.
import { getMcpTargets, getTool, getTrialLogs, getTrialPlan, getUpstream, patchTool, postComment, type Op } from './api.js';
import { state, handlers } from './state.js';
import { menuItems, runAction, stateChips } from './manage.js';
import { tryFlow } from './actions.js';
import { $, esc, errToast, fmtStamp, repoWebUrl, toast } from './util.js';
import type { Comment, Installation } from '../../core/types.js';
import type { UpstreamResult } from '../../core/github.js';
import type { TrialPlan } from '../../core/preview.js';
import type { TrialLogs } from '../../core/trial.js';
import type { TargetStatus } from '../../core/registrar.js';
import type { ToolDetail } from './api.js';

let current: ToolDetail | null = null;

function renderHead(t: ToolDetail): void {
  const chips = stateChips(t)
    .map((c) => `<span class="chip ${c.cls}">${esc(c.label)}</span>`)
    .join('');
  $('#det-head').innerHTML = `${esc(t.name)} ${chips}`;
}

function renderDetails(t: ToolDetail): void {
  const web = repoWebUrl(t.canonical_key);
  const installs = t.installations.length
    ? t.installations.map((i: Installation) => esc(i.where_) + (i.version_local ? ` <span style="color:var(--ink3)">(${esc(i.version_local)})</span>` : '')).join('<br>')
    : '<span style="color:var(--ink3)">not found on disk</span>';
  const rows: Array<[string, string]> = [
    ['upstream', web ? `<a href="${esc(web)}" target="_blank" rel="noopener">${esc(t.canonical_key)}</a>` : esc(t.canonical_key)],
    ['kind', esc(t.kind)],
    ['on disk', installs],
    ['added', esc(fmtStamp(t.added_at))],
    ['checked', esc(fmtStamp(t.observations?.upstream_checked_at ?? null))],
  ];
  if (t.source) rows.push(['source', esc(t.source)]);
  if (t.verdict === 'retired' && t.retire_reason) rows.push(['retired', esc(t.retire_reason)]);
  let html = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  if (t.why_i_want_it) {
    html += `<div class="notes"><b>Your note:</b> ${esc(t.why_i_want_it)}</div>`;
  }
  $('#pane-details').innerHTML = html;
}

function renderComments(t: ToolDetail): void {
  $('#ccount').textContent = String(t.comments.length);
  const items = [...t.comments].sort((a, b) => b.created_at.localeCompare(a.created_at));
  $('#cstream').innerHTML =
    items
      .map((c: Comment) => {
        const user = c.kind === 'user';
        return `<div class="ci ${user ? 'u' : 'e'}"><div class="ch"><b>${user ? 'you' : 'event'}</b><span class="ct">${esc(fmtStamp(c.created_at))}</span></div>${esc(c.body)}</div>`;
      })
      .join('') || `<div class="placeholder" style="padding:10px 2px">No comments yet — the journal starts when you say something.</div>`;
}

/** Same action set as the row Actions ▾ menu — one definition, two surfaces. */
function renderActions(t: ToolDetail): void {
  $('#det-acts').innerHTML = menuItems(t)
    .map((it) =>
      it.on
        ? `<button class="btn${it.danger === true ? ' danger' : ''}" data-act="${esc(it.act)}" title="${esc(it.hint)}">${esc(it.label)}</button>`
        : `<button class="btn" disabled title="${esc(it.hint)}">${esc(it.label)}</button>`,
    )
    .join('');
}

/** Detected agents, filled in once per panel open. Read-only detection. */
function renderTargets(targets: TargetStatus[] | null, message: string): void {
  const el = document.querySelector('#det-targets');
  if (!el) return;
  if (targets === null) {
    el.innerHTML = `<div class="viadock" style="margin:6px 0 0"><span>⎈</span><span>${esc(message)}</span></div>`;
    return;
  }
  el.innerHTML = `<dl class="kv" style="margin-top:5px">${targets
    .map((x) => `<dt>${x.can_register ? '✓' : '·'} ${esc(x.id)}</dt><dd>${esc(x.detail)}</dd>`)
    .join('')}</dl>`;
}

function renderAside(t: ToolDetail): void {
  $('#det-aside').innerHTML = `
    <div>
      <span class="lbl">Serve as MCP — where OSM can write</span>
      <div id="det-targets"><div class="viadock" style="margin:6px 0 0"><span>⎈</span><span>detecting agents…</span></div></div>
    </div>
    <div>
      <span class="lbl">Installations</span>
      <dl class="kv" style="margin-top:5px">
        ${
          t.installations.length
            ? t.installations
                .map(
                  (i: Installation) =>
                    `<dt>${i.present ? 'seen' : 'gone'}</dt><dd>${esc(i.where_)}${i.version_local ? ` · ${esc(i.version_local)}` : ''}</dd>`,
                )
                .join('')
            : '<dt>—</dt><dd>none observed</dd>'
        }
      </dl>
    </div>
    <div>
      <span class="lbl">Observed</span>
      <dl class="kv" style="margin-top:5px">
        <dt>serving</dt><dd>×${t.observations?.serving_count ?? 0}</dd>
        <dt>trial</dt><dd>${t.observations?.trial_running ? 'running' : 'no'}</dd>
        <dt>upstream</dt><dd>${esc(t.observations?.version_upstream ?? '—')}</dd>
      </dl>
    </div>`;
}

function renderAutoUpdate(t: ToolDetail): void {
  $('#autoupd').setAttribute('aria-pressed', t.auto_update === 1 ? 'true' : 'false');
}

/* ---------- Phase 2 tabs: Changelog (upstream check) & Run (trial plan) ---------- */

function localVersionOf(t: ToolDetail): string | null {
  for (const i of t.installations) {
    if (i.present === 1 && i.version_local) return i.version_local;
  }
  return null;
}

function renderChangelog(res: Op<UpstreamResult>, t: ToolDetail): void {
  const el = $('#changelog-body');
  el.className = '';
  if (!res.ok || !res.data) {
    el.className = 'placeholder';
    el.textContent = res.message; // e.g. rate limit with reset time, 'unsupported host'
    return;
  }
  const d = res.data;
  const badge = d.update_available
    ? '<span class="chip c-warn">update available</span>'
    : '<span class="chip c-mut">no update</span>';
  const local = localVersionOf(t);
  let html = `<div style="margin:8px 0 10px">
    <span class="m">${esc(local ?? 'not installed')}</span>
    <span style="color:var(--ink3)"> → </span>
    <span class="m">${esc(d.version_upstream ?? 'none upstream')}</span>
    ${badge}
  </div>`;
  if (!d.history_complete) {
    // Honest amber notice — never pass a partial release list off as a changelog.
    html += `<div class="warn-box" style="margin-bottom:10px">History incomplete — your installed version was not found in the fetched releases, so a real changelog cannot be assembled. The list below is the newest releases, not "what changed since your version".</div>`;
  }
  if (d.releases.length === 0) {
    html += `<div class="placeholder" style="padding:10px 2px">${d.history_complete ? 'Nothing newer than your version.' : 'No releases to show.'}</div>`;
  } else {
    html += d.releases
      .map(
        (r) => `<div class="ci"><div class="ch"><b>${esc(r.tag)}</b>${r.name && r.name !== r.tag ? ` ${esc(r.name)}` : ''}<span class="ct">${esc(fmtStamp(r.published_at))}</span></div>${esc(r.body_excerpt)}</div>`,
      )
      .join('');
  }
  if (d.rate_limit_remaining !== null) {
    html += `<div class="lbl" style="margin-top:10px;text-transform:none">github rate limit remaining: ${d.rate_limit_remaining}</div>`;
  }
  el.innerHTML = html;
}

function renderRun(res: Op<TrialPlan>): void {
  const el = $('#run-body');
  el.className = '';
  if (!res.ok || !res.data) {
    el.className = 'placeholder';
    el.textContent = res.message;
    return;
  }
  const d = res.data;
  const cmd = `docker run ${d.argv.join(' ')}`;
  let html = `<div class="notes" style="margin:8px 0 10px">Planned from <b>${esc(d.source)}</b> — read from the repo, not typed by you. Nothing has run.</div>`;
  if (d.argv.length > 0) {
    html += `<pre style="background:var(--sunk);padding:9px 11px;border-radius:5px;overflow-x:auto;margin:0 0 6px"><code style="background:none;padding:0">${esc(cmd)}</code></pre>
      <button class="btn gho" id="runcopy" style="margin-bottom:10px">copy command</button>`;
    if (d.ok_to_run) {
      html += ` <button class="btn pri" id="runit" style="margin-bottom:10px">Run it in Docker…</button>`;
    }
  }
  if (d.refusals.length > 0) {
    html += d.refusals
      .map((r) => `<div class="ci" style="border-left-color:var(--crit);color:var(--crit)">${esc(r)}</div>`)
      .join('');
  }
  if (d.flag_explanations.length > 0) {
    html += `<span class="lbl" style="display:block;margin:10px 0 4px">what each part does</span>`;
    html += d.flag_explanations
      .map((f) => `<div class="ci"><b style="font-family:var(--mono);font-size:11px">${esc(f.flag)}</b> — ${esc(f.meaning)}</div>`)
      .join('');
  }
  el.innerHTML = html;
  if (d.argv.length > 0) {
    $('#runcopy').addEventListener('click', () => {
      void navigator.clipboard
        .writeText(cmd)
        .then(() => toast('command copied — review it; nothing ran'))
        .catch(() => window.prompt('Copy command:', cmd));
    });
  }
  $('#runit')?.addEventListener('click', () => {
    if (current) void tryFlow(current);
  });
}

function renderLog(res: Op<TrialLogs>): void {
  const el = $('#log-body');
  el.className = '';
  if (!res.ok || !res.data) {
    el.className = 'placeholder';
    el.textContent = res.message; // 'no trial recorded', 'docker is not available', …
    return;
  }
  const d = res.data;
  const body = d.logs.trim() === '' ? '(the container has produced no output yet)' : d.logs;
  el.innerHTML = `<div class="notes" style="margin:8px 0 8px">last ${d.tail} line(s) of <b>${esc(d.container)}</b></div>
    <pre style="background:var(--sunk);padding:9px 11px;border-radius:5px;overflow:auto;max-height:320px;margin:0"><code style="background:none;padding:0">${esc(body)}</code></pre>`;
}

/** Load the lazily-fetched tab bodies. Each open re-checks live. */
function loadLazyTab(pane: string, id: number): void {
  if (pane === 'changelog') {
    $('#changelog-body').className = 'placeholder';
    $('#changelog-body').textContent = 'checking upstream…';
    void getUpstream(id)
      .then((res) => {
        if (state.selectedId === id && current) renderChangelog(res, current);
      })
      .catch((e) => {
        if (state.selectedId !== id) return;
        $('#changelog-body').className = 'placeholder';
        $('#changelog-body').textContent = e instanceof Error ? e.message : String(e);
      });
    return;
  }
  if (pane === 'run') {
    $('#run-body').className = 'placeholder';
    $('#run-body').textContent = 'planning trial run…';
    void getTrialPlan(id)
      .then((res) => {
        if (state.selectedId === id) renderRun(res);
      })
      .catch((e) => {
        if (state.selectedId !== id) return;
        $('#run-body').className = 'placeholder';
        $('#run-body').textContent = e instanceof Error ? e.message : String(e);
      });
    return;
  }
  if (pane === 'log') {
    $('#log-body').className = 'placeholder';
    $('#log-body').textContent = 'reading the trial container log…';
    void getTrialLogs(id)
      .then((res) => {
        if (state.selectedId === id) renderLog(res);
      })
      .catch((e) => {
        if (state.selectedId !== id) return;
        $('#log-body').className = 'placeholder';
        $('#log-body').textContent = e instanceof Error ? e.message : String(e);
      });
  }
}

let cachedTargets: TargetStatus[] | null = null;

/** Detection is machine-wide, not per-tool, so it is fetched once per page. */
function loadTargets(): void {
  if (cachedTargets !== null) {
    renderTargets(cachedTargets, '');
    return;
  }
  void getMcpTargets()
    .then((res) => {
      if (res.ok && res.data) {
        cachedTargets = res.data;
        renderTargets(res.data, '');
      } else {
        renderTargets(null, res.message);
      }
    })
    .catch((e) => renderTargets(null, e instanceof Error ? e.message : String(e)));
}

function activePane(): string {
  return (document.querySelector('.dtab.on') as HTMLElement | null)?.dataset.p ?? 'details';
}

function renderAll(t: ToolDetail): void {
  renderHead(t);
  renderDetails(t);
  renderComments(t);
  renderActions(t);
  renderAside(t);
  loadTargets();
  renderAutoUpdate(t);
}

export function show(id: number): void {
  state.selectedId = id;
  $('#det').classList.remove('hidden');
  $('#det-head').textContent = 'Loading…';
  void (async () => {
    try {
      current = await getTool(id);
      if (state.selectedId !== id) return; // selection moved on
      renderAll(current);
      loadLazyTab(activePane(), id); // re-fetch if a lazy tab is the active one
    } catch (e) {
      errToast(e);
    }
  })();
}

export function close(): void {
  state.selectedId = null;
  current = null;
  $('#det').classList.add('hidden');
}

export function initDetail(): void {
  // Close: routed through handlers.closeDetail so the panel is parked back at
  // its markup home and the empty .detrow is dropped on the next re-render.
  $('#det-close').addEventListener('click', () => handlers.closeDetail?.());

  // tab switching
  $('#dtabs').addEventListener('click', (e) => {
    const dt = (e.target as Element | null)?.closest('.dtab');
    if (!dt || !(dt instanceof HTMLElement) || !dt.dataset.p) return;
    document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('on', x === dt));
    for (const p of ['details', 'readme', 'changelog', 'run', 'log', 'comments']) {
      $('#pane-' + p).classList.toggle('hidden', p !== dt.dataset.p);
    }
    if (current) loadLazyTab(dt.dataset.p, current.id);
  });

  // Action buttons — delegated because #det-acts is re-rendered on every open.
  // Same menuItems()/runAction() pair the row menu uses: one action set, two
  // surfaces, no chance of the panel offering something the row does not.
  $('#det-acts').addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest('[data-act]');
    if (!btn || !(btn instanceof HTMLElement) || !btn.dataset.act || !current) return;
    runAction(btn.dataset.act, current);
  });

  // auto-update toggle (per-row, owned field)
  $('#autoupd').addEventListener('click', () => {
    if (!current) return;
    const next = current.auto_update !== 1;
    void (async () => {
      try {
        await patchTool(current!.id, { auto_update: next });
        current!.auto_update = next ? 1 : 0;
        renderAutoUpdate(current!);
        toast(next ? 'Auto update ON — tracks latest on every refresh' : 'Auto update OFF (default) — you approve each one');
      } catch (e) {
        errToast(e);
      }
    })();
  });

  // post a comment (button + Enter)
  const post = (): void => {
    if (!current) return;
    const input = $('#cin') as HTMLInputElement;
    const body = input.value.trim();
    if (!body) return;
    void (async () => {
      try {
        await postComment(current!.id, body);
        input.value = '';
        const fresh = await getTool(current!.id);
        if (state.selectedId === fresh.id) {
          current = fresh;
          renderComments(fresh);
        }
      } catch (e) {
        errToast(e);
      }
    })();
  };
  $('#cpost').addEventListener('click', post);
  ($('#cin') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') post();
  });
}
