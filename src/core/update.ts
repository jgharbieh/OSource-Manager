/**
 * Phase-3 mutation: fast-forward-only updates.
 *
 * Hard rules held here:
 * - `previewUpdate` (preview.ts) is the gate. A repo the preview refused is
 *   NEVER mutated — not even `git fetch`.
 * - Preconditions are re-verified immediately before every mutating command
 *   (TOCTOU: the worktree can change between preview and apply) AND again
 *   after `git fetch`, because fetch is itself a window.
 * - Repos update via explicit `git fetch` + `git merge --ff-only <sha>`.
 *   NEVER `git pull` — the user's pull.rebase config could rewrite local
 *   commits, and `pull` would also fetch+merge in one unauditable step.
 * - Every spawn is execFile with an argv ARRAY and `shell: false`. No command
 *   is ever assembled into a shell string. On Windows the npm `.cmd` shim is
 *   sidestepped entirely by invoking npm-cli.js with the running node binary,
 *   so nothing ever needs `shell: true` (which would reintroduce quoting).
 * - Nothing throws. Every path returns an OpResult.
 * - Global package-manager mutation (npm -g / winget) is Phase-5 scope: it is
 *   implemented but gated behind opts.allowGlobal, default false.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Installation, OpResult, Tool } from './types.js';
import {
  type Db,
  addEvent,
  now,
  selectInstallations,
  selectTool,
  upsertObservations,
  withTransaction,
} from './db.js';
import { previewUpdate, type UpdatePreview } from './preview.js';
import { checkUpstream, type ReleaseInfo } from './github.js';
import { parseWingetEntries } from './discovery.js';

export type UpdateMethod = 'git-ff-only' | 'npm-g' | 'winget';

export interface UpdateResult {
  method: UpdateMethod;
  /** Checkout dir for repos, package name for npm, package Id for winget. */
  target: string;
  version_before: string | null;
  version_after: string | null;
  /** False when the command succeeded but nothing actually moved. */
  changed: boolean;
  /** Breaking-change keyword hits found in the changelog being applied. */
  breaking: string[];
  /** The preview that authorized the update (repos only). */
  preview: UpdatePreview | null;
  /** Trimmed output of the mutating command, for the Log tab. */
  output: string;
}

export interface ApplyUpdateOpts {
  /** Phase-5 gate. Global CLI updates (npm -g / winget) refuse unless true. */
  allowGlobal?: boolean;
  /** Injectable fetch for the changelog probe so tests never hit the network. */
  fetchImpl?: typeof fetch;
  /** Set false to skip the upstream changelog probe entirely. */
  checkChangelog?: boolean;
}

const FETCH_TIMEOUT_MS = 180_000;
const MERGE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 600_000;
const WINGET_TIMEOUT_MS = 900_000;
const CHANGELOG_TIMEOUT_MS = 15_000;
const OUTPUT_CAP = 4000;

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}

function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find(l => l.trim() !== '');
  return (line ?? '').trim();
}

function cap(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_CAP ? `${t.slice(0, OUTPUT_CAP)}\n…(truncated)` : t;
}

// --- process execution -------------------------------------------------
// execFile + argv array + shell:false, always. Never a shell string.

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** stdout + stderr, trimmed and capped — what the UI shows. */
  output: string;
}

interface RunOpts {
  cwd?: string;
  timeout?: number;
  /** Read-only git: skip optional lock-taking so `git status` stays byte-identical. */
  readOnly?: boolean;
}

function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        encoding: 'utf8',
        timeout: opts.timeout ?? READ_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: opts.readOnly ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' } : process.env,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        resolve({
          ok: err === null || err === undefined,
          stdout: out,
          stderr: err && errOut === '' ? String(err) : errOut,
          output: cap(`${out}${out && errOut ? '\n' : ''}${errOut}`),
        });
      },
    );
  });
}

function git(args: string[], cwd: string, opts: RunOpts = {}): Promise<RunResult> {
  return run('git', args, { cwd, readOnly: true, timeout: READ_TIMEOUT_MS, ...opts });
}

// --- installation lookup ------------------------------------------------

const NAMED_SOURCES = ['npm-g', 'winget', 'skills-dir'];

/** Present installation that lives on disk (a real checkout), or null. */
function diskInstall(db: Db, toolId: number): Installation | null {
  return (
    selectInstallations(db, toolId).find(
      i => i.present === 1 && !NAMED_SOURCES.includes(i.where_),
    ) ?? null
  );
}

function installPath(inst: Installation): string {
  return inst.where_.startsWith('skills-dir:') ? inst.where_.slice('skills-dir:'.length) : inst.where_;
}

// --- breaking-change detection -----------------------------------------

/** Ordered most-specific first; the FIRST match labels a release. */
const BREAKING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /breaking[-\s]?changes?/i, label: 'breaking change' },
  { re: /back(?:ward|wards)[-\s]?incompatible/i, label: 'backwards incompatible' },
  { re: /(?:requires? migration|migration (?:guide|required|steps))/i, label: 'migration required' },
  { re: /(?:drops?|dropped|removes?|removed) support/i, label: 'dropped support' },
  { re: /no longer supported/i, label: 'no longer supported' },
  { re: /^\s*[a-z]+(?:\([^)]*\))?!:/im, label: 'conventional-commit breaking marker (!)' },
  { re: /\bBREAKING\b/, label: 'BREAKING' },
  { re: /\bincompatible\b/i, label: 'incompatible' },
];

/** Changelog entries whose title/body trip a breaking-change keyword. */
export function detectBreaking(releases: ReleaseInfo[]): string[] {
  const hits: string[] = [];
  for (const r of releases) {
    const text = `${r.name}\n${r.body_excerpt}`;
    const hit = BREAKING_PATTERNS.find(p => p.re.test(text));
    if (hit) hits.push(`${r.tag || r.name}: ${hit.label}`);
  }
  return hits;
}

/**
 * Best-effort changelog probe through github.ts. Runs BEFORE any mutation so
 * the local version it compares against is still the pre-update one. Any
 * failure (offline, rate limit, non-github host) yields [] and never blocks
 * the update.
 */
async function probeBreaking(db: Db, tool: Tool, opts: ApplyUpdateOpts): Promise<string[]> {
  if (opts.checkChangelog === false) return [];
  if (tool.kind !== 'repo' || !/^github\.com\/[^/\s]+\/[^/\s]+$/i.test(tool.canonical_key)) return [];
  // A hung HTTP call must not hang an update: global fetch has no default
  // timeout, so the default impl is time-boxed.
  const fetchImpl: typeof fetch =
    opts.fetchImpl ??
    ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(CHANGELOG_TIMEOUT_MS) }));
  try {
    const res = await checkUpstream(db, tool.id, { fetchImpl });
    if (!res.ok || !res.data) return [];
    return detectBreaking(res.data.releases);
  } catch {
    return []; // a changelog lookup must never fail an update
  }
}

// --- precondition re-verification (TOCTOU) ------------------------------

interface Preconditions {
  ok: boolean;
  reason: string;
  head: string;
  /** e.g. "refs/heads/main" */
  branch: string;
  /** e.g. "origin/main" */
  upstream: string;
}

const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

function bad(reason: string): Preconditions {
  return { ok: false, reason, head: '', branch: '', upstream: '' };
}

/**
 * Re-check every condition previewUpdate checked, live, right before we touch
 * anything. Read-only: GIT_OPTIONAL_LOCKS=0 on every call, so `git status`
 * output is byte-identical afterwards.
 */
async function verifyPreconditions(dir: string): Promise<Preconditions> {
  const gitPath = join(dir, '.git');
  if (!existsSync(gitPath)) return bad(`${dir} is not a git repository`);
  if (statSync(gitPath).isFile()) {
    return bad('linked worktree (.git is a gitdir pointer) — update the main checkout instead');
  }
  for (const marker of IN_PROGRESS_MARKERS) {
    if (existsSync(join(gitPath, marker))) {
      return bad(`a git operation is already in progress (${marker} present)`);
    }
  }

  const status = await git(['status', '--porcelain'], dir);
  if (!status.ok) return bad(`git status failed: ${firstLine(status.stderr)}`);
  if (status.stdout !== '') return bad('working tree has uncommitted changes');

  const symref = await git(['symbolic-ref', '-q', 'HEAD'], dir);
  if (!symref.ok) return bad('detached HEAD — check out a branch first');

  const upstream = await git(['rev-parse', '--abbrev-ref', '@{upstream}'], dir);
  if (!upstream.ok) return bad('no upstream tracking branch configured');

  const head = await git(['rev-parse', 'HEAD'], dir);
  if (!head.ok) return bad(`cannot resolve HEAD: ${firstLine(head.stderr)}`);

  return {
    ok: true,
    reason: '',
    head: head.stdout.trim(),
    branch: symref.stdout.trim(),
    upstream: upstream.stdout.trim(),
  };
}

/** Same shape discovery.ts records as version_local for a repo. */
async function repoVersion(dir: string): Promise<string | null> {
  const desc = await git(['describe', '--tags', '--always'], dir);
  if (desc.ok) {
    const v = firstLine(desc.stdout);
    if (v) return v;
  }
  const sha = await git(['rev-parse', '--short', 'HEAD'], dir);
  if (sha.ok) {
    const v = firstLine(sha.stdout);
    if (v) return v;
  }
  return null;
}

// --- journaling ---------------------------------------------------------

/** State change + its journal event land in one transaction, never apart. */
function journalUpdate(
  db: Db,
  toolId: number,
  before: string | null,
  after: string | null,
  breaking: string[],
  installId: number | null,
): void {
  withTransaction(db, () => {
    if (installId !== null) {
      db.prepare('UPDATE installations SET version_local = ?, last_seen_at = ? WHERE id = ?')
        .run(after, now(), installId);
    }
    // The update landed, so the pending-update observation is stale. Leaving it
    // set kept the amber "update" chip on a row that had just updated itself —
    // version_upstream stays (it is still what upstream published), but this row
    // is no longer behind it. The next real check re-derives both.
    upsertObservations(db, toolId, { update_available: 0 });
    addEvent(db, toolId, `updated ${before ?? 'unknown'} -> ${after ?? 'unknown'}`);
    if (breaking.length > 0) {
      addEvent(db, toolId, `changelog flags possible breaking changes — ${breaking.join('; ')}`);
    }
  });
}

function breakingSuffix(breaking: string[]): string {
  return breaking.length === 0
    ? ''
    : ` — ⚠ changelog flags possible breaking changes: ${breaking.join('; ')}`;
}

// --- repo update (fast-forward only) ------------------------------------

async function applyRepoUpdate(db: Db, tool: Tool, opts: ApplyUpdateOpts): Promise<OpResult<UpdateResult>> {
  // 1. The preview is the gate. Nothing below runs if it refused.
  const pv = previewUpdate(db, tool.id);
  if (!pv.ok || !pv.data) return fail(`update refused: ${pv.message}`);
  const preview = pv.data;
  if (!preview.can_update) {
    return preview.reason === 'already up to date'
      ? fail(`${tool.name} is already up to date — nothing to apply`)
      : fail(`update refused: ${preview.reason}`);
  }

  const inst = diskInstall(db, tool.id);
  if (!inst) return fail(`tool ${tool.id} has no present disk installation`);
  const dir = installPath(inst);

  // 2. Re-verify live — the worktree can have changed since the preview.
  const pre = await verifyPreconditions(dir);
  if (!pre.ok) return fail(`update refused on re-check: ${pre.reason}`);

  const versionBefore = (await repoVersion(dir)) ?? inst.version_local;

  // 3. Changelog probe BEFORE mutating, while the local version is still the
  //    pre-update one. Best-effort; never blocks.
  const breaking = await probeBreaking(db, tool, opts);

  const slash = pre.upstream.indexOf('/');
  const remote = slash === -1 ? 'origin' : pre.upstream.slice(0, slash);

  // 4. Fetch. Explicit — never `git pull`.
  const fetched = await run('git', ['fetch', remote], { cwd: dir, timeout: FETCH_TIMEOUT_MS });
  if (!fetched.ok) return fail(`git fetch ${remote} failed: ${firstLine(fetched.stderr)}`);

  // 5. Fetch is itself a window: re-verify everything again before merging.
  const post = await verifyPreconditions(dir);
  if (!post.ok) return fail(`update aborted after fetch: ${post.reason}`);
  if (post.head !== pre.head) return fail('update aborted: HEAD moved during fetch');
  if (post.upstream !== pre.upstream) return fail('update aborted: tracking branch changed during fetch');

  const target = await git(['rev-parse', '--verify', `${pre.upstream}^{commit}`], dir);
  if (!target.ok) return fail(`cannot resolve ${pre.upstream} after fetch: ${firstLine(target.stderr)}`);
  const targetSha = target.stdout.trim();

  if (targetSha === pre.head) {
    return ok(`${tool.name} is already up to date (nothing to fast-forward)`, {
      method: 'git-ff-only',
      target: dir,
      version_before: versionBefore,
      version_after: versionBefore,
      changed: false,
      breaking,
      preview,
      output: fetched.output,
    });
  }

  const ancestor = await git(['merge-base', '--is-ancestor', pre.head, targetSha], dir);
  if (!ancestor.ok) {
    return fail(`update refused: not fast-forwardable — local HEAD has diverged from ${pre.upstream}`);
  }

  // 6. Merge by SHA, not ref name — no gap between the check and the apply.
  const merged = await run('git', ['merge', '--ff-only', targetSha], { cwd: dir, timeout: MERGE_TIMEOUT_MS });
  if (!merged.ok) {
    return fail(`git merge --ff-only failed (checkout untouched): ${firstLine(merged.stderr)}`);
  }

  const versionAfter = (await repoVersion(dir)) ?? versionBefore;
  const newHead = await git(['rev-parse', 'HEAD'], dir);
  const changed = newHead.ok ? newHead.stdout.trim() !== pre.head : true;

  journalUpdate(db, tool.id, versionBefore, versionAfter, breaking, inst.id);

  return ok(`updated ${tool.name} ${versionBefore ?? 'unknown'} -> ${versionAfter ?? 'unknown'}${breakingSuffix(breaking)}`, {
    method: 'git-ff-only',
    target: dir,
    version_before: versionBefore,
    version_after: versionAfter,
    changed,
    breaking,
    preview,
    output: merged.output,
  });
}

// --- global CLI update (Phase 5 scope, gated) ---------------------------

const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const WINGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\.[A-Za-z0-9._+-]+)*$/;

/**
 * npm's Windows entry point is npm.cmd, and Node refuses to execFile a .cmd
 * without shell:true. Instead of reaching for a shell (and its quoting), run
 * npm's own CLI script with the node binary already executing us — still a
 * pure argv array.
 */
function npmCliPath(): string | null {
  const p = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(p) ? p : null;
}

async function npmRun(args: string[], timeout: number): Promise<RunResult | null> {
  const cli = npmCliPath();
  if (cli !== null) return run(process.execPath, [cli, ...args], { timeout });
  // Non-Windows fall back to the npm shim directly (no .cmd restriction).
  if (process.platform !== 'win32') return run('npm', args, { timeout });
  return null;
}

async function npmGlobalVersion(pkg: string): Promise<string | null> {
  const res = await npmRun(['ls', '-g', '--depth=0', '--json', pkg], 60_000);
  if (res === null || res.stdout.trim() === '') return null;
  try {
    const parsed = JSON.parse(res.stdout) as { dependencies?: Record<string, { version?: string }> };
    return parsed.dependencies?.[pkg]?.version ?? null;
  } catch {
    return null;
  }
}

async function wingetVersion(id: string): Promise<string | null> {
  const res = await run('winget', ['list', '--id', id, '--exact', '--disable-interactivity'], {
    timeout: 120_000,
  });
  if (!res.ok && res.stdout.trim() === '') return null;
  const entry = parseWingetEntries(res.stdout).find(e => e.id === id || e.rawId === id);
  return entry?.version ?? null;
}

type GlobalVia = 'npm-g' | 'winget';

async function applyGlobalUpdate(db: Db, tool: Tool, opts: ApplyUpdateOpts): Promise<OpResult<UpdateResult>> {
  const installs = selectInstallations(db, tool.id).filter(i => i.present === 1);
  const inst = installs.find(i => i.where_ === 'npm-g') ?? installs.find(i => i.where_ === 'winget') ?? null;
  if (inst === null) {
    return fail(`${tool.name} has no present npm-g or winget installation to update`);
  }
  const via = inst.where_ as GlobalVia;

  const key = tool.canonical_key;
  const name =
    via === 'npm-g'
      ? key.startsWith('npm:')
        ? key.slice('npm:'.length)
        : tool.name
      : key.startsWith('winget:')
        ? key.slice('winget:'.length)
        : tool.name;

  const wouldRun =
    via === 'npm-g' ? `npm install -g ${name}@latest` : `winget upgrade --id ${name}`;

  // The gate. Checked before ANY command runs.
  if (opts.allowGlobal !== true) {
    return fail(
      `global CLI updates are gated (Phase 5 scope): refusing to run '${wouldRun}' for ${tool.name}. ` +
        'Pass opts.allowGlobal = true to permit global package-manager mutation.',
    );
  }

  if (via === 'npm-g') {
    if (!NPM_NAME_RE.test(name)) return fail(`refusing to update: '${name}' is not a valid npm package name`);
    const before = inst.version_local ?? (await npmGlobalVersion(name));
    const res = await npmRun(['install', '-g', `${name}@latest`], NPM_TIMEOUT_MS);
    if (res === null) {
      return fail('cannot locate npm-cli.js next to the running node binary; refusing to shell out');
    }
    if (!res.ok) return fail(`npm install -g ${name}@latest failed: ${firstLine(res.stderr)}`);
    const after = (await npmGlobalVersion(name)) ?? before;
    const breaking = await probeBreaking(db, tool, opts);
    journalUpdate(db, tool.id, before, after, breaking, inst.id);
    return ok(`updated ${tool.name} ${before ?? 'unknown'} -> ${after ?? 'unknown'} via npm -g${breakingSuffix(breaking)}`, {
      method: 'npm-g',
      target: name,
      version_before: before,
      version_after: after,
      changed: before !== after,
      breaking,
      preview: null,
      output: res.output,
    });
  }

  if (!WINGET_ID_RE.test(name)) return fail(`refusing to update: '${name}' is not a valid winget package Id`);
  const before = inst.version_local;
  const res = await run(
    'winget',
    [
      'upgrade',
      '--id',
      name,
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
    { timeout: WINGET_TIMEOUT_MS },
  );
  if (!res.ok) {
    // winget exits non-zero when there is simply nothing to upgrade.
    if (/no (?:applicable|available) (?:upgrade|update)/i.test(res.output)) {
      return ok(`${tool.name} is already up to date (winget reports no applicable upgrade)`, {
        method: 'winget',
        target: name,
        version_before: before,
        version_after: before,
        changed: false,
        breaking: [],
        preview: null,
        output: res.output,
      });
    }
    return fail(`winget upgrade --id ${name} failed: ${firstLine(res.stderr || res.stdout)}`);
  }
  const after = (await wingetVersion(name)) ?? before;
  journalUpdate(db, tool.id, before, after, [], inst.id);
  return ok(`updated ${tool.name} ${before ?? 'unknown'} -> ${after ?? 'unknown'} via winget`, {
    method: 'winget',
    target: name,
    version_before: before,
    version_after: after,
    changed: before !== after,
    breaking: [],
    preview: null,
    output: res.output,
  });
}

// --- entry point --------------------------------------------------------

/**
 * Apply an update to one tool. Repos fast-forward only; global CLIs are gated
 * behind opts.allowGlobal. Never throws — every failure is an ok:false
 * OpResult, and every refusal leaves the tool exactly as it was found.
 */
export async function applyUpdate(
  db: Db,
  toolId: number,
  opts: ApplyUpdateOpts = {},
): Promise<OpResult<UpdateResult>> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    if (tool.kind === 'global-cli') return await applyGlobalUpdate(db, tool, opts);
    if (tool.kind === 'repo') return await applyRepoUpdate(db, tool, opts);
    return fail(`updating a '${tool.kind}' tool is not supported — only repos and global CLIs update`);
  } catch (err) {
    return fail(`update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
