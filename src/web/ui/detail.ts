// Detail panel: tabs (Details/Readme/Changelog/Run/Log/Comments), the comments
// journal, tags, the auto-update toggle and the Phase-3/4 actions.
//
// Three rules this file holds to:
//  1. No tab ever renders blank or with a bare sentence. Every state says what
//     is missing, why, and what to do next — see emptyState/errorState/noteState.
//  2. A failure inside a tab renders INSIDE that tab. A toast that disappears
//     after 2.6s is not a place to put an error someone has to act on.
//  3. Every action shows that it started. Buttons hold a pending state until
//     their flow finishes; the flow itself reports in its own dialog.
import {
  getMcpTargets,
  getReadme,
  getTool,
  getTrialLogs,
  getTrialPlan,
  getUpstream,
  patchTool,
  postComment,
  setUpstream,
  type Op,
} from './api.js';
import { state, handlers } from './state.js';
import { menuItems, stateChips } from './manage.js';
import { initTagging, openTagsFor, runFlow } from './actions.js';
import {
  $,
  $maybe,
  copyText,
  emptyState,
  ensureStyles,
  errorState,
  esc,
  errToast,
  fmtStamp,
  loadingState,
  looksBlocked,
  looksEmptyNotBroken,
  msgOf,
  noteState,
  repoWebUrl,
  timeHTML,
  toast,
  withPending,
} from './util.js';
import type { Comment, Installation, Tag } from '../../core/types.js';
import type { UpstreamResult } from '../../core/github.js';
import type { TrialPlan } from '../../core/preview.js';
import type { ReadmeDoc } from '../../core/readme.js';
import type { TrialLogs } from '../../core/trial.js';
import type { TargetStatus } from '../../core/registrar.js';
import type { ToolDetail } from './api.js';

let current: ToolDetail | null = null;

/** The action currently in flight, so a re-render keeps showing the pending state. */
let pendingAct: string | null = null;

const PANES = ['details', 'readme', 'changelog', 'run', 'log', 'comments'] as const;

/* ------------------------------------------------------------------ */
/* head + details                                                      */
/* ------------------------------------------------------------------ */

function renderHead(t: ToolDetail): void {
  const chips = stateChips(t)
    .map((c) => `<span class="chip ${c.cls}">${esc(c.label)}</span>`)
    .join('');
  $('#det-head').innerHTML = `${esc(t.name)} ${chips}`;
}

function renderDetails(t: ToolDetail): void {
  const web = repoWebUrl(t.canonical_key);
  const installs = t.installations.length
    ? t.installations
        .map(
          (i: Installation) =>
            esc(i.where_) + (i.version_local ? ` <span style="color:var(--ink3)">(${esc(i.version_local)})</span>` : ''),
        )
        .join('<br>')
    : '<span style="color:var(--ink3)">not found on disk</span>';
  // Discovery guesses identity from disk and gets it wrong for a repo that
  // arrived without a git remote. The fix has to live where the wrong value is
  // shown, not in a settings screen.
  const fixBtn = `<button class="mini" id="det-setup" title="Point this row at its real repo">${web ? 'change' : 'set upstream…'}</button>`;
  const rows: Array<[string, string]> = [
    [
      'upstream',
      (web ? `<a href="${esc(web)}" target="_blank" rel="noopener">${esc(t.canonical_key)}</a>` : esc(t.canonical_key)) +
        ` ${fixBtn}`,
    ],
    ['kind', esc(t.kind)],
    ['on disk', installs],
    ['added', `${timeHTML(t.added_at)} <span style="color:var(--ink3)">${esc(fmtStamp(t.added_at))}</span>`],
    ['checked', t.observations?.upstream_checked_at ? timeHTML(t.observations.upstream_checked_at) : '<span style="color:var(--ink3)">never</span>'],
  ];
  if (t.source) rows.push(['source', esc(t.source)]);
  if (t.verdict === 'retired' && t.retire_reason) rows.push(['retired', esc(t.retire_reason)]);
  let html = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  html += t.why_i_want_it
    ? `<div class="notes"><b>Your note:</b> ${esc(t.why_i_want_it)}</div>`
    : `<div class="notes" style="border-left-color:var(--line)"><b>No "why" recorded.</b> Add one in Comments — the shelf is only useful if a six-month-old row can explain itself.</div>`;
  $('#pane-details').innerHTML = html;
  $maybe('#det-setup')?.addEventListener('click', () => void askUpstream(t));
}

/** Prompt for the real repo URL and repoint the row. */
async function askUpstream(t: ToolDetail): Promise<void> {
  const guess = repoWebUrl(t.canonical_key) || '';
  const url = window.prompt(
    `Upstream repo for ${t.name}\n\nPaste the repo URL. The old key is kept as an alias, so nothing is lost and the row keeps its tags, note and journal.`,
    guess,
  );
  if (url === null || url.trim() === '') return;
  try {
    const res = await setUpstream(t.id, url.trim());
    toast(res.message);
    if (res.ok) await handlers.reload?.();
  } catch (e) {
    errToast(e);
  }
}

/* ------------------------------------------------------------------ */
/* comments — the journal                                              */
/* ------------------------------------------------------------------ */

/** Give an auto-journal line a face, so the stream scans as a timeline rather
 *  than a wall of identical grey rows. Classification only — never rewording. */
function eventKind(body: string): { icon: string; label: string } {
  const l = body.toLowerCase();
  if (l.startsWith('retired')) return { icon: '⏹', label: 'retired' };
  if (/tore down|torn down|tear down|teardown/.test(l)) return { icon: '⏏', label: 'teardown' };
  if (/trial/.test(l)) return { icon: '▶', label: 'trial' };
  if (/unregister/.test(l)) return { icon: '⎈', label: 'unregistered' };
  if (/register/.test(l)) return { icon: '⎈', label: 'registered' };
  if (/updated|fast-forward/.test(l)) return { icon: '↑', label: 'update' };
  if (/upstream/.test(l)) return { icon: '◇', label: 'upstream' };
  if (/tracked|imported|discovered|added/.test(l)) return { icon: '＋', label: 'tracked' };
  if (/tag/.test(l)) return { icon: '#', label: 'tag' };
  return { icon: '·', label: 'event' };
}

function renderComments(t: ToolDetail): void {
  const mine = t.comments.filter((c) => c.kind === 'user').length;
  const events = t.comments.length - mine;

  const badge = $maybe('#ccount');
  if (badge) {
    badge.textContent = String(t.comments.length);
    badge.className = t.comments.length > 0 ? 'hot' : 'cold';
    badge.title = `${mine} from you · ${events} journal event(s)`;
  }

  // Newest first: the last thing that happened is the thing being looked for.
  const items = [...t.comments].sort((a, b) => b.created_at.localeCompare(a.created_at));
  $('#cstream').innerHTML =
    items
      .map((c: Comment) => {
        if (c.kind === 'user') {
          return `<div class="ci u"><div class="ch"><b>you</b>${timeHTML(c.created_at, 'ct')}</div><div class="bd">${esc(c.body)}</div></div>`;
        }
        const k = eventKind(c.body);
        return `<div class="ci e"><div class="ch"><b><span class="ic">${esc(k.icon)}</span>${esc(k.label)}</b>${timeHTML(c.created_at, 'ct')}</div><div class="bd">${esc(c.body)}</div></div>`;
      })
      .join('') ||
    emptyState({
      title: 'Nothing in this journal yet',
      detail:
        'Every mutation OSM performs lands here automatically — tracked, trial started, updated vX→vY, registered, retired with its reason — and your own notes interleave with them in one timeline. It is the only thing that will remember why you kept this six months from now. Write the first line.',
    });
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

/** Same action set as the row Actions ▾ menu — one definition, two surfaces. */
function renderActions(t: ToolDetail): void {
  $('#det-acts').innerHTML = menuItems(t)
    .map((it) => {
      const busy = pendingAct === it.act;
      const disabled = !it.on || pendingAct !== null;
      const label = busy ? `${it.label} …` : it.label;
      const cls = `btn${it.danger === true ? ' danger' : ''}`;
      return disabled
        ? `<button class="${cls}" disabled${busy ? ' data-pending="1"' : ''} title="${esc(busy ? 'running…' : pendingAct !== null ? 'another action is running' : it.hint)}">${esc(label)}</button>`
        : `<button class="${cls}" data-act="${esc(it.act)}" title="${esc(it.hint)}">${esc(label)}</button>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* aside: tags, agents, installations, observations                    */
/* ------------------------------------------------------------------ */

function tagChipsHTML(tags: Tag[]): string {
  if (tags.length === 0) return `<span style="font-size:11.5px;color:var(--ink3)">none yet</span>`;
  return tags
    .map((x) => {
      const own = x.detected === 0;
      return `<span class="osm-chip ${own ? 'cust' : 'det'}" title="${own ? 'your tag' : 'detected by the scanner'}">${esc(x.tag)}</span>`;
    })
    .join('');
}

/** Detected agents, filled in once per panel open. Read-only detection. */
function renderTargets(targets: TargetStatus[] | null, message: string): void {
  const el = $maybe('#det-targets');
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
      <span class="lbl">Tags — dashed are yours</span>
      <div class="osm-tagline" id="det-tags">
        ${tagChipsHTML(t.tags)}
        <button class="tag-add" id="det-tagadd" title="Add or remove tags">+ tag</button>
      </div>
    </div>
    <div>
      <span class="lbl">Serve as MCP — where OSM can write</span>
      <div id="det-targets">${loadingState('detecting agents…')}</div>
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
            : '<dt>—</dt><dd>none observed — tracked only, nothing on this disk</dd>'
        }
      </dl>
    </div>
    <div>
      <span class="lbl">Observed</span>
      <dl class="kv" style="margin-top:5px">
        <dt>serving</dt><dd>×${t.observations?.serving_count ?? 0}</dd>
        <dt>trial</dt><dd>${t.observations?.trial_running ? 'running' : 'not running'}</dd>
        <dt>upstream</dt><dd>${esc(t.observations?.version_upstream ?? '—')}</dd>
      </dl>
    </div>`;
}

function renderAutoUpdate(t: ToolDetail): void {
  $('#autoupd').setAttribute('aria-pressed', t.auto_update === 1 ? 'true' : 'false');
}

/* ------------------------------------------------------------------ */
/* Readme                                                              */
/* ------------------------------------------------------------------ */

/** Rendered README, images and video embeds included. GitHub renders the
 *  markdown for us (see core/readme.ts) — this only frames it. */
function renderReadme(res: Op<ReadmeDoc>, t: ToolDetail): void {
  const web = repoWebUrl(t.canonical_key);
  const disk = t.installations.find((i) => i.present === 1 && /[\\/]/.test(i.where_));
  const setLabel = (source: string): void => {
    $('#readme-lbl').innerHTML =
      `README — ${esc(source)}${web ? ` · <a href="${esc(web)}#readme" target="_blank" rel="noopener">open upstream ↗</a>` : ''}`;
  };

  if (!res.ok || !res.data) {
    const actions = [
      ...(web ? [{ id: 'rm-open', label: 'Read it upstream ↗', primary: true, href: `${web}#readme` }] : []),
      ...(disk ? [{ id: 'rm-copy', label: 'Copy the local path' }] : []),
      { id: 'rm-retry', label: 'Try again' },
    ];
    const body = looksEmptyNotBroken(res.message)
      ? emptyState({
          title: web ? 'No README to read' : 'No README — and nowhere to look for one',
          detail: web
            ? res.message
            : `${t.name} has no upstream repository on record (kind: ${t.kind}, key: ${t.canonical_key}), and no checkout on this disk. Set its upstream in Details and this tab starts working.`,
          actions,
        })
      : errorState({ title: 'Could not load the README', detail: res.message, actions });
    setLabel('not loaded');
    setBody('#readme-body', body);
    if (disk) {
      // `skills-dir:` is OSM's scan-source prefix, not part of the path.
      const path = disk.where_.startsWith('skills-dir:') ? disk.where_.slice('skills-dir:'.length) : disk.where_;
      $maybe('#rm-copy')?.addEventListener('click', () => void copyText(path, 'path copied'));
    }
    wireRetry('rm-retry', () => loadLazyTab('readme', t.id));
    return;
  }

  const d = res.data;
  // format:'html' is GitHub's own rendered output, re-sanitized server-side.
  // format:'text' is a raw local file and MUST be escaped.
  const inner = d.format === 'html' ? d.body : `<pre class="md-raw">${esc(d.body)}</pre>`;
  const note = d.truncated
    ? `<div class="notes" style="border-left-color:var(--warn)"><b>Truncated.</b> This README is larger than OSM renders inline — read the full one upstream.</div>`
    : '';
  setLabel(d.source);
  setBody('#readme-body', `<div class="md-body">${inner}</div>${note}`);
  hideDeadImages();
}

/** A badge whose host stopped serving it (dead shields.io, expired CDN, a camo
 *  URL GitHub itself 502s) would otherwise sit in the middle of a paragraph as a
 *  broken-image glyph. No inline onerror — those are stripped server-side. */
function hideDeadImages(): void {
  document.querySelectorAll('#readme-body img').forEach((img) => {
    if (!(img instanceof HTMLImageElement)) return;
    if (img.complete && img.naturalWidth === 0) {
      img.classList.add('dead');
      return;
    }
    img.addEventListener('error', () => img.classList.add('dead'), { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* Changelog                                                           */
/* ------------------------------------------------------------------ */

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
    el.innerHTML = tabFailure(res.message, {
      emptyTitle: 'No upstream to check',
      emptyDetail: `OSM only reads releases from github.com repositories. ${t.name} (${t.canonical_key}) is not one, so there is no changelog to assemble.`,
      blockedTitle: 'Could not reach GitHub',
      errorTitle: 'The upstream check failed',
      retryId: 'cl-retry',
    });
    wireRetry('cl-retry', () => loadLazyTab('changelog', t.id));
    return;
  }
  const d = res.data;
  const local = localVersionOf(t);
  const badge = d.update_available
    ? '<span class="chip c-warn">update available</span>'
    : '<span class="chip c-mut">no update</span>';
  let html = `<div style="margin:8px 0 10px">
    <span class="m">${esc(local ?? 'not installed')}</span>
    <span style="color:var(--ink3)"> → </span>
    <span class="m">${esc(d.version_upstream ?? 'none upstream')}</span>
    ${badge}
  </div>`;

  if (local === null) {
    // history_complete is false here by construction — but "incomplete" is the
    // wrong word for it: there is simply no local version to diff from.
    html += noteState({
      title: 'Nothing installed locally to compare against',
      detail: `A changelog is "what changed since your version", and there is no version of ${t.name} on this disk. The latest published release upstream is ${d.version_upstream ?? 'none'}.`,
    });
  } else if (!d.history_complete && d.version_upstream !== null) {
    // Only meaningful when there IS a release history to be incomplete. A repo
    // with zero releases is an empty state, not a warning.
    html += noteState({
      title: 'History incomplete',
      detail: `Your installed version (${local}) was not found in the releases GitHub returned, so a real "since your version" changelog cannot be assembled. Anything listed below is simply the newest releases — do not read it as the diff from what you are running.`,
    });
  }

  if (d.releases.length === 0) {
    if (local !== null && d.history_complete) {
      html += emptyState({
        title: d.version_upstream === null ? 'No releases found' : 'Up to date',
        detail:
          d.version_upstream === null
            ? `${t.canonical_key} has never published a GitHub Release, so there is no release history to read. Commits are not a substitute — they carry no version correspondence.`
            : `Nothing has been published after ${local}. Re-check any time; the result is ETag-cached, so an unchanged repo costs nothing.`,
        actions: [{ id: 'cl-again', label: 'Check again' }],
      });
    } else if (d.version_upstream === null) {
      html += emptyState({
        title: 'No releases found',
        detail: `${t.canonical_key} has never published a GitHub Release.`,
        actions: [{ id: 'cl-again', label: 'Check again' }],
      });
    }
  } else {
    html += d.releases
      .map(
        (r) =>
          `<div class="ci"><div class="ch"><b>${esc(r.tag)}</b>${r.name && r.name !== r.tag ? ` ${esc(r.name)}` : ''}${timeHTML(r.published_at, 'ct')}</div><div class="bd">${esc(r.body_excerpt) || '<span style="color:var(--ink3)">(no release notes)</span>'}</div></div>`,
      )
      .join('');
  }
  const foot: string[] = [];
  if (/not modified/i.test(res.message)) foot.push('unchanged since the last check (ETag match)');
  if (d.rate_limit_remaining !== null) foot.push(`github rate limit remaining: ${d.rate_limit_remaining}`);
  if (foot.length > 0) {
    html += `<div class="lbl" style="margin-top:10px;text-transform:none">${esc(foot.join(' · '))}</div>`;
  }
  el.innerHTML = html;
  wireRetry('cl-again', () => loadLazyTab('changelog', t.id));
}

/* ------------------------------------------------------------------ */
/* Run (trial plan)                                                    */
/* ------------------------------------------------------------------ */

function renderRun(res: Op<TrialPlan>, t: ToolDetail): void {
  const el = $('#run-body');
  el.className = '';
  if (!res.ok || !res.data) {
    el.innerHTML = tabFailure(res.message, {
      emptyTitle: 'No run instructions in this repo',
      emptyDetail: `OSM reads README.md, docker-compose.yml and Dockerfile for a docker run it could reproduce — ${t.name} has none it can parse, so there is nothing to plan. Planning never guesses a command.`,
      blockedTitle: 'Cannot plan a run right now',
      errorTitle: 'Planning the trial failed',
      retryId: 'run-retry',
    });
    wireRetry('run-retry', () => loadLazyTab('run', t.id));
    return;
  }
  const d = res.data;
  const cmd = `docker run ${d.argv.join(' ')}`;
  let html = `<div class="notes" style="margin:8px 0 10px">Planned from <b>${esc(d.source)}</b> — read from the repo, not typed by you. Nothing has run.</div>`;
  if (d.argv.length > 0) {
    html += `<pre class="osm-pre">${esc(cmd)}</pre>
      <div class="osm-state" style="border:0;background:none;padding:8px 0 0;margin:0">
        <span class="row" style="margin:0">
          <button class="btn gho" id="runcopy">copy command</button>
          ${d.ok_to_run ? `<button class="btn pri" id="runit">Run it in Docker…</button>` : ''}
        </span>
      </div>`;
  }
  if (d.refusals.length > 0) {
    // ok_to_run true with refusals means flags were DROPPED and the rest still
    // runs. Calling that "refused" would be a lie about the command above it.
    const body = `<pre class="osm-pre" style="margin-top:4px">${esc(d.refusals.map((r) => `• ${r}`).join('\n'))}</pre>`;
    html += d.ok_to_run
      ? noteState({
          title: 'Parts of the repo’s command were dropped',
          detail:
            'Repo instructions are untrusted input, so only an allowlisted set of docker flags gets through. What is listed below was removed; the command above is what would actually run.',
          html: body,
        })
      : errorState({
          title: 'Refused — this plan will not be run',
          detail:
            'Repo instructions are untrusted input. Only an allowlisted set of docker flags gets through, and these could not be made safe, so nothing here is runnable.',
          html: body,
        });
  }
  if (d.flag_explanations.length > 0) {
    html += `<span class="lbl" style="display:block;margin:12px 0 4px">what each part does</span>`;
    html += d.flag_explanations
      .map(
        (f) =>
          `<div class="ci"><b style="font-family:var(--mono);font-size:11px">${esc(f.flag)}</b> — ${esc(f.meaning)}</div>`,
      )
      .join('');
  }
  if (d.argv.length === 0 && d.refusals.length === 0) {
    html += emptyState({
      title: 'Nothing to run',
      detail: `A plan was produced from ${d.source} but it contains no command. Nothing can be executed from it.`,
    });
  }
  el.innerHTML = html;

  if (d.argv.length > 0) {
    $maybe('#runcopy')?.addEventListener('click', () => void copyText(cmd, 'command copied — review it; nothing ran'));
  }
  const runBtn = $maybe('#runit');
  if (runBtn instanceof HTMLButtonElement) {
    runBtn.addEventListener('click', () => {
      void withPending(runBtn, 'starting…', async () => {
        await runFlow('try', t);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Log                                                                 */
/* ------------------------------------------------------------------ */

function renderLog(res: Op<TrialLogs>, t: ToolDetail): void {
  const el = $('#log-body');
  el.className = '';
  if (!res.ok || !res.data) {
    const running = t.observations?.trial_running === 1;
    el.innerHTML = tabFailure(res.message, {
      emptyTitle: running ? 'No log to read yet' : 'Not running — no trial on record',
      emptyDetail: running
        ? 'A trial is marked as running but its container produced no readable log.'
        : `${t.name} has never been started through OSM, so there is no container to tail. Actions ▾ → Try in Docker… plans one first and shows you the exact command before anything executes.`,
      blockedTitle: 'Docker is not answering',
      errorTitle: 'Reading the trial log failed',
      retryId: 'log-retry',
    });
    wireRetry('log-retry', () => loadLazyTab('log', t.id));
    return;
  }
  const d = res.data;
  const empty = d.logs.trim() === '';
  el.innerHTML =
    `<div class="notes" style="margin:8px 0 8px">last ${d.tail} line(s) of <b>${esc(d.container)}</b></div>` +
    (empty
      ? emptyState({
          title: 'The container has produced no output yet',
          detail: 'It is running, it just has not written anything to stdout or stderr. Re-read in a moment.',
          actions: [{ id: 'log-again', label: 'Re-read the log' }],
        })
      : `<pre class="osm-pre" style="max-height:320px">${esc(d.logs)}</pre>
         <div class="osm-state" style="border:0;background:none;padding:8px 0 0;margin:0"><span class="row" style="margin:0"><button class="btn gho" id="log-again">Re-read the log</button></span></div>`);
  wireRetry('log-again', () => loadLazyTab('log', t.id));
}

/* ------------------------------------------------------------------ */
/* shared tab-failure rendering                                        */
/* ------------------------------------------------------------------ */

interface FailureCopy {
  emptyTitle: string;
  emptyDetail: string;
  blockedTitle: string;
  errorTitle: string;
  retryId: string;
}

/**
 * One refusal string, three very different meanings. "no trial recorded" is an
 * empty state, "docker is not available" is the machine, and anything else is a
 * genuine failure — painting all three red teaches people to ignore red.
 */
function tabFailure(message: string, c: FailureCopy): string {
  if (looksEmptyNotBroken(message)) {
    return emptyState({
      title: c.emptyTitle,
      detail: c.emptyDetail,
      html: `<span class="d" style="font-family:var(--mono);font-size:11px">server said: ${esc(message)}</span>`,
    });
  }
  if (looksBlocked(message)) {
    return noteState({
      title: c.blockedTitle,
      detail: message,
      actions: [{ id: c.retryId, label: 'Try again' }],
    });
  }
  return errorState({
    title: c.errorTitle,
    detail: message,
    actions: [{ id: c.retryId, label: 'Try again' }],
  });
}

function wireRetry(id: string, fn: () => void): void {
  const btn = $maybe('#' + id);
  if (btn instanceof HTMLButtonElement) {
    btn.addEventListener('click', () => {
      void withPending(btn, 'checking…', async () => {
        fn();
        await Promise.resolve();
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* lazy tabs                                                           */
/* ------------------------------------------------------------------ */

/** Load the lazily-fetched tab bodies. Each open re-checks live. */
function loadLazyTab(pane: string, id: number): void {
  if (pane === 'readme') {
    setBody('#readme-body', loadingState('fetching the README from the repo — images and embeds included…'));
    void getReadme(id)
      .then((res) => {
        if (state.selectedId === id && current) renderReadme(res, current);
      })
      .catch((e) => tabCrash('#readme-body', id, 'Loading the README failed', e, () => loadLazyTab('readme', id)));
    return;
  }
  if (pane === 'changelog') {
    setBody('#changelog-body', loadingState('checking upstream — releases, paginated until your version is found…'));
    void getUpstream(id)
      .then((res) => {
        if (state.selectedId === id && current) renderChangelog(res, current);
      })
      .catch((e) => tabCrash('#changelog-body', id, 'The upstream check failed', e, () => loadLazyTab('changelog', id)));
    return;
  }
  if (pane === 'run') {
    setBody('#run-body', loadingState('reading README / compose / Dockerfile — nothing is executing…'));
    void getTrialPlan(id)
      .then((res) => {
        if (state.selectedId === id && current) renderRun(res, current);
      })
      .catch((e) => tabCrash('#run-body', id, 'Planning the trial failed', e, () => loadLazyTab('run', id)));
    return;
  }
  if (pane === 'log') {
    setBody('#log-body', loadingState('reading the trial container log…'));
    void getTrialLogs(id)
      .then((res) => {
        if (state.selectedId === id && current) renderLog(res, current);
      })
      .catch((e) => tabCrash('#log-body', id, 'Reading the trial log failed', e, () => loadLazyTab('log', id)));
  }
}

function setBody(sel: string, html: string): void {
  const el = $maybe(sel);
  if (!el) return;
  el.className = '';
  el.innerHTML = html;
}

/** A thrown request (server down, bad JSON) still belongs to the tab. */
function tabCrash(sel: string, id: number, title: string, e: unknown, retry: () => void): void {
  if (state.selectedId !== id) return;
  const rid = `${sel.replace(/\W/g, '')}-retry`;
  setBody(sel, errorState({ title, detail: msgOf(e), actions: [{ id: rid, label: 'Try again' }] }));
  wireRetry(rid, retry);
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
    .catch((e) => renderTargets(null, msgOf(e)));
}

function activePane(): string {
  return (document.querySelector('.dtab.on') as HTMLElement | null)?.dataset.p ?? 'details';
}

function activateTab(pane: string): void {
  document.querySelectorAll('.dtab').forEach((x) => {
    x.classList.toggle('on', x instanceof HTMLElement && x.dataset.p === pane);
  });
  for (const p of PANES) $('#pane-' + p).classList.toggle('hidden', p !== pane);
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

/* ------------------------------------------------------------------ */
/* open / close                                                        */
/* ------------------------------------------------------------------ */

/** The panel itself failed to load. Rendered in the panel, with a way back. */
function renderPanelError(id: number, message: string): void {
  const known = state.tools.find((t) => t.id === id);
  $('#det-head').innerHTML = `${esc(known?.name ?? `tool ${id}`)} <span class="chip c-crit">could not load</span>`;
  $('#det-acts').innerHTML = '';
  $('#det-aside').innerHTML = '';
  activateTab('details');
  $('#pane-details').innerHTML = errorState({
    title: 'This tool would not load',
    detail: message,
    actions: [{ id: 'det-retry', label: 'Try again', primary: true }],
  });
  const btn = $maybe('#det-retry');
  if (btn instanceof HTMLButtonElement) {
    btn.addEventListener('click', () => {
      void withPending(btn, 'retrying…', async () => {
        show(id);
        await Promise.resolve();
      });
    });
  }
}

export function show(id: number): void {
  state.selectedId = id;
  $('#det').classList.remove('hidden');
  $('#det-head').textContent = 'Loading…';
  void (async () => {
    try {
      const fresh = await getTool(id);
      if (state.selectedId !== id) return; // selection moved on
      current = fresh;
      renderAll(fresh);
      loadLazyTab(activePane(), id); // re-fetch if a lazy tab is the active one
    } catch (e) {
      if (state.selectedId !== id) return;
      current = null;
      renderPanelError(id, msgOf(e));
    }
  })();
}

export function close(): void {
  state.selectedId = null;
  current = null;
  $('#det').classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

/**
 * The comments pane is rebuilt here rather than edited in index.html: it needs
 * a textarea (a comment is not a single line), a keyboard hint and a stream
 * container, and this module is what keeps them in sync.
 */
function buildCommentsPane(): void {
  $('#pane-comments').innerHTML = `
    <span class="lbl">Comments — why, over time</span>
    <div class="cbox" style="margin-top:6px">
      <textarea class="fld" id="cin" rows="2" placeholder="Why does this matter? What did you find? What would make you drop it?" aria-label="Add a comment"></textarea>
      <button class="btn pri" id="cpost">Post</button>
    </div>
    <div class="chint">
      <span><kbd>Ctrl</kbd><kbd>↵</kbd> posts</span>
      <span>newest first · your notes and OSM's own events share one timeline</span>
    </div>
    <div class="stream" id="cstream"></div>`;
}

export function initDetail(): void {
  ensureStyles();
  initTagging();
  buildCommentsPane();

  // Close: routed through handlers.closeDetail so the panel is parked back at
  // its markup home and the empty .detrow is dropped on the next re-render.
  $('#det-close').addEventListener('click', () => handlers.closeDetail?.());

  // tab switching
  $('#dtabs').addEventListener('click', (e) => {
    const dt = (e.target as Element | null)?.closest('.dtab');
    if (!dt || !(dt instanceof HTMLElement) || !dt.dataset.p) return;
    activateTab(dt.dataset.p);
    if (current) loadLazyTab(dt.dataset.p, current.id);
  });

  // Action buttons — delegated because #det-acts is re-rendered on every open.
  // Same menuItems() set the row menu uses; runFlow() is the awaitable twin of
  // manage.runAction, so the clicked button can hold a pending state for the
  // whole flow instead of going quiet the moment the dialog appears.
  $('#det-acts').addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest('[data-act]');
    if (!btn || !(btn instanceof HTMLElement) || !btn.dataset.act || !current) return;
    const act = btn.dataset.act;
    const t = current;
    pendingAct = act;
    renderActions(t);
    void (async () => {
      try {
        await runFlow(act, t);
      } catch (e2) {
        errToast(msgOf(e2));
      } finally {
        pendingAct = null;
        if (current) renderActions(current);
      }
    })();
  });

  // Tags — the same editor the row's + button opens.
  $('#det-aside').addEventListener('click', (e) => {
    const hit = (e.target as Element | null)?.closest('#det-tagadd, #det-tags .osm-chip');
    if (!hit || !current) return;
    const anchor = $maybe('#det-tagadd') ?? (hit as HTMLElement);
    // No onClose needed: openTagsFor re-selects this row when it closes, which
    // re-renders the whole panel (aside included) from fresh server state.
    openTagsFor(current, anchor);
  });

  // auto-update toggle (per-row, owned field)
  const autoBtn = $('#autoupd') as HTMLButtonElement;
  autoBtn.addEventListener('click', () => {
    if (!current) return;
    const t = current;
    const next = t.auto_update !== 1;
    void withPending(autoBtn, 'saving…', async () => {
      try {
        await patchTool(t.id, { auto_update: next });
        t.auto_update = next ? 1 : 0;
        renderAutoUpdate(t);
        toast(
          next
            ? 'Auto update ON — tracks latest on every refresh'
            : 'Auto update OFF (default) — you approve each one',
        );
      } catch (e) {
        errToast(e);
      }
    });
  });

  // post a comment: Ctrl/Cmd+Enter or the button. Focus stays in the box so a
  // second thought does not need a second click.
  const input = $('#cin') as HTMLTextAreaElement;
  const postBtn = $('#cpost') as HTMLButtonElement;

  const post = (): void => {
    if (!current) return;
    const t = current;
    const body = input.value.trim();
    if (!body) {
      input.focus();
      toast('nothing to post yet');
      return;
    }
    void withPending(postBtn, 'posting…', async () => {
      input.disabled = true;
      try {
        await postComment(t.id, body);
        input.value = '';
        const fresh = await getTool(t.id);
        if (state.selectedId === fresh.id) {
          current = fresh;
          renderComments(fresh);
          renderDetails(fresh);
        }
      } catch (e) {
        // Keep the text: it is the user's writing, not ours to throw away.
        errToast(e);
        const stream = $maybe('#cstream');
        if (stream) {
          stream.insertAdjacentHTML(
            'afterbegin',
            errorState({ title: 'That comment was not saved', detail: msgOf(e) }),
          );
        }
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
  };

  postBtn.addEventListener('click', post);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      post();
    }
  });
}
