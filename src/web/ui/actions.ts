// Phase 3/4 action flows shared by the row Actions ▾ menu and the detail pane,
// plus the tag editor both surfaces open.
//
// House rule for every flow here: the read-only step runs FIRST and its output
// is put in front of the user before anything mutates.
//   try_it   → plan_trial, with the exact argv and every refusal, then confirm
//   update   → preview_update, with the refusal reason, then confirm
//   register → a dry run, with the unified diff, then confirm
// Nothing below invents a reason to skip that step. Refusals from the server
// are shown verbatim — they are the most useful thing on the screen.
//
// Every flow runs inside one openFlow() dialog that walks working → ask →
// report, so an action always has three visible states: it started, what it is
// about to do (with the consequences spelled out), and what actually happened.
// The old window.confirm/prompt/alert could not show the first, and could not
// gate a confirm button on a required reason — which retire needs.
import {
  addTag as apiAddTag,
  applyUpdate,
  cloneTool,
  getMcpTargets,
  getPreviewUpdate,
  getPreviewUpdateFetching,
  getTrialPlan,
  registerMcp,
  removeTag as apiRemoveTag,
  retireTool,
  tearDownTool,
  tryTool,
  unregisterMcp,
} from './api.js';
import { handlers, state } from './state.js';
import { closeTagEditor, msgOf, openFlow, openTagEditor, toast, type FlowDialog } from './util.js';
import type { Tag, ToolView } from '../../core/types.js';
import type { TargetId, TargetStatus } from '../../core/registrar.js';
import type { UpdatePreview } from '../../core/preview.js';

const DIALOG_CAP = 6000;

function clip(s: string): string {
  return s.length > DIALOG_CAP ? `${s.slice(0, DIALOG_CAP)}\n…(truncated — the full text is in the server response)` : s;
}

function bullets(items: string[]): string {
  return items.map((r) => `• ${r}`).join('\n');
}

async function reload(): Promise<void> {
  await handlers.reload?.();
}

/** Turn anything thrown mid-flow into the dialog's report, never a lost toast. */
async function crash(dlg: FlowDialog, what: string, e: unknown): Promise<void> {
  await dlg.report({
    ok: false,
    message: msgOf(e),
    lead: `${what} did not complete. Nothing beyond what the report above says was changed.`,
  });
}

/* ---------- try_it ---------- */

export async function tryFlow(t: ToolView): Promise<void> {
  const dlg = openFlow(`Try ${t.name} in Docker`);
  try {
    dlg.working('reading the repo and planning the run — nothing is executing yet…');
    const plan = await getTrialPlan(t.id);
    if (!plan.ok || !plan.data) {
      await dlg.report({
        ok: false,
        message: plan.message,
        lead: `No trial was planned for ${t.name}, so nothing ran.`,
      });
      return;
    }
    const p = plan.data;
    if (!p.ok_to_run) {
      await dlg.report({
        ok: false,
        message: `Refused — the plan read from ${p.source || 'the repo'} is not allowed.`,
        pre: bullets(p.refusals),
        lead: 'Repo instructions are untrusted input: only the flag allowlist gets through. Nothing ran.',
      });
      return;
    }
    const cmd = `docker run ${p.argv.join(' ')}`;
    const ans = await dlg.ask({
      lead: `Planned from ${p.source} — read out of the repo, not typed by you.`,
      pre: clip(cmd),
      consequences: [
        'OSM forces -d, its own container name and an osm.trial=<uid> label on everything it creates',
        'ports are published on 127.0.0.1 only — the trial is never reachable from the LAN',
        'teardown later removes only what OSM created; a shared image or volume is kept',
      ],
      html:
        p.flag_explanations.length > 0
          ? `<div class="osm-choices">${p.flag_explanations
              .map(
                (f) =>
                  `<div class="osm-choice" style="cursor:default"><span><b>${escText(f.flag)}</b><span class="h">${escText(f.meaning)}</span></span></div>`,
              )
              .join('')}</div>`
          : '',
      confirmLabel: 'Run it in Docker',
    });
    if (!ans.confirmed) return;

    dlg.working(`pulling if needed and starting the container for ${t.name}…`);
    const res = await tryTool(t.id, true);
    const warnings = res.data?.warnings ?? [];
    await dlg.report({
      ok: res.ok,
      message: res.message,
      pre: warnings.length > 0 ? bullets(warnings.map((w) => `warning: ${w}`)) : undefined,
      lead: res.ok ? 'The Log tab tails this container; Tear down removes it.' : undefined,
    });
    await reload();
  } catch (e) {
    await crash(dlg, `The trial of ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

/* ---------- clone into a container ---------- */

export async function cloneFlow(t: ToolView): Promise<void> {
  const dlg = openFlow(`Clone ${t.name} into a container`);
  try {
    const ans = await dlg.ask({
      lead: 'Untrusted code, read at arm’s length: the checkout goes into a Docker volume, and the container holding it has no network and no access to this machine.',
      consequences: [
        'git clone --depth 1 runs in a container; nothing is written to this machine’s filesystem',
        'the container that keeps the source has NO network interface — nothing in the repo can phone home',
        'no host path is mounted: your filesystem, SSH keys and .env files are not present in there',
        'source read-only, rootfs read-only, runs as nobody, every capability dropped, 512M / 256 procs',
        'none of the repo’s code is executed — cloning writes files, it does not run them',
        'Tear down removes the volume, the container, and the git image only if OSM pulled it',
      ],
      confirmLabel: 'Clone it in Docker',
    });
    if (!ans.confirmed) return;

    dlg.working('pulling the git image if needed, creating the volume, cloning…');
    const res = await cloneTool(t.id);
    const d = res.data;
    const facts = d
      ? [
          `volume:    ${d.volume}`,
          `container: ${d.container}`,
          `path:      ${d.path}  (inside the container)`,
          `image:     ${d.image}${d.image_created_by_osm ? ' (pulled by OSM — teardown removes it)' : ' (already here — teardown keeps it)'}`,
          '',
          `open a shell:  ${d.exec_hint}`,
          '',
          'isolation applied:',
          ...d.isolation.map((x) => `  · ${x}`),
          '',
          d.entries.length > 0 ? `cloned files: ${d.entries.slice(0, 24).join('  ')}` : '(the clone reported no files)',
        ].join('\n')
      : undefined;
    await dlg.report({ ok: res.ok, message: res.message, pre: facts });
    await reload();
  } catch (e) {
    await crash(dlg, `Cloning ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

/* ---------- tear_down ---------- */

export async function tearDownFlow(t: ToolView): Promise<void> {
  const dlg = openFlow(`Tear down the trial of ${t.name}`);
  try {
    const ans = await dlg.ask({
      lead: 'Ownership is recorded at creation time, so teardown can only undo what OSM itself did.',
      consequences: [
        'the trial container is stopped and removed — always',
        'the image is removed ONLY if OSM pulled it for this trial',
        'volumes are removed ONLY if OSM created them for this trial',
        'anything shared with the rest of your machine is kept and named in the report',
        'the row, its journal and its verdict are untouched',
      ],
      confirmLabel: 'Tear it down',
      danger: true,
    });
    if (!ans.confirmed) return;

    dlg.working('removing the container and OSM-created resources…');
    const res = await tearDownTool(t.id);
    const d = res.data;
    const lines = [
      ...(d?.removed ?? []).map((r) => `removed: ${r}`),
      ...(d?.kept ?? []).map((k) => `kept:    ${k}`),
      ...(d?.errors ?? []).map((x) => `error:   ${x}`),
    ];
    await dlg.report({
      ok: res.ok,
      message: res.message,
      pre: lines.length > 0 ? lines.join('\n') : undefined,
    });
    await reload();
  } catch (e) {
    await crash(dlg, `Teardown of ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

/* ---------- update ---------- */

export async function updateFlow(t: ToolView): Promise<void> {
  const dlg = openFlow(`Update ${t.name}`);
  try {
    dlg.working('checking the preconditions — clean worktree, tracking branch, fast-forwardable…');
    const pv = await getPreviewUpdate(t.id);
    if (!pv.ok || !pv.data) {
      await dlg.report({ ok: false, message: pv.message, lead: 'The checkout was not touched.' });
      return;
    }
    let p = pv.data;
    const factsOf = (v: UpdatePreview): string =>
      [
        `local:    ${v.local_version ?? 'unknown'}`,
        v.upstream_ref ? `upstream: ${v.upstream_ref}` : '',
        v.ahead_behind ? `ahead/behind: ${v.ahead_behind}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    // The preview is read-only, so it cannot see a commit that has not been
    // fetched yet — and "run git fetch first" is not an answer for someone
    // clicking a button. Offer the fetch, then re-check with it done.
    if (!p.can_update && /without fetching/.test(p.reason)) {
      const go = await dlg.ask({
        lead: p.reason,
        pre: factsOf(p),
        consequences: [
          'git fetch downloads the new commits and moves the remote-tracking ref only',
          'HEAD, your branch, the index and the working tree are all untouched by a fetch',
          'nothing is merged — you get the same confirmation step afterwards',
        ],
        confirmLabel: 'Fetch and re-check',
      });
      if (!go.confirmed) return;
      dlg.working('fetching the remote, then re-checking the preconditions…');
      const again = await getPreviewUpdateFetching(t.id);
      if (!again.ok || !again.data) {
        await dlg.report({ ok: false, message: again.message, lead: 'The checkout was not touched.' });
        return;
      }
      p = again.data;
    }

    const facts = factsOf(p);

    if (!p.can_update) {
      await dlg.report({
        ok: false,
        message: p.reason,
        pre: facts,
        lead: 'Refused before touching anything — the checkout is byte-identical to how you left it.',
      });
      return;
    }
    const ans = await dlg.ask({
      lead: p.reason,
      pre: facts,
      consequences: [
        'git fetch, then merge --ff-only — never a plain git pull, never a rebase of your commits',
        'if the fast-forward stops being possible between now and the merge, it aborts',
        'the version change is written to this tool’s journal',
      ],
      confirmLabel: 'Fast-forward it',
    });
    if (!ans.confirmed) return;

    dlg.working(`fetching and fast-forwarding ${t.name}…`);
    const res = await applyUpdate(t.id);
    const breaking = res.data?.breaking ?? [];
    await dlg.report({
      ok: res.ok,
      message: res.message,
      lead: breaking.length > 0 ? 'The changelog flags possible breaking changes:' : undefined,
      pre: breaking.length > 0 ? bullets(breaking) : undefined,
    });
    await reload();
  } catch (e) {
    await crash(dlg, `The update of ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

/* ---------- registrar ---------- */

function targetsPre(targets: TargetStatus[]): string {
  return targets.map((x) => `${x.can_register ? '✓' : '·'} ${x.id.padEnd(7)} ${x.detail}`).join('\n');
}

function outcomePre(outcomes: Array<{ status: string; message: string }>): string {
  return outcomes.map((o) => `[${o.status}] ${o.message}`).join('\n');
}

/**
 * Ask which agents to write to. Rendered as real checkboxes: the old
 * comma-separated prompt made an undetected target look like a typo.
 */
async function chooseTargets(
  dlg: FlowDialog,
  verb: string,
  lead: string,
): Promise<TargetId[] | null> {
  dlg.working('detecting which agents on this machine OSM can write to…');
  const found = await getMcpTargets();
  if (!found.ok || !found.data) {
    await dlg.report({ ok: false, message: found.message, lead: 'No agent config was read or written.' });
    return null;
  }
  const usable = found.data.filter((x) => x.can_register);
  if (usable.length === 0) {
    await dlg.report({
      ok: false,
      message: 'No agent on this machine can be written to.',
      pre: targetsPre(found.data),
      lead: 'OSM only drives agents through their own official CLI — a greyed target has none here.',
    });
    return null;
  }
  const ans = await dlg.ask({
    lead,
    choices: found.data.map((x) => ({
      id: x.id,
      label: x.label,
      hint: x.detail,
      checked: x.can_register,
      disabled: !x.can_register,
    })),
    confirmLabel: verb,
  });
  if (!ans.confirmed) return null;
  return ans.selected as TargetId[];
}

export async function registerFlow(t: ToolView): Promise<void> {
  const dlg = openFlow(`Register ${t.name} as an MCP server`);
  try {
    const targets = await chooseTargets(
      dlg,
      'Dry run',
      'Per-repo always — OSM has no "apply to all". A dry run comes next; nothing is written until you have seen the diff.',
    );
    if (targets === null) return;

    dlg.working(`dry run — building the exact diff for ${targets.join(', ')}…`);
    const dry = await registerMcp(t.id, targets, true);
    if (!dry.ok && !dry.data) {
      await dlg.report({ ok: false, message: dry.message, lead: 'Dry run failed — nothing was written.' });
      return;
    }
    const perTarget = outcomePre(dry.data?.targets ?? []);
    const diff = dry.data?.diff ?? '';
    if (diff.trim() === '') {
      await dlg.report({
        ok: true,
        message: `Nothing would change for ${dry.data?.server_name ?? t.name}.`,
        pre: perTarget,
        lead: dry.message,
      });
      return;
    }
    const ans = await dlg.ask({
      lead: `Writing ${dry.data?.server_name ?? t.name} into: ${targets.join(', ')}.`,
      pre: clip(`${perTarget}\n\n${diff}`),
      consequences: [
        'each config is backed up to ~/.osource/backups before the write',
        'the result is verified by reading the config back through the agent’s own CLI, not by trusting an exit code',
        'a write that fails verification is rolled back from the backup',
        'Unregister MCP… is the exact inverse and stays available afterwards',
      ],
      confirmLabel: 'Write it',
    });
    if (!ans.confirmed) return;

    dlg.working('writing the configs and reading them back through each CLI…');
    const live = await registerMcp(t.id, targets, false);
    await dlg.report({
      ok: live.ok,
      message: live.message,
      pre: clip(outcomePre(live.data?.targets ?? [])),
    });
    await reload();
  } catch (e) {
    await crash(dlg, `Registering ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

export async function unregisterFlow(t: ToolView): Promise<void> {
  const dlg = openFlow(`Unregister ${t.name}'s MCP server`);
  try {
    const targets = await chooseTargets(
      dlg,
      'Continue',
      'Removal takes the entry OUT of a config, so there is no diff to preview first — the confirmation is the gate.',
    );
    if (targets === null) return;

    const ans = await dlg.ask({
      lead: `Remove ${t.name}'s MCP server from: ${targets.join(', ')}.`,
      consequences: [
        'OSM only removes entries it recorded creating — one it did not register is left alone',
        'each config is backed up first, then verified by reading it back through the agent’s CLI',
        'a target that never had the entry is reported as already-in-the-desired-state, untouched',
        'the agent stops seeing this tool as a server the next time it starts',
      ],
      confirmLabel: 'Remove it',
      danger: true,
    });
    if (!ans.confirmed) return;

    dlg.working('removing the entries and reading each config back…');
    const res = await unregisterMcp(t.id, targets);
    await dlg.report({
      ok: res.ok,
      message: res.message,
      pre: clip(outcomePre(res.data?.targets ?? [])),
    });
    await reload();
  } catch (e) {
    await crash(dlg, `Unregistering ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

/* ---------- retire ---------- */

/**
 * Retire needs a reason and keeps everything. The reason is the entire point of
 * the journal, so the confirm button stays disabled until one is typed — a
 * placeholder value would defeat the feature. PLAN.md [R2]: if the tool is
 * still serving as an MCP server anywhere, offer the inverse, otherwise every
 * agent config keeps pointing at a tool that was just killed.
 */
export async function retireFlow(t: ToolView): Promise<void> {
  const serving = t.observations?.serving_count ?? 0;
  const dlg = openFlow(`Retire ${t.name}`);
  try {
    const ans = await dlg.ask({
      lead: 'Retiring is a verdict, not a delete. Six months from now the reason is the only thing that explains it.',
      consequences: [
        'the verdict becomes "retired" — the row, its installations and its whole journal stay',
        'the reason is appended to the journal and kept forever',
        'nothing is removed from disk and no container is touched',
        ...(serving > 0
          ? [`it is still registered as an MCP server in ${serving} agent(s) — you will be offered the inverse next`]
          : []),
      ],
      input: {
        label: 'Why are you retiring it',
        placeholder: 'replaced by X · never actually used it · upstream is dead …',
        hint: 'Written verbatim into the journal.',
        required: true,
        multiline: true,
      },
      confirmLabel: 'Retire it',
      danger: true,
    });
    if (!ans.confirmed) return;

    dlg.working('recording the verdict and the reason…');
    await retireTool(t.id, ans.value);
    await dlg.report({
      ok: true,
      message: `Retired ${t.name}. The row and its journal stay; the reason is now part of the record.`,
      pre: ans.value,
    });
    if (state.selectedId === t.id) state.selectedId = null;

    if (serving > 0) {
      const follow = openFlow(`Unregister ${t.name}?`);
      try {
        const go = await follow.ask({
          lead: `${t.name} is retired but still registered as an MCP server in ${serving} agent(s).`,
          consequences: [
            'leaving it registered means those agents keep launching a tool you just killed',
            'unregistering is reversible — Register MCP… puts it back',
          ],
          confirmLabel: 'Unregister it now',
          cancelLabel: 'Leave it registered',
        });
        follow.close();
        if (go.confirmed) await unregisterFlow(t);
      } finally {
        follow.close();
      }
    }
    await reload();
  } catch (e) {
    await crash(dlg, `Retiring ${t.name}`, e);
  } finally {
    dlg.close();
  }
}

/* ---------- one action set, two surfaces ---------- */

/**
 * Async twin of manage.runAction — same act strings, but awaitable, so the
 * detail panel can hold a pending state on the button that was clicked until
 * the flow is actually finished.
 */
export async function runFlow(act: string, t: ToolView): Promise<void> {
  switch (act) {
    case 'try':
      return tryFlow(t);
    case 'teardown':
      return tearDownFlow(t);
    case 'update':
      return updateFlow(t);
    case 'register':
      return registerFlow(t);
    case 'unregister':
      return unregisterFlow(t);
    case 'retire':
      return retireFlow(t);
    default:
      toast(`unknown action: ${act}`);
  }
}

/* ---------- tagging ---------- */

/** Tiny local escape — util.esc is for markup this module also builds inline. */
function escText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function isTagArray(v: unknown): v is Tag[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && 'tag' in x);
}

/** Take the authoritative tag list back off the op result when the server
 *  returns one; fall back to a local edit so the popover still updates. */
function absorbTags(t: ToolView, result: unknown, fallback: () => Tag[]): void {
  if (typeof result === 'object' && result !== null && 'tags' in result) {
    const tags = (result as { tags: unknown }).tags;
    if (isTagArray(tags)) {
      t.tags = tags;
      return;
    }
  }
  t.tags = fallback();
}

/**
 * The detail panel holds its own copy of the tool, so a tag added from the
 * panel would otherwise never reach the row's chips or the pill counts.
 */
function syncShelf(t: ToolView): void {
  const row = state.tools.find((x) => x.id === t.id);
  if (row && row !== t) row.tags = t.tags;
}

/** Every tag in use anywhere, most-used first — the autocomplete source. */
function tagsInUse(): string[] {
  const counts = new Map<string, number>();
  for (const tool of state.tools) {
    for (const tag of tool.tags) counts.set(tag.tag, (counts.get(tag.tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
}

/**
 * The tag editor, opened from the row's + button and from the detail panel.
 * Re-rendering the shelf is deferred to onClose: rebuilding #rows while the
 * popover is anchored to a button inside it would rip the anchor out from
 * under it mid-edit.
 */
export function openTagsFor(t: ToolView, anchor: HTMLElement, onClose?: () => void): void {
  openTagEditor({
    anchor,
    subject: t.name,
    getTags: () => t.tags,
    suggestions: tagsInUse,
    add: async (tag: string) => {
      const res = await apiAddTag(t.id, tag);
      absorbTags(t, res, () => [...t.tags, { tool_id: t.id, tag, detected: 0 }]);
      syncShelf(t);
    },
    remove: async (tag: string) => {
      const res = await apiRemoveTag(t.id, tag);
      absorbTags(t, res, () => t.tags.filter((x) => x.tag !== tag));
      syncShelf(t);
    },
    onClose: () => {
      onClose?.();
      // Pills carry tag counts, rows carry the chips — both are now stale.
      handlers.setFilter?.(state.filter);
      // Re-open the panel on the same row so its aside shows the new tag set,
      // whichever surface the edit came from.
      if (state.selectedId === t.id) handlers.select?.(t.id);
    },
  });
}

/**
 * Upgrade the row's '+' stub to the real editor.
 *
 * manage.ts owns #rows and binds a bubble-phase click handler on document that
 * turns [data-addtag] into a window.prompt. This listener runs in the CAPTURE
 * phase, so it reaches the click first and stops it from ever getting there.
 * That is deliberate: manage.ts is not this agent's file to edit, and the two
 * handlers must not both fire on the same button.
 */
export function initTagging(): void {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null;
      const add = target?.closest('[data-addtag]');
      if (!add || !(add instanceof HTMLElement) || !add.closest('#rows')) return;
      const tr = add.closest('tr');
      const id = tr instanceof HTMLElement ? Number(tr.dataset.id) : NaN;
      const tool = state.tools.find((x) => x.id === id);
      if (!tool) return;
      e.preventDefault();
      e.stopPropagation(); // keep manage.ts's window.prompt out of this
      document.querySelectorAll('.menu-pop').forEach((p) => p.remove());
      openTagsFor(tool, add);
    },
    true,
  );

  // A row rebuild orphans the popover's anchor; close rather than float.
  window.addEventListener('beforeunload', closeTagEditor);
}
