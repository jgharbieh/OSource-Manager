import type { Comment, OpResult, ToolKind, ToolView, Verdict } from './types.js';
import {
  type Db,
  addAlias,
  addEvent,
  addUserComment,
  deleteTag,
  findToolByAlias,
  insertTool,
  now,
  selectComments,
  selectInstallations,
  selectObservations,
  selectTool,
  selectToolByCanonicalKey,
  selectToolView,
  selectToolViews,
  selectTools,
  updateCanonicalKey,
  updateToolVerdict,
  upsertObservations,
  upsertTag,
  withTransaction,
} from './db.js';
import { checkUpstream, refreshAllUpstream, type UpstreamResult } from './github.js';
import {
  planTrial,
  previewUpdate,
  type PreviewUpdateOpts,
  type TrialPlan,
  type UpdatePreview,
} from './preview.js';
import { getReadme, type ReadmeDoc } from './readme.js';
import { openToolPath, type OpenResult } from './shell.js';
import { cloneIntoSandbox, type SandboxOpts, type SandboxResult } from './sandbox.js';
import {
  tearDown,
  trialLogs,
  tryIt,
  type TeardownReport,
  type TrialLogs,
  type TrialRun,
  type TryItOpts,
} from './trial.js';
import { applyUpdate, type ApplyUpdateOpts, type UpdateResult } from './update.js';
import {
  detectTargets,
  registerMcp,
  unregisterMcp,
  type RegisterOpts,
  type RegistrarResult,
  type TargetId,
  type TargetStatus,
} from './registrar.js';
import {
  searchCatalogs,
  type CatalogOpts,
  type CatalogQuery,
  type CatalogResults,
} from './catalog.js';
import {
  aliasesForGitUrl,
  canonicalKeyForGitUrl,
  canonicalKeyForLocal,
  canonicalKeyForNpm,
  nameFromCanonicalKey,
} from './canonical.js';

/**
 * Phase-1 operations — each maps 1:1 to an MCP tool / HTTP endpoint.
 *
 * Invariants held here:
 * - Owned fields (verdict, why_i_want_it, retire_reason, favorite, user
 *   comments) are only ever written through these user-driven ops, never by
 *   discovery/scan code.
 * - Every mutation that carries a journal event runs inside withTransaction,
 *   so a state change can never land without its comment (or vice versa).
 * - Rows are never deleted; retire is a verdict, not a removal.
 */

export interface SearchQuery {
  text?: string;
  favorite?: boolean;
  tag?: string;
  verdict?: Verdict;
  /** Present installation + zero comments + zero trials. "No evidence of
   *  use", NOT "unused" — absence of records, not proof of absence. */
  noEvidenceOfUse?: boolean;
  hasUpdate?: boolean;
}

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}

function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

function viewOrFail(db: Db, id: number): ToolView | null {
  return selectToolView(db, id) ?? null;
}

/** Bare-name heuristic: scoped/plain npm package vs. anything path-like. */
function looksLikeNpmPackage(name: string): boolean {
  if (name.startsWith('@')) return true; // scoped npm package
  if (/[\\/]/.test(name)) return false; // path separator
  if (/^[A-Za-z]:/.test(name)) return false; // Windows drive
  if (name.startsWith('.')) return false; // relative path
  return true;
}

export function searchTools(db: Db, q: SearchQuery): OpResult<ToolView[]> {
  try {
    let views = selectToolViews(db);

    if (q.text) {
      const needle = q.text.toLowerCase();
      views = views.filter(
        v =>
          v.name.toLowerCase().includes(needle) ||
          v.canonical_key.toLowerCase().includes(needle) ||
          v.aliases.some(a => a.toLowerCase().includes(needle)),
      );
    }
    if (q.favorite !== undefined) {
      views = views.filter(v => (v.favorite === 1) === q.favorite);
    }
    if (q.tag) {
      const tag = q.tag.toLowerCase();
      views = views.filter(v => v.tags.some(t => t.tag.toLowerCase() === tag));
    }
    if (q.verdict) {
      views = views.filter(v => v.verdict === q.verdict);
    }
    if (q.noEvidenceOfUse) {
      // Journal events (tracked/favorited/...) are bookkeeping, not use — only
      // user comments count as evidence alongside trials.
      const comments = db.prepare(
        "SELECT COUNT(*) AS n FROM comments WHERE tool_id = ? AND kind = 'user'",
      );
      const trials = db.prepare('SELECT COUNT(*) AS n FROM trials WHERE tool_id = ?');
      views = views.filter(v => {
        const hasPresentInstall = v.installations.some(i => i.present === 1);
        if (!hasPresentInstall) return false;
        const nComments = (comments.get(v.id) as { n: number }).n;
        const nTrials = (trials.get(v.id) as { n: number }).n;
        return nComments === 0 && nTrials === 0;
      });
    }
    if (q.hasUpdate) {
      views = views.filter(v => v.observations?.update_available === 1);
    }

    return ok(`${views.length} tool(s)`, views);
  } catch (err) {
    return fail(`search failed: ${String(err)}`);
  }
}

export function listTools(db: Db): OpResult<ToolView[]> {
  try {
    const views = selectToolViews(db);
    return ok(`${views.length} tool(s)`, views);
  } catch (err) {
    return fail(`list failed: ${String(err)}`);
  }
}

export function getTool(db: Db, id: number): OpResult<{ tool: ToolView; comments: Comment[] }> {
  try {
    const tool = viewOrFail(db, id);
    if (!tool) return fail(`tool ${id} not found`);
    return ok('ok', { tool, comments: selectComments(db, id) });
  } catch (err) {
    return fail(`get failed: ${String(err)}`);
  }
}

export interface TrackInput {
  url?: string;
  name?: string;
  kind?: ToolKind;
  why?: string;
}

export function trackTool(db: Db, input: TrackInput): OpResult<ToolView> {
  try {
    const url = input.url?.trim();
    const name = input.name?.trim();
    if (!url && !name) return fail('url or name required');

    let canonicalKey: string;
    let kind: ToolKind;
    let aliases: string[] = [];
    let source: string | null = null;

    if (url) {
      const key = canonicalKeyForGitUrl(url);
      if (!key) return fail(`not a recognized git URL: ${url}`);
      canonicalKey = key;
      kind = input.kind ?? 'repo';
      aliases = aliasesForGitUrl(url);
      source = url;
    } else {
      const raw = name as string;
      if (looksLikeNpmPackage(raw)) {
        canonicalKey = canonicalKeyForNpm(raw);
        kind = input.kind ?? 'global-cli';
      } else {
        canonicalKey = canonicalKeyForLocal(raw);
        kind = input.kind ?? 'binary';
      }
      aliases = [raw];
    }

    // Merge, never duplicate: match on canonical key OR any known alias.
    let existing = selectToolByCanonicalKey(db, canonicalKey);
    if (!existing) {
      for (const alias of aliases) {
        existing = findToolByAlias(db, alias);
        if (existing) break;
      }
    }

    const why = input.why?.trim();

    if (existing) {
      const id = existing.id;
      return withTransaction(db, () => {
        for (const alias of aliases) addAlias(db, id, alias);
        if (why) {
          db.prepare('UPDATE tools SET why_i_want_it = ?, updated_at = ? WHERE id = ?')
            .run(why, now(), id);
          addUserComment(db, id, why);
        }
        addEvent(db, id, 'tracked (merged)');
        const view = viewOrFail(db, id);
        return ok(`merged into existing tool #${id}`, view ?? undefined);
      });
    }

    return withTransaction(db, () => {
      const tool = insertTool(db, {
        canonical_key: canonicalKey,
        name: nameFromCanonicalKey(canonicalKey),
        kind,
        verdict: 'wanted',
        why_i_want_it: why ?? null,
        source,
      });
      for (const alias of aliases) addAlias(db, tool.id, alias);
      if (why) addUserComment(db, tool.id, why);
      addEvent(db, tool.id, 'tracked');
      const view = viewOrFail(db, tool.id);
      return ok(`tracked ${tool.name}`, view ?? undefined);
    });
  } catch (err) {
    return fail(`track failed: ${String(err)}`);
  }
}

export function commentOnTool(db: Db, toolId: number, body: string): OpResult<Comment> {
  try {
    const text = body.trim();
    if (!text) return fail('comment body required');
    if (!selectTool(db, toolId)) return fail(`tool ${toolId} not found`);
    return ok('comment added', addUserComment(db, toolId, text));
  } catch (err) {
    return fail(`comment failed: ${String(err)}`);
  }
}

export function retireTool(db: Db, toolId: number, reason: string): OpResult<ToolView> {
  try {
    const text = reason.trim();
    if (!text) return fail('reason required');
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);
    if (tool.verdict === 'retired') return fail(`tool ${toolId} is already retired`);

    return withTransaction(db, () => {
      updateToolVerdict(db, toolId, 'retired', text);
      addEvent(db, toolId, `retired: ${text}`);
      const view = viewOrFail(db, toolId);
      return ok(`retired ${tool.name}`, view ?? undefined);
    });
  } catch (err) {
    return fail(`retire failed: ${String(err)}`);
  }
}

export function setFavorite(db: Db, toolId: number, fav: boolean): OpResult<ToolView> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    return withTransaction(db, () => {
      db.prepare('UPDATE tools SET favorite = ?, updated_at = ? WHERE id = ?')
        .run(fav ? 1 : 0, now(), toolId);
      addEvent(db, toolId, fav ? 'favorited' : 'unfavorited');
      const view = viewOrFail(db, toolId);
      return ok(fav ? 'favorited' : 'unfavorited', view ?? undefined);
    });
  } catch (err) {
    return fail(`favorite failed: ${String(err)}`);
  }
}

export function setAutoUpdate(db: Db, toolId: number, on: boolean): OpResult<ToolView> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    return withTransaction(db, () => {
      db.prepare('UPDATE tools SET auto_update = ?, updated_at = ? WHERE id = ?')
        .run(on ? 1 : 0, now(), toolId);
      const view = viewOrFail(db, toolId);
      return ok(`auto_update ${on ? 'on' : 'off'}`, view ?? undefined);
    });
  } catch (err) {
    return fail(`auto_update failed: ${String(err)}`);
  }
}

export function addToolTag(db: Db, toolId: number, tag: string): OpResult<ToolView> {
  try {
    const text = tag.trim();
    if (!text) return fail('tag required');
    if (!selectTool(db, toolId)) return fail(`tool ${toolId} not found`);
    upsertTag(db, toolId, text, 0); // user-added
    const view = viewOrFail(db, toolId);
    return ok(`tagged ${text}`, view ?? undefined);
  } catch (err) {
    return fail(`tag failed: ${String(err)}`);
  }
}

export function removeToolTag(db: Db, toolId: number, tag: string): OpResult<ToolView> {
  try {
    const text = tag.trim();
    if (!text) return fail('tag required');
    if (!selectTool(db, toolId)) return fail(`tool ${toolId} not found`);
    deleteTag(db, toolId, text);
    const view = viewOrFail(db, toolId);
    return ok(`untagged ${text}`, view ?? undefined);
  } catch (err) {
    return fail(`untag failed: ${String(err)}`);
  }
}

// --- Phase 2: read-only upstream intelligence ---
//
// Thin wrappers over github.ts / preview.ts. previewUpdateOp / planTrialOp
// are pure reads (no journal). The upstream checks write observations via
// github.ts; the ONLY journal event added here is the transition into
// update_available = true — a check that changes nothing is noise.

/** Local version heuristic mirrored from github.ts: first present install. */
function localVersionFor(db: Db, toolId: number): string | null {
  for (const inst of selectInstallations(db, toolId)) {
    if (inst.present && inst.version_local) return inst.version_local;
  }
  return null;
}

function journalNewUpdate(db: Db, toolId: number, upstream: string | null): void {
  const local = localVersionFor(db, toolId) ?? 'none installed';
  addEvent(db, toolId, `upstream checked: ${local} → ${upstream ?? 'unknown'}`);
}

export async function checkUpstreamOp(db: Db, toolId: number): Promise<OpResult<UpstreamResult>> {
  try {
    const hadUpdate = selectObservations(db, toolId)?.update_available === 1;
    const res = await checkUpstream(db, toolId);
    if (res.ok && res.data?.update_available && !hadUpdate) {
      journalNewUpdate(db, toolId, res.data.version_upstream);
    }
    return res;
  } catch (err) {
    return fail(`upstream check failed: ${String(err)}`);
  }
}

export async function refreshAllUpstreamOp(
  db: Db,
  limit?: number,
): Promise<OpResult<{ checked: number; errors: string[] }>> {
  try {
    const hadUpdate = new Map<number, boolean>();
    for (const t of selectTools(db)) {
      hadUpdate.set(t.id, selectObservations(db, t.id)?.update_available === 1);
    }
    const res = await refreshAllUpstream(db, { limit });
    if (res.ok) {
      // One summary event per tool that NEWLY has an update — never per check.
      for (const t of selectTools(db)) {
        const obs = selectObservations(db, t.id);
        if (obs?.update_available === 1 && !hadUpdate.get(t.id)) {
          journalNewUpdate(db, t.id, obs.version_upstream);
        }
      }
    }
    return res;
  } catch (err) {
    return fail(`upstream refresh failed: ${String(err)}`);
  }
}

export function previewUpdateOp(
  db: Db,
  toolId: number,
  opts: PreviewUpdateOpts = {},
): OpResult<UpdatePreview> {
  try {
    return previewUpdate(db, toolId, opts);
  } catch (err) {
    return fail(`preview failed: ${String(err)}`);
  }
}

/** The tool's README, fetched at read time (nothing is mirrored into the DB). */
export async function readmeOp(db: Db, toolId: number): Promise<OpResult<ReadmeDoc>> {
  try {
    return await getReadme(db, toolId);
  } catch (err) {
    return fail(`readme failed: ${String(err)}`);
  }
}

/** Open the tool's folder/file with the OS default handler. */
export function openToolPathOp(db: Db, toolId: number): OpResult<OpenResult> {
  try {
    return openToolPath(db, toolId);
  } catch (err) {
    return fail(`open failed: ${String(err)}`);
  }
}

/**
 * Correct a row's upstream by hand.
 *
 * Discovery guesses identity from what is on disk, and it guesses wrong when a
 * repo arrived without a git remote (a downloaded copy, a vendored skill) — the
 * row then has a `local:<hash>` or `skill:<name>` key, so there is no changelog,
 * no README and no update path for it. This is the manual override, journalled
 * like every other decision. Owned fields (verdict, why, tags) are preserved.
 */
export function setUpstreamOp(db: Db, toolId: number, url: string): OpResult<ToolView> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);
    const raw = url.trim();
    if (!raw) return fail('a repo URL is required');

    const key = canonicalKeyForGitUrl(raw);
    if (!key) return fail(`not a recognized git URL: ${raw}`);
    if (key === tool.canonical_key) return fail(`${tool.name} already points at ${key}`);

    const clash = selectToolByCanonicalKey(db, key);
    if (clash && clash.id !== toolId) {
      return fail(
        `${key} is already on the shelf as "${clash.name}" (#${clash.id}). If they are the same tool ` +
          `(one repo shipping a CLI and a skill, say), merge this row into it — that keeps one row with ` +
          `both installations under it. Two rows cannot own one upstream.`,
      );
    }

    const from = tool.canonical_key;
    return withTransaction(db, () => {
      updateCanonicalKey(db, toolId, key, 'repo');
      addAlias(db, toolId, from);
      for (const alias of aliasesForGitUrl(raw)) addAlias(db, toolId, alias);
      // The old upstream reading is about a different repo now.
      upsertObservations(db, toolId, {
        version_upstream: null,
        update_available: 0,
        feed_etag: null,
        upstream_checked_at: null,
      });
      addEvent(db, toolId, `upstream set by hand: ${from} → ${key}`);
      const view = viewOrFail(db, toolId);
      return ok(`${tool.name} now points at ${key}`, view ?? undefined);
    });
  } catch (err) {
    return fail(`set upstream failed: ${String(err)}`);
  }
}

/**
 * Fold one row into another — they were always the same tool.
 *
 * agent-browser is the case that forced this: it is ONE upstream repo that
 * ships a CLI (npm -g) and a skill (a directory under a skills dir), so
 * discovery found it three ways and made three rows. The schema already models
 * this correctly — one `tools` row, many `installations` — there was just no way
 * to say "these are the same thing" after the fact.
 *
 * The target keeps its identity and its owned fields; everything observable
 * moves. The source row is deleted, because a duplicate identity is not a
 * retirement: retiring it would leave a permanent fake row on the shelf.
 */
export function mergeToolsOp(db: Db, fromId: number, intoId: number): OpResult<ToolView> {
  try {
    if (fromId === intoId) return fail('a tool cannot be merged into itself');
    const from = selectTool(db, fromId);
    const into = selectTool(db, intoId);
    if (!from) return fail(`tool ${fromId} not found`);
    if (!into) return fail(`tool ${intoId} not found`);

    return withTransaction(db, () => {
      // Observable facts move wholesale.
      db.prepare('UPDATE installations SET tool_id = ? WHERE tool_id = ?').run(intoId, fromId);
      db.prepare('UPDATE comments SET tool_id = ? WHERE tool_id = ?').run(intoId, fromId);
      db.prepare('UPDATE trials SET tool_id = ? WHERE tool_id = ?').run(intoId, fromId);

      // These carry a uniqueness constraint per (tool, X): insert-or-ignore,
      // then drop whatever is left on the source.
      db.prepare('INSERT OR IGNORE INTO aliases (tool_id, alias) SELECT ?, alias FROM aliases WHERE tool_id = ?')
        .run(intoId, fromId);
      db.prepare('DELETE FROM aliases WHERE tool_id = ?').run(fromId);
      db.prepare(
        'INSERT OR IGNORE INTO tags (tool_id, tag, detected) SELECT ?, tag, detected FROM tags WHERE tool_id = ?',
      ).run(intoId, fromId);
      db.prepare('DELETE FROM tags WHERE tool_id = ?').run(fromId);
      db.prepare(
        `INSERT OR IGNORE INTO mcp_registrations (tool_id, target, server_name, registered_at)
         SELECT ?, target, server_name, registered_at FROM mcp_registrations WHERE tool_id = ?`,
      ).run(intoId, fromId);
      db.prepare('DELETE FROM mcp_registrations WHERE tool_id = ?').run(fromId);

      // The source's canonical key is how it was found; keep it findable.
      addAlias(db, intoId, from.canonical_key);

      // Observations are derived, but the merged row genuinely serves in more
      // places, so serving/trial state is the union until the next refresh.
      const a = selectObservations(db, fromId);
      const b = selectObservations(db, intoId);
      if (a) {
        upsertObservations(db, intoId, {
          serving_count: Math.max(a.serving_count, b?.serving_count ?? 0),
          trial_running: a.trial_running === 1 || b?.trial_running === 1 ? 1 : 0,
        });
      }
      db.prepare('DELETE FROM observations WHERE tool_id = ?').run(fromId);

      // A "why" is expensive to write and cheap to lose. Never overwrite one.
      if (!into.why_i_want_it && from.why_i_want_it) {
        db.prepare('UPDATE tools SET why_i_want_it = ?, updated_at = ? WHERE id = ?')
          .run(from.why_i_want_it, now(), intoId);
      }
      if (into.favorite !== 1 && from.favorite === 1) {
        db.prepare('UPDATE tools SET favorite = 1, updated_at = ? WHERE id = ?').run(now(), intoId);
      }

      db.prepare('DELETE FROM tools WHERE id = ?').run(fromId);
      addEvent(
        db,
        intoId,
        `merged "${from.name}" (#${fromId}, ${from.canonical_key}) into this row — same tool, ` +
          `found ${from.source ? `via ${from.source}` : 'separately'}; its installations, tags and journal moved here`,
      );
      const view = viewOrFail(db, intoId);
      return ok(`merged ${from.name} into ${into.name}`, view ?? undefined);
    });
  } catch (err) {
    return fail(`merge failed: ${String(err)}`);
  }
}

export interface AutoUpdateSweep {
  applied: { name: string; message: string }[];
  failed: { name: string; message: string }[];
  /** Tools with an update available but auto-update off — the reason the sweep
   *  looks like it "did nothing". Named so the UI can say so. */
  skipped: string[];
}

/**
 * Apply updates to every tool that opted in.
 *
 * The per-row Auto update toggle is a promise, and until this existed it was an
 * empty one: the flag was stored and nothing ever read it. Repos only, and
 * strictly through applyUpdate, so the same fast-forward-only preconditions and
 * journalling apply as a hand-clicked update. Global CLIs stay gated.
 */
export async function autoUpdateSweepOp(db: Db): Promise<OpResult<AutoUpdateSweep>> {
  const out: AutoUpdateSweep = { applied: [], failed: [], skipped: [] };
  try {
    for (const tool of selectTools(db)) {
      if (tool.verdict === 'retired') continue;
      const obs = selectObservations(db, tool.id);
      if (obs?.update_available !== 1) continue;
      if (tool.auto_update !== 1) {
        out.skipped.push(tool.name);
        continue;
      }
      const res = await applyUpdate(db, tool.id);
      (res.ok ? out.applied : out.failed).push({ name: tool.name, message: res.message });
    }
    const summary = out.applied.length > 0
      ? `auto-updated ${out.applied.length} tool(s)${out.failed.length > 0 ? `, ${out.failed.length} failed` : ''}`
      : out.skipped.length > 0
        ? `nothing to auto-update — ${out.skipped.length} tool(s) have an update but auto-update is off`
        : 'nothing to auto-update';
    return ok(summary, out);
  } catch (err) {
    return fail(`auto-update sweep failed: ${String(err)}`);
  }
}

export function planTrialOp(db: Db, toolId: number): OpResult<TrialPlan> {
  try {
    return planTrial(db, toolId);
  } catch (err) {
    return fail(`plan_trial failed: ${String(err)}`);
  }
}

// --- Phase 3/4: guarded execution, mutation and the registrar ---
//
// Deliberately THIN. All of the business logic — the flag allowlist, resource
// ownership, fast-forward preconditions, backup/verify/rollback, journaling —
// lives in trial.ts / update.ts / registrar.ts and is NOT duplicated here.
// These wrappers exist so that exactly one function per operation is shared by
// the HTTP routes (src/web/server.ts) and the MCP tools (src/mcp/server.ts):
// same code path, same guards, same journal, whichever door the call came in.
// Each still carries the op-pattern try/catch so a caller never sees a throw.

/** Run a previously planned trial. Refuses whatever plan_trial refused. */
export async function tryItOp(
  db: Db,
  toolId: number,
  opts: TryItOpts = {},
): Promise<OpResult<TrialRun>> {
  try {
    return await tryIt(db, toolId, opts);
  } catch (err) {
    return fail(`try_it failed: ${String(err)}`);
  }
}

/**
 * Clone the repo into a container-only checkout (a named volume + an idle
 * container). Nothing is written to the host disk; teardown removes it.
 */
export async function cloneIntoSandboxOp(
  db: Db,
  toolId: number,
  opts: SandboxOpts = {},
): Promise<OpResult<SandboxResult>> {
  try {
    return await cloneIntoSandbox(db, toolId, opts);
  } catch (err) {
    return fail(`clone failed: ${String(err)}`);
  }
}

/** Remove ONLY the resources OSM created for this tool's latest trial. */
export async function tearDownOp(
  db: Db,
  toolId: number,
  opts: { dockerBin?: string; timeoutMs?: number } = {},
): Promise<OpResult<TeardownReport>> {
  try {
    return await tearDown(db, toolId, opts);
  } catch (err) {
    return fail(`tear_down failed: ${String(err)}`);
  }
}

/** Read-only tail of the trial container's log. */
export async function trialLogsOp(
  db: Db,
  toolId: number,
  tail = 200,
  opts: { dockerBin?: string; timeoutMs?: number } = {},
): Promise<OpResult<TrialLogs>> {
  try {
    return await trialLogs(db, toolId, tail, opts);
  } catch (err) {
    return fail(`trial_logs failed: ${String(err)}`);
  }
}

/** Apply an update. Repos fast-forward only; global CLIs stay gated. */
export async function applyUpdateOp(
  db: Db,
  toolId: number,
  opts: ApplyUpdateOpts = {},
): Promise<OpResult<UpdateResult>> {
  try {
    return await applyUpdate(db, toolId, opts);
  } catch (err) {
    return fail(`update failed: ${String(err)}`);
  }
}

/** Add this tool's MCP server to the chosen agents. dryRun executes nothing. */
export async function registerMcpOp(
  db: Db,
  toolId: number,
  targets: TargetId[],
  opts: RegisterOpts = {},
): Promise<OpResult<RegistrarResult>> {
  try {
    return await registerMcp(db, toolId, targets, opts);
  } catch (err) {
    return fail(`register_mcp failed: ${String(err)}`);
  }
}

/** The inverse of registerMcpOp — registration is never one-way. */
export async function unregisterMcpOp(
  db: Db,
  toolId: number,
  targets: TargetId[],
  opts: RegisterOpts = {},
): Promise<OpResult<RegistrarResult>> {
  try {
    return await unregisterMcp(db, toolId, targets, opts);
  } catch (err) {
    return fail(`unregister_mcp failed: ${String(err)}`);
  }
}

/** Which agents exist on this machine. Read-only: no spawns, no writes. */
export function detectTargetsOp(env?: NodeJS.ProcessEnv): OpResult<TargetStatus[]> {
  try {
    const targets = detectTargets(env);
    const usable = targets.filter(t => t.can_register).length;
    return ok(`${targets.length} target(s) known, ${usable} registerable`, targets);
  } catch (err) {
    return fail(`detect_targets failed: ${String(err)}`);
  }
}

/**
 * Browse — query the PUBLIC catalogs live (PLAN.md locked decision #10:
 * "queried live, never mirrored"). Read-only in the strictest sense: the only
 * DB access is a shelf index used to flag `already_tracked`. Nothing is
 * written, cached, or installed; adding a row is still trackTool's job.
 */
export async function browseCatalogsOp(
  db: Db,
  query: CatalogQuery = {},
  opts: CatalogOpts = {},
): Promise<OpResult<CatalogResults>> {
  try {
    return await searchCatalogs(db, query, opts);
  } catch (err) {
    return fail(`browse failed: ${String(err)}`);
  }
}
