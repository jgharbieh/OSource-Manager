// Phase 3/4 action flows shared by the row Actions ▾ menu and the detail pane.
//
// House rule for every flow here: the read-only step runs FIRST and its output
// is put in front of the user before anything mutates.
//   try_it   → plan_trial, with the exact argv and every refusal, then confirm
//   update   → preview_update, with the refusal reason, then confirm
//   register → a dry run, with the unified diff, then confirm
// Nothing below invents a reason to skip that step. Refusals from the server
// are shown verbatim — they are the most useful thing on the screen.
import {
  applyUpdate,
  getMcpTargets,
  getPreviewUpdate,
  getTrialPlan,
  registerMcp,
  retireTool,
  tearDownTool,
  tryTool,
  unregisterMcp,
} from './api.js';
import { handlers, state } from './state.js';
import { errToast, toast } from './util.js';
import type { ToolView } from '../../core/types.js';
import type { TargetId, TargetStatus } from '../../core/registrar.js';

const DIALOG_CAP = 2400;

function clip(s: string): string {
  return s.length > DIALOG_CAP ? `${s.slice(0, DIALOG_CAP)}\n…(truncated — full text is in the Log tab / server response)` : s;
}

function say(lines: Array<string | false | null | undefined>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l !== '').join('\n');
}

async function reload(): Promise<void> {
  await handlers.reload?.();
}

/* ---------- try_it ---------- */

export async function tryFlow(t: ToolView): Promise<void> {
  try {
    toast(`planning a trial of ${t.name}…`);
    const plan = await getTrialPlan(t.id);
    if (!plan.ok || !plan.data) {
      window.alert(`Cannot plan a trial of ${t.name}:\n\n${plan.message}`);
      return;
    }
    const p = plan.data;
    if (!p.ok_to_run) {
      window.alert(
        say([
          `Refused to run ${t.name} — the plan from ${p.source || 'the repo'} is not allowed:`,
          '',
          ...p.refusals.map((r) => `  • ${r}`),
          '',
          'Nothing ran. Repo instructions are untrusted input; only the flag allowlist gets through.',
        ]),
      );
      return;
    }
    const cmd = `docker run ${p.argv.join(' ')}`;
    const explained = p.flag_explanations.map((f) => `  ${f.flag} — ${f.meaning}`);
    const ok = window.confirm(
      clip(
        say([
          `Run ${t.name} in Docker?`,
          '',
          `planned from: ${p.source}`,
          cmd,
          explained.length > 0 ? '' : null,
          ...explained,
          '',
          'OSM forces -d, its own container name, an osm.trial label, and loopback-only ports.',
        ]),
      ),
    );
    if (!ok) return;

    toast(`starting trial of ${t.name}…`);
    const res = await tryTool(t.id, true);
    if (!res.ok) {
      window.alert(`Trial of ${t.name} did not start:\n\n${res.message}`);
      await reload();
      return;
    }
    toast(res.message);
    for (const w of res.data?.warnings ?? []) toast(`⚠ ${w}`);
    await reload();
  } catch (e) {
    errToast(e);
  }
}

/* ---------- tear_down ---------- */

export async function tearDownFlow(t: ToolView): Promise<void> {
  if (
    !window.confirm(
      say([
        `Tear down the trial of ${t.name}?`,
        '',
        'The container always goes. The image is removed ONLY if OSM pulled it, and volumes',
        'ONLY the ones OSM created — anything shared is kept and named in the report.',
      ]),
    )
  ) {
    return;
  }
  try {
    const res = await tearDownTool(t.id);
    if (!res.ok) {
      window.alert(`Teardown of ${t.name} failed:\n\n${res.message}`);
    } else {
      toast(res.message);
    }
    await reload();
  } catch (e) {
    errToast(e);
  }
}

/* ---------- update ---------- */

export async function updateFlow(t: ToolView): Promise<void> {
  try {
    toast(`checking whether ${t.name} can fast-forward…`);
    const pv = await getPreviewUpdate(t.id);
    if (!pv.ok || !pv.data) {
      window.alert(`Cannot preview an update for ${t.name}:\n\n${pv.message}`);
      return;
    }
    const p = pv.data;
    if (!p.can_update) {
      window.alert(
        say([
          `Update refused for ${t.name}:`,
          '',
          `  ${p.reason}`,
          '',
          `local: ${p.local_version ?? 'unknown'}`,
          p.upstream_ref ? `upstream: ${p.upstream_ref}` : null,
          p.ahead_behind ? `ahead/behind: ${p.ahead_behind}` : null,
          '',
          'The checkout was not touched.',
        ]),
      );
      return;
    }
    const ok = window.confirm(
      say([
        `Fast-forward ${t.name}?`,
        '',
        `  ${p.reason}`,
        `local: ${p.local_version ?? 'unknown'}`,
        p.upstream_ref ? `upstream: ${p.upstream_ref}` : null,
        p.ahead_behind ? `ahead/behind: ${p.ahead_behind}` : null,
        '',
        'git fetch + merge --ff-only. Never git pull, never a rebase of your commits.',
      ]),
    );
    if (!ok) return;

    const res = await applyUpdate(t.id);
    if (!res.ok) {
      window.alert(`Update of ${t.name} failed:\n\n${res.message}`);
      await reload();
      return;
    }
    toast(res.message);
    const breaking = res.data?.breaking ?? [];
    if (breaking.length > 0) {
      window.alert(
        say([`⚠ The changelog for ${t.name} flags possible breaking changes:`, '', ...breaking.map((b) => `  • ${b}`)]),
      );
    }
    await reload();
  } catch (e) {
    errToast(e);
  }
}

/* ---------- registrar ---------- */

function describeTargets(targets: TargetStatus[]): string {
  return targets.map((x) => `  ${x.can_register ? '✓' : '·'} ${x.id.padEnd(7)} ${x.detail}`).join('\n');
}

/** Ask which agents to write to. Returns null when the user backs out. */
async function chooseTargets(verb: string, serverHint: string): Promise<TargetId[] | null> {
  const found = await getMcpTargets();
  if (!found.ok || !found.data) {
    window.alert(`Cannot detect MCP targets:\n\n${found.message}`);
    return null;
  }
  const usable = found.data.filter((x) => x.can_register);
  if (usable.length === 0) {
    window.alert(say([`No agent on this machine can be written to:`, '', describeTargets(found.data)]));
    return null;
  }
  const raw = window.prompt(
    say([
      `${verb} ${serverHint} — which agents? (comma separated)`,
      '',
      describeTargets(found.data),
    ]),
    usable.map((x) => x.id).join(','),
  );
  if (raw === null) return null;
  const known = new Set(found.data.map((x) => x.id as string));
  const chosen: TargetId[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!known.has(part)) {
      window.alert(`Unknown target "${part}". Known: ${[...known].join(', ')}`);
      return null;
    }
    if (!chosen.includes(part as TargetId)) chosen.push(part as TargetId);
  }
  if (chosen.length === 0) {
    toast('no targets chosen — nothing done');
    return null;
  }
  return chosen;
}

export async function registerFlow(t: ToolView): Promise<void> {
  try {
    const targets = await chooseTargets('Register', t.name);
    if (targets === null) return;

    // Dry run FIRST — always. Nothing is written until the diff has been seen.
    const dry = await registerMcp(t.id, targets, true);
    const perTarget = (dry.data?.targets ?? []).map((o) => `  [${o.status}] ${o.message}`).join('\n');
    if (!dry.ok && !dry.data) {
      window.alert(`Dry run failed for ${t.name}:\n\n${dry.message}`);
      return;
    }
    const diff = dry.data?.diff ?? '';
    if (diff.trim() === '') {
      window.alert(
        say([`Nothing would change for ${t.name} (${dry.data?.server_name ?? 'osm-?'}):`, '', perTarget, '', dry.message]),
      );
      return;
    }
    const ok = window.confirm(
      clip(
        say([
          `Register ${dry.data?.server_name ?? t.name} into: ${targets.join(', ')}?`,
          '',
          perTarget,
          '',
          diff,
          '',
          'The config is backed up first and verified by reading it back through the agent CLI.',
        ]),
      ),
    );
    if (!ok) return;

    const live = await registerMcp(t.id, targets, false);
    window.alert(
      clip(say([live.ok ? 'Registered.' : 'Registration did not fully succeed.', '', live.message, '', (live.data?.targets ?? []).map((o) => `  [${o.status}] ${o.message}`).join('\n')])),
    );
    await reload();
  } catch (e) {
    errToast(e);
  }
}

export async function unregisterFlow(t: ToolView): Promise<void> {
  try {
    const targets = await chooseTargets('Unregister', t.name);
    if (targets === null) return;

    // Removal takes the tool OUT of a config, so the confirm IS the gate here —
    // there is no dry run to show. A target that has no entry reports 'already'
    // and nothing is written to it.
    if (
      !window.confirm(
        say([
          `Remove ${t.name}'s MCP server from: ${targets.join(', ')}?`,
          '',
          'Each config is backed up first, then verified by reading it back through the agent CLI.',
          'Targets that never had the entry are reported as already-in-the-desired-state and left alone.',
        ]),
      )
    ) {
      return;
    }

    const res = await unregisterMcp(t.id, targets);
    window.alert(
      clip(
        say([
          res.ok ? 'Unregistered.' : 'Unregistration did not fully succeed.',
          '',
          res.message,
          '',
          (res.data?.targets ?? []).map((o) => `  [${o.status}] ${o.message}`).join('\n'),
        ]),
      ),
    );
    await reload();
  } catch (e) {
    errToast(e);
  }
}

/* ---------- retire ---------- */

/**
 * Retire needs a reason and keeps everything. PLAN.md [R2]: if the tool is
 * still serving as an MCP server anywhere, offer the inverse — otherwise every
 * agent config keeps pointing at a tool that was just killed.
 */
export function retireFlow(t: ToolView): void {
  const reason = (window.prompt(`Retire ${t.name} — why? (required, kept forever)`) ?? '').trim();
  if (!reason) {
    toast('Retire needs a reason — that is the whole point.');
    return;
  }
  if (
    !window.confirm(
      `Retire "${t.name}"?\nReason: ${reason}\n\nThe row and its journal stay; the verdict becomes retired.`,
    )
  ) {
    return;
  }
  void (async () => {
    try {
      await retireTool(t.id, reason);
      toast(`retired: ${t.name}`);
      if (state.selectedId === t.id) state.selectedId = null;
      const serving = t.observations?.serving_count ?? 0;
      if (serving > 0) {
        if (
          window.confirm(
            say([
              `${t.name} is still registered as an MCP server in ${serving} agent(s).`,
              '',
              'Unregister it now? Leaving it registered means the agents keep pointing at a tool you just retired.',
            ]),
          )
        ) {
          await unregisterFlow(t);
        }
      }
      await reload();
    } catch (e) {
      errToast(e);
    }
  })();
}
