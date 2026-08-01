import { execFile, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { McpRegistration, OpResult } from './types.js';
import {
  type Db,
  addEvent,
  forgetMcpRegistration,
  isOsmRegistration,
  recordMcpRegistration,
  selectInstallations,
  selectMcpRegistrations,
  selectTool,
  selectTools,
  upsertObservations,
  withTransaction,
} from './db.js';

/**
 * Phase-4 MCP registration.
 *
 * Every mechanism in here was probed against the real CLIs on this machine
 * (2026-07-31) before it was written — none of it is from memory:
 *
 *   claude.cmd mcp add-json <name> <json> --scope user | mcp list | mcp get | mcp remove
 *   codex.cmd  mcp add <name> [--env K=V] -- <cmd> <args...> | mcp list --json
 *              | mcp get <name> --json | mcp remove <name>       (NO TOML editing)
 *   docker mcp profile server add/remove <profile> --server <ref>
 *              | docker mcp profile server ls --format json      ('server enable' DOES NOT EXIST)
 *   kimi / zed / vscode — config-file detection only; no official CLI exists, so
 *              registration is Phase 5 and these report can_register=false.
 *
 * Hard rules held here:
 * - Reversible: register_mcp and unregister_mcp are inverses. Retire can call the
 *   inverse instead of orphaning entries in every agent config.
 * - A tool is registered under ITS OWN name (`trello`), never a namespaced one.
 *   Ownership of an entry is therefore a DATABASE fact (mcp_registrations),
 *   recorded when OSM writes and required before OSM removes — a caller cannot
 *   talk OSM into deleting a server it did not create by naming it.
 * - dryRun executes NOTHING and still returns a unified diff of what would change.
 * - Any file OSM's write path touches is copied to ~/.osource/backups/<ts>-<target>-<file>
 *   BEFORE the write, and restored if verification fails.
 * - Verification reads state back THROUGH the CLI. An exit code is never trusted.
 * - serving_count is read back from the agents on every call, never stored.
 * - Per-tool always. `targets` is explicit; there is no "apply to all".
 */

// ---------------------------------------------------------------------------
// Windows command resolution and spawning
// ---------------------------------------------------------------------------

const WIN = process.platform === 'win32';

/**
 * Resolve a bare command name to a real file on PATH.
 *
 * On Windows this NEVER returns the extensionless file: `claude` and `codex` on
 * this machine are sh shims that the PowerShell execution policy blocks, and
 * Node's spawn cannot execute them anyway. Only PATHEXT matches are returned,
 * which is what makes `claude.cmd` / `codex.cmd` the resolved targets.
 */
export function resolveCommand(base: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (base.includes('/') || base.includes('\\')) {
    return existsSync(base) && statSync(base).isFile() ? base : null;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(delimiter).filter(d => d.length > 0);
  const exts = WIN
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(e => e.length > 0)
    : [''];
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const candidate = join(dir, base + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry — keep looking
      }
    }
  }
  return null;
}

function isBatchFile(file: string): boolean {
  return WIN && /\.(cmd|bat)$/i.test(file);
}

/**
 * MSVCRT argv quoting: wrap in quotes, escape `"` as `\"`, double the
 * backslashes that immediately precede a quote.
 *
 * Verified against claude.cmd (a Rust launcher) and codex.cmd (a node shim):
 * the cmd.exe-native `""` doubling is rejected by claude.exe, `\"` is accepted
 * by both. See CMD_METACHARS for the residual hazard this leaves.
 */
function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * `\"` is invisible to cmd.exe's tokenizer, so an argument containing a quote
 * leaves cmd's quote parity odd and any later metacharacter escapes into the
 * command position. Verified: `{"url":"https://x/?a=1&b=2"}` truncates at the
 * `&` and cmd then tries to run `b`. `^`-escaping does not survive the shim's
 * second `%*` parse, so the only safe answer through a .cmd shim is refusal.
 *
 * `%` and `!` were probed and pass through literally, so they are NOT refused.
 * Non-batch executables (docker.exe) take the plain execFile path and are never
 * subject to this.
 */
const CMD_METACHARS = /[&|<>^\r\n\u0000]/;

export interface RunResult {
  argv: string[];
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

interface RunOpts {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Spawn a CLI with an argv ARRAY. Never a shell string built from user data.
 *
 * Plain executables go straight through execFile. Batch shims cannot: Node
 * 24.15 throws `spawn EINVAL` for a .cmd unless it goes via the command
 * processor, so those are handed to `cmd.exe /v:off /d /s /c` with a
 * command line this module quotes itself (windowsVerbatimArguments), rather
 * than letting `shell: true` concatenate the arguments unescaped.
 */
async function runCli(file: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const argv = [file, ...args];
  const env = opts.env ?? process.env;
  const timeout = opts.timeoutMs ?? 120_000;

  if (!isBatchFile(file)) {
    return await new Promise<RunResult>(resolve => {
      execFile(
        file,
        args,
        { env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve({
            argv,
            ok: !err,
            code: err ? ((err as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: err ? err.message.split('\n')[0] : null,
          });
        },
      );
    });
  }

  const offending = argv.find(a => CMD_METACHARS.test(a));
  if (offending !== undefined) {
    const ch = CMD_METACHARS.exec(offending)?.[0] ?? '?';
    return {
      argv,
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error:
        `refused: argument contains ${JSON.stringify(ch)}, a cmd.exe metacharacter that cannot ` +
        `be safely quoted through the ${basename(file)} shim on Windows`,
    };
  }

  const line = argv.map(quoteWindowsArg).join(' ');
  return await new Promise<RunResult>(resolve => {
    const child = spawn(env.ComSpec ?? 'cmd.exe', ['/v:off', '/d', '/s', '/c', `"${line}"`], {
      env,
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) child.kill();
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      stdout += d;
    });
    child.stderr.on('data', d => {
      stderr += d;
    });
    child.on('error', err => {
      done = true;
      clearTimeout(timer);
      resolve({ argv, ok: false, code: null, stdout, stderr, error: String(err) });
    });
    child.on('close', code => {
      done = true;
      clearTimeout(timer);
      resolve({ argv, ok: code === 0, code, stdout, stderr, error: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type TargetId = 'claude' | 'codex' | 'docker' | 'kimi' | 'zed' | 'vscode';

export const ALL_TARGETS: TargetId[] = ['claude', 'codex', 'docker', 'kimi', 'zed', 'vscode'];

export interface TargetStatus {
  id: TargetId;
  label: string;
  /** The agent is installed on this machine. */
  detected: boolean;
  /** 'cli' = an official CLI drives it. 'none' = detect-only for now. */
  mechanism: 'cli' | 'none';
  /** register/unregister will refuse when false. */
  can_register: boolean;
  /** Resolved executable — on Windows the .cmd/.exe, never a bare name. */
  command: string | null;
  /** File OSM backs up before a write, when the target has one. */
  config_path: string | null;
  detail: string;
}

/** Home directory as the SPAWNED CLI will see it, so config paths, backups and
 *  child processes never disagree. os.homedir() prefers USERPROFILE on Windows. */
function homeFrom(env: NodeJS.ProcessEnv): string {
  const v = WIN ? (env.USERPROFILE ?? env.HOME) : (env.HOME ?? env.USERPROFILE);
  return v !== undefined && v.length > 0 ? v : homedir();
}

function claudeConfigPath(env: NodeJS.ProcessEnv): string {
  return join(homeFrom(env), '.claude.json');
}

function codexConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME;
  return join(home !== undefined && home.length > 0 ? home : join(homeFrom(env), '.codex'), 'config.toml');
}

function kimiConfigPath(env: NodeJS.ProcessEnv): string {
  return join(homeFrom(env), '.kimi', 'config.toml');
}

function zedConfigPath(env: NodeJS.ProcessEnv): string | null {
  if (WIN) {
    const appData = env.APPDATA;
    return appData === undefined ? null : join(appData, 'Zed', 'settings.json');
  }
  return join(homeFrom(env), '.config', 'zed', 'settings.json');
}

function vscodeConfigPath(env: NodeJS.ProcessEnv): string | null {
  if (WIN) {
    const appData = env.APPDATA;
    return appData === undefined ? null : join(appData, 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return join(homeFrom(env), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return join(homeFrom(env), '.config', 'Code', 'User', 'mcp.json');
}

/** Documented Docker CLI plugin directories. The `mcp` group lives in one of
 *  these as `docker-mcp`; if it is absent the Toolkit is not installed. */
function dockerMcpPlugin(env: NodeJS.ProcessEnv): string | null {
  const dirs = [join(homeFrom(env), '.docker', 'cli-plugins')];
  if (WIN) {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    dirs.push(join(pf, 'Docker', 'cli-plugins'));
  } else {
    dirs.push('/usr/local/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins');
  }
  const exts = WIN ? ['.exe', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, `docker-mcp${ext}`);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        // unreadable plugin dir — keep looking
      }
    }
  }
  return null;
}

/** Which agents exist on this machine. Read-only: no spawns, no writes. */
export function detectTargets(env: NodeJS.ProcessEnv = process.env): TargetStatus[] {
  const out: TargetStatus[] = [];

  const claude = resolveCommand('claude', env);
  out.push({
    id: 'claude',
    label: 'Claude Code',
    detected: claude !== null,
    mechanism: claude !== null ? 'cli' : 'none',
    can_register: claude !== null,
    command: claude,
    config_path: claude !== null ? claudeConfigPath(env) : null,
    detail:
      claude !== null
        ? `claude CLI at ${claude} — mcp add-json/list/get/remove --scope user`
        : 'not detected: no claude executable on PATH',
  });

  const codex = resolveCommand('codex', env);
  out.push({
    id: 'codex',
    label: 'Codex',
    detected: codex !== null,
    mechanism: codex !== null ? 'cli' : 'none',
    can_register: codex !== null,
    command: codex,
    config_path: codex !== null ? codexConfigPath(env) : null,
    detail:
      codex !== null
        ? `codex CLI at ${codex} — mcp add/list/get/remove (no TOML editing)`
        : 'not detected: no codex executable on PATH',
  });

  const docker = resolveCommand('docker', env);
  const plugin = docker !== null ? dockerMcpPlugin(env) : null;
  const dockerOk = docker !== null && plugin !== null;
  out.push({
    id: 'docker',
    label: 'Docker MCP Toolkit',
    detected: dockerOk,
    mechanism: dockerOk ? 'cli' : 'none',
    can_register: dockerOk,
    command: dockerOk ? docker : null,
    config_path: null,
    detail: dockerOk
      ? `docker mcp plugin at ${plugin} — profile server add/remove (there is no 'server enable')`
      : docker === null
        ? 'not detected: no docker executable on PATH'
        : 'not detected: docker is installed but the MCP Toolkit plugin (docker-mcp) is missing',
  });

  // Phase 5 — detect only. None of these ships an official MCP CLI, and PLAN.md
  // forbids inventing a config path or hand-editing another tool's file blind.
  const later: Array<{ id: TargetId; label: string; path: string | null }> = [
    { id: 'kimi', label: 'Kimi Code', path: kimiConfigPath(env) },
    { id: 'zed', label: 'Zed', path: zedConfigPath(env) },
    { id: 'vscode', label: 'VS Code', path: vscodeConfigPath(env) },
  ];
  for (const t of later) {
    const found = t.path !== null && existsSync(t.path);
    out.push({
      id: t.id,
      label: t.label,
      detected: found,
      mechanism: 'none',
      can_register: false,
      command: null,
      config_path: found ? t.path : null,
      detail: found
        ? `config at ${t.path} — no official MCP CLI; registration is Phase 5`
        : `not detected: no config at ${t.path ?? '(no known path on this platform)'}`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Server spec
// ---------------------------------------------------------------------------

export interface StdioServerSpec {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HttpServerSpec {
  type: 'http';
  url: string;
}

export type McpServerSpec = StdioServerSpec | HttpServerSpec;

/**
 * Deterministic MCP server name for a tool: the tool's OWN name, slugified.
 *
 * No `osm-` prefix. The point of the registrar is to serve the user's tracked
 * tools to their agents under the names they actually use — `trello`,
 * `officemcp`, `playwright`. Prefixing would surface them in Claude and Codex
 * as `osm-trello`, which is not what anyone asked for.
 *
 * Ownership is therefore NOT encoded in the name; it lives in the
 * `mcp_registrations` table (see registerMcp / unregisterMcp below).
 *
 * The output always satisfies SERVER_NAME_RE.
 */
export function serverNameFor(toolName: string): string {
  const slug = toolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug === '' ? 'osm-tool' : slug;
}

/**
 * Charset gate for a server name. Strict, and about characters only.
 *
 * `opts.serverName` arrives verbatim from an HTTP body and from MCP tool input,
 * and the value lands in two dangerous places: a child-process argv element and
 * a key inside another program's config file. So the name is confined to
 * `[a-z0-9._-]` starting on a letter or a digit — no spaces, quotes,
 * backslashes, shell metacharacters, path separators, `@`, `:` or `..`, and no
 * leading `-` (which a CLI would read as a flag). 64 characters max.
 *
 * What this gate deliberately does NOT do is require a prefix. Refusing every
 * name that is not `osm-*` refused every real registration, because a real
 * registration is `trello`. Deciding WHICH names OSM may remove is a separate
 * question, answered from the database — see requireOwnedForUnregister.
 */
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name);
}

function refuseBadName(name: string, verb: 'register' | 'unregister'): string {
  return (
    `refused to ${verb} MCP server ${JSON.stringify(name)}: a server name must match ` +
    `${SERVER_NAME_RE.source} — letters, digits, dot, underscore and dash, starting with a letter ` +
    `or a digit, 64 characters max. Nothing that could be read as a flag, a path or a shell ` +
    `metacharacter reaches an argv or a config key.`
  );
}

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}

function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

function firstDiskInstall(db: Db, toolId: number): string | null {
  const inst = selectInstallations(db, toolId).find(
    i => i.present === 1 && !['npm-g', 'winget', 'skills-dir'].includes(i.where_),
  );
  if (!inst) return null;
  return inst.where_.startsWith('skills-dir:') ? inst.where_.slice('skills-dir:'.length) : inst.where_;
}

/**
 * Best-effort launch command for a tool's MCP server.
 *
 * Only two shapes are derivable with evidence: a global npm package, and a repo
 * whose package.json declares a bin. Anything else FAILS rather than guessing —
 * a wrong command would register a broken server into a real agent config.
 * Callers that know better pass `opts.server`.
 */
export function deriveServerSpec(db: Db, toolId: number): OpResult<McpServerSpec> {
  const tool = selectTool(db, toolId);
  if (!tool) return fail(`tool ${toolId} not found`);

  if (tool.canonical_key.startsWith('npm:')) {
    const pkg = tool.canonical_key.slice('npm:'.length);
    return ok(`derived from npm package ${pkg}`, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', pkg],
      env: {},
    } satisfies McpServerSpec);
  }

  const dir = firstDiskInstall(db, toolId);
  if (dir === null) {
    return fail(
      `cannot derive an MCP launch command for ${tool.name}: no present disk installation — pass server explicitly`,
    );
  }
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    return fail(
      `cannot derive an MCP launch command for ${tool.name}: no package.json at ${dir} — pass server explicitly`,
    );
  }
  let bin: unknown;
  try {
    bin = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: unknown }).bin;
  } catch (err) {
    return fail(`cannot read ${pkgPath}: ${String(err)}`);
  }
  let rel: string | null = null;
  if (typeof bin === 'string') {
    rel = bin;
  } else if (bin !== null && typeof bin === 'object') {
    const entries = Object.entries(bin as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    );
    const preferred = entries.find(([k]) => k === tool.name) ?? entries[0];
    rel = preferred?.[1] ?? null;
  }
  if (rel === null) {
    return fail(
      `cannot derive an MCP launch command for ${tool.name}: package.json declares no bin — pass server explicitly`,
    );
  }
  return ok(`derived from ${pkgPath} bin`, {
    type: 'stdio',
    command: 'node',
    args: [join(dir, rel)],
    env: {},
  } satisfies McpServerSpec);
}

// ---------------------------------------------------------------------------
// Normalized entry + unified diff
// ---------------------------------------------------------------------------

/** Target-agnostic shape so a Claude entry and a Codex entry diff against the
 *  same rendering. Only the fields OSM sets are compared. */
export interface NormalizedEntry {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

function normalizeSpec(spec: McpServerSpec): NormalizedEntry {
  return spec.type === 'http'
    ? { type: 'http', url: spec.url }
    : { type: 'stdio', command: spec.command, args: [...spec.args], env: { ...spec.env } };
}

function renderEntry(entry: NormalizedEntry | null): string {
  return entry === null ? '(absent)' : JSON.stringify(entry, null, 2);
}

interface DiffOp {
  op: ' ' | '-' | '+';
  line: string;
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 400_000) {
    // Pathological input — fall back to whole-block replace rather than a slow LCS.
    return [...a.map(line => ({ op: '-' as const, line })), ...b.map(line => ({ op: '+' as const, line }))];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: '-', line: a[i] });
      i++;
    } else {
      out.push({ op: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

/** Standard unified diff with 3 lines of context. Empty string when identical. */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = diffLines(a, b);

  const context = 3;
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op === ' ') continue;
    for (let t = Math.max(0, k - context); t <= Math.min(ops.length - 1, k + context); t++) keep[t] = true;
  }

  const lines: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let oldNo = 1;
  let newNo = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k].op !== '+') oldNo++;
      if (ops[k].op !== '-') newNo++;
      k++;
      continue;
    }
    const hunkOldStart = oldNo;
    const hunkNewStart = newNo;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (k < ops.length && keep[k]) {
      const { op, line } = ops[k];
      body.push(`${op}${line}`);
      if (op !== '+') {
        oldNo++;
        oldCount++;
      }
      if (op !== '-') {
        newNo++;
        newCount++;
      }
      k++;
    }
    lines.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`);
    lines.push(...body);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

interface BackupRecord {
  /** The file that was (or would be) written. */
  path: string;
  /** It existed before the write; false means rollback deletes it. */
  existed: boolean;
  /** Copy under ~/.osource/backups, or null when there was nothing to copy. */
  backupPath: string | null;
}

function backupsDir(env: NodeJS.ProcessEnv): string {
  return join(homeFrom(env), '.osource', 'backups');
}

function backupStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/** Copy a config file to ~/.osource/backups/<timestamp>-<target>-<file> BEFORE
 *  anything writes to it. Target id is in the name because two agents both call
 *  their file config.toml. */
function backupFile(targetId: TargetId, path: string | null, env: NodeJS.ProcessEnv): BackupRecord | null {
  if (path === null) return null;
  if (!existsSync(path)) return { path, existed: false, backupPath: null };
  const dir = backupsDir(env);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, `${backupStamp()}-${targetId}-${basename(path)}`);
  copyFileSync(path, backupPath);
  return { path, existed: true, backupPath };
}

const NOTHING_RESTORED = 'nothing to restore';

/** Did restoreBackup actually put the target back? Drives whether an outcome is
 *  allowed to call itself 'rolled-back'. */
function wasRestored(note: string): boolean {
  return note !== NOTHING_RESTORED;
}

function restoreBackup(rec: BackupRecord | null): string {
  if (rec === null) return 'nothing to restore';
  if (rec.existed && rec.backupPath !== null) {
    copyFileSync(rec.backupPath, rec.path);
    return `restored ${rec.path} from ${rec.backupPath}`;
  }
  if (existsSync(rec.path)) {
    rmSync(rec.path, { force: true });
    return `removed ${rec.path} (it did not exist before the write)`;
  }
  return NOTHING_RESTORED;
}

// ---------------------------------------------------------------------------
// Per-target reads (the CLI is the oracle)
// ---------------------------------------------------------------------------

interface EntryRead {
  /** The read itself worked. False means the target's state is UNKNOWN. */
  ok: boolean;
  found: boolean;
  entry: NormalizedEntry | null;
  error: string | null;
}

function readError(message: string): EntryRead {
  return { ok: false, found: false, entry: null, error: message };
}

/** Parse `claude mcp list` — entries are `name: command args - status`. */
function parseClaudeList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([^\s:]+):\s/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function normalizeClaudeEntry(raw: unknown): NormalizedEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.type === 'http' || o.type === 'sse' ? 'http' : 'stdio';
  if (type === 'http') {
    return { type: 'http', url: typeof o.url === 'string' ? o.url : '' };
  }
  return {
    type: 'stdio',
    command: typeof o.command === 'string' ? o.command : '',
    args: Array.isArray(o.args) ? o.args.map(String) : [],
    env: o.env !== null && typeof o.env === 'object' ? ({ ...o.env } as Record<string, string>) : {},
  };
}

async function readClaude(name: string, cmd: string, env: NodeJS.ProcessEnv): Promise<EntryRead> {
  const list = await runCli(cmd, ['mcp', 'list'], { env });
  if (!list.ok) {
    return readError(
      `claude mcp list failed (exit ${String(list.code)}): ${(list.stdout + list.stderr).trim().split('\n')[0] || (list.error ?? 'unknown')}`,
    );
  }
  const found = parseClaudeList(list.stdout).includes(name);
  if (!found) return { ok: true, found: false, entry: null, error: null };

  // Field values come from the file the CLI just wrote; presence above is the
  // CLI's own answer. Both are reads, neither trusts an exit code alone.
  const path = claudeConfigPath(env);
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return { ok: true, found: true, entry: normalizeClaudeEntry(cfg.mcpServers?.[name] ?? null), error: null };
  } catch (err) {
    return readError(`claude reports ${name} but ${path} is unreadable: ${String(err)}`);
  }
}

function normalizeCodexEntry(raw: unknown): NormalizedEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const t = (raw as { transport?: unknown }).transport;
  if (t === null || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  if (o.type === 'streamable_http' || o.type === 'http') {
    return { type: 'http', url: typeof o.url === 'string' ? o.url : '' };
  }
  return {
    type: 'stdio',
    command: typeof o.command === 'string' ? o.command : '',
    args: Array.isArray(o.args) ? o.args.map(String) : [],
    env: o.env !== null && typeof o.env === 'object' ? ({ ...o.env } as Record<string, string>) : {},
  };
}

async function readCodex(name: string, cmd: string, env: NodeJS.ProcessEnv): Promise<EntryRead> {
  const list = await runCli(cmd, ['mcp', 'list', '--json'], { env });
  if (!list.ok) {
    return readError(
      `codex mcp list --json failed (exit ${String(list.code)}): ${(list.stderr + list.stdout).trim().split('\n')[0] || (list.error ?? 'unknown')}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch (err) {
    return readError(`codex mcp list --json returned unparseable output: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) return readError('codex mcp list --json did not return an array');
  const hit = parsed.find(e => (e as { name?: unknown }).name === name);
  if (hit === undefined) return { ok: true, found: false, entry: null, error: null };
  return { ok: true, found: true, entry: normalizeCodexEntry(hit), error: null };
}

async function readDocker(
  name: string,
  cmd: string,
  profile: string | null,
  env: NodeJS.ProcessEnv,
): Promise<EntryRead> {
  const args = ['mcp', 'profile', 'server', 'ls', '--format', 'json'];
  if (profile !== null) args.push('--filter', `profile=${profile}`);
  const list = await runCli(cmd, args, { env });
  if (!list.ok) {
    return readError(
      `docker mcp profile server ls failed (exit ${String(list.code)}): ${(list.stderr + list.stdout).trim().split('\n')[0] || (list.error ?? 'unknown')}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout.trim() === '' ? '[]' : list.stdout);
  } catch (err) {
    return readError(`docker mcp profile server ls returned unparseable JSON: ${String(err)}`);
  }
  const rows = Array.isArray(parsed) ? parsed : [];
  const hit = rows.find(r => (r as { name?: unknown }).name === name);
  if (hit === undefined) return { ok: true, found: false, entry: null, error: null };
  // The Toolkit runs servers as containers; there is no stdio command to report,
  // so the entry is rendered from what the Toolkit itself stores.
  return {
    ok: true,
    found: true,
    entry: { type: 'stdio', command: 'docker', args: ['mcp', 'gateway', 'run'], env: {} },
    error: null,
  };
}

async function readTarget(
  target: TargetStatus,
  name: string,
  opts: RegisterOpts,
  env: NodeJS.ProcessEnv,
): Promise<EntryRead> {
  if (target.command === null) return readError(`${target.id}: ${target.detail}`);
  switch (target.id) {
    case 'claude':
      return await readClaude(name, target.command, env);
    case 'codex':
      return await readCodex(name, target.command, env);
    case 'docker':
      return await readDocker(name, target.command, opts.dockerProfile ?? null, env);
    default:
      return readError(`${target.id}: ${target.detail}`);
  }
}

// ---------------------------------------------------------------------------
// Per-target write argv (built, never executed, on a dry run)
// ---------------------------------------------------------------------------

type ArgvPlan = { argv: string[][] } | { refusal: string };

function claudeAddArgv(name: string, spec: McpServerSpec): ArgvPlan {
  return { argv: [['mcp', 'add-json', name, JSON.stringify(spec), '--scope', 'user']] };
}

function codexAddArgv(name: string, spec: McpServerSpec): ArgvPlan {
  if (spec.type === 'http') return { argv: [['mcp', 'add', name, '--url', spec.url]] };
  const args = ['mcp', 'add', name];
  for (const [k, v] of Object.entries(spec.env)) args.push('--env', `${k}=${v}`);
  args.push('--', spec.command, ...spec.args);
  return { argv: [args] };
}

/**
 * The Docker MCP Toolkit cannot be driven through this code path yet.
 *
 * readDocker() cannot report an stdio command — the Toolkit runs servers as
 * containers — so it synthesizes a constant `{command:'docker',args:['mcp',
 * 'gateway','run']}` entry. That constant can never equal the tool's derived
 * spec, so `entriesEqual(after, want)` is always false: every docker
 * registration reported 'rolled-back' *after* `docker mcp profile server add`
 * had already taken effect, with no journal event and (config_path === null)
 * nothing actually restored. A real fix needs a Toolkit-specific desired-state
 * comparison — presence of the server ref in the chosen profile, keyed on
 * opts.dockerRef rather than serverNameFor(). Until that exists this target
 * refuses, exactly like kimi/zed/vscode: no un-verifiable, un-journalled write.
 */
const DOCKER_REFUSAL =
  'docker: the MCP Toolkit is detect-only for now. Its profile state cannot be verified against an ' +
  'stdio server spec (the Toolkit runs servers as containers and reports no launch command), so a ' +
  "write here could not be read back or journalled. Enable it by hand with 'docker mcp profile " +
  "server add <profile> --server <ref>'.";

function dockerAddArgv(_name: string, _opts: RegisterOpts): ArgvPlan {
  return { refusal: DOCKER_REFUSAL };
}

function addArgvFor(target: TargetId, name: string, spec: McpServerSpec, opts: RegisterOpts): ArgvPlan {
  switch (target) {
    case 'claude':
      return claudeAddArgv(name, spec);
    case 'codex':
      return codexAddArgv(name, spec);
    case 'docker':
      return dockerAddArgv(name, opts);
    default:
      return { refusal: `${target}: registration is Phase 5 — detect only` };
  }
}

function removeArgvFor(target: TargetId, name: string, opts: RegisterOpts): ArgvPlan {
  switch (target) {
    case 'claude':
      return { argv: [['mcp', 'remove', name, '-s', 'user']] };
    case 'codex':
      return { argv: [['mcp', 'remove', name]] };
    // Symmetric with dockerAddArgv: OSM never wrote here, so it never removes
    // here either.
    case 'docker':
      return { refusal: DOCKER_REFUSAL };
    default:
      return { refusal: `${target}: registration is Phase 5 — detect only` };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type OutcomeStatus =
  | 'dry-run'
  | 'registered'
  | 'unregistered'
  | 'already'
  | 'skipped'
  | 'failed'
  | 'rolled-back';

export interface TargetOutcome {
  target: TargetId;
  ok: boolean;
  status: OutcomeStatus;
  message: string;
  /** Unified diff of the change. Planned on a dry run, observed otherwise. */
  diff: string;
  /** Backup taken before the write, if any. */
  backup: string | null;
  /** Exactly what OSM ran (or would run) — argv arrays, never shell strings. */
  commands: string[][];
}

export interface RegistrarResult {
  server_name: string;
  dry_run: boolean;
  spec: McpServerSpec | null;
  targets: TargetOutcome[];
  /** Every target diff, concatenated. */
  diff: string;
  /**
   * What OSM records having registered for this tool, AFTER this call. This is
   * the ownership list unregister_mcp is allowed to act on — an entry missing
   * from it is one OSM did not create and will not remove.
   */
  registrations: McpRegistration[];
}

export interface RegisterOpts {
  /** Build the diff and the argv, execute NOTHING. */
  dryRun?: boolean;
  /** Override the derived launch command. */
  server?: McpServerSpec;
  /** Override the derived server name. Defaults to the tool's own slugified
   *  name — see serverNameFor. Must match SERVER_NAME_RE. */
  serverName?: string;
  /** Docker MCP Toolkit profile id — enabling is profile-based, not per-server. */
  dockerProfile?: string;
  /** Docker MCP Toolkit server reference (catalog:// docker:// https:// file://). */
  dockerRef?: string;
  /** Extra environment for every spawn AND for resolving config/backup paths.
   *  Tests set USERPROFILE / HOME / CODEX_HOME here to stay off the real configs. */
  env?: Record<string, string>;
  /** Per-CLI timeout. Default 120s. */
  timeoutMs?: number;
  /**
   * TEST SEAM. Runs after the CLI write and before verification, so a test can
   * corrupt the target and prove the rollback restores the backup. Never set in
   * production code.
   */
  afterWrite?: (target: TargetId, configPath: string | null) => void;
}

function envFor(opts: RegisterOpts): NodeJS.ProcessEnv {
  return opts.env === undefined ? process.env : { ...process.env, ...opts.env };
}

function selectedTargets(targets: TargetId[], env: NodeJS.ProcessEnv): Map<TargetId, TargetStatus> {
  const all = new Map(detectTargets(env).map(t => [t.id, t] as const));
  const out = new Map<TargetId, TargetStatus>();
  for (const id of targets) {
    const t = all.get(id);
    if (t) out.set(id, t);
  }
  return out;
}

function entriesEqual(a: NormalizedEntry | null, b: NormalizedEntry | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Applied {
  outcome: TargetOutcome;
  /** A journal line, when something actually changed. */
  event: string | null;
  /**
   * Ownership bookkeeping for mcp_registrations, committed by finish() in the
   * same transaction as the event. 'record' = OSM now owns this entry and may
   * remove it later; 'forget' = it is gone, so OSM no longer owns it. Absent on
   * a dry run and on anything that did not reach the desired state.
   */
  own?: 'record' | 'forget';
}

/** One target, one desired state. Shared by register and unregister so the
 *  backup / verify / rollback path can never drift between them.
 *
 *  `owned` says whether mcp_registrations already holds this (tool, target,
 *  name) triple. It changes no behaviour on the register path — it only makes
 *  the outcome say out loud when a write would replace an entry OSM did not
 *  create, which is visible in the dry run the UI always performs first. */
async function applyToTarget(
  target: TargetStatus,
  name: string,
  want: NormalizedEntry | null,
  plan: ArgvPlan,
  opts: RegisterOpts,
  env: NodeJS.ProcessEnv,
  verb: 'register' | 'unregister',
  owned: boolean,
): Promise<Applied> {
  const base = { target: target.id, backup: null as string | null, commands: [] as string[][] };

  if (!target.detected || !target.can_register) {
    return {
      event: null,
      outcome: { ...base, ok: false, status: 'skipped', message: target.detail, diff: '' },
    };
  }
  if ('refusal' in plan) {
    return {
      event: null,
      outcome: { ...base, ok: false, status: 'skipped', message: plan.refusal, diff: '' },
    };
  }

  const before = await readTarget(target, name, opts, env);
  if (!before.ok) {
    return {
      event: null,
      outcome: { ...base, ok: false, status: 'failed', message: `cannot read current state — ${before.error}`, diff: '' },
    };
  }

  const beforeText = renderEntry(before.entry);
  const wantText = renderEntry(want);
  const label = `${target.id}:mcp/${name}`;
  const plannedDiff = unifiedDiff(beforeText, wantText, `${label} (current)`, `${label} (planned)`);
  const fullArgv = plan.argv.map(a => [target.command as string, ...a]);

  // Names are the user's own ('trello'), so a collision with a server the user
  // set up by hand is possible. It is not refused — the tool the user tracks and
  // the server they already run under that name are usually the same thing, and
  // refusing would block the flow — but it is never silent: the note rides in
  // the outcome message, the full before/after is in the diff, and the config is
  // copied to ~/.osource/backups before anything is written.
  const replacesForeign = verb === 'register' && before.found && !owned;
  const foreignNote = replacesForeign
    ? ` — NOTE: ${target.id} already has a server called ${name} that OSM has no record of creating; ` +
      'this REPLACES it (the config is backed up first)'
    : '';

  if (opts.dryRun === true) {
    return {
      event: null,
      outcome: {
        ...base,
        ok: true,
        status: 'dry-run',
        message:
          plannedDiff === ''
            ? `${target.id}: already in the desired state — nothing would change`
            : `${target.id}: would ${verb} ${name} (nothing executed)${foreignNote}`,
        diff: plannedDiff,
        commands: fullArgv,
      },
    };
  }

  if (entriesEqual(before.entry, want)) {
    return {
      event: null,
      // Nothing was written, but the target IS in the state this call asked for,
      // so the ownership record is brought in line with it: a register that finds
      // its own entry already there stays removable, and an unregister that finds
      // the entry already gone clears the stale row instead of leaving OSM
      // claiming a server that no longer exists.
      own: verb === 'register' ? 'record' : 'forget',
      outcome: {
        ...base,
        ok: true,
        status: 'already',
        message: `${target.id}: ${name} is already in the desired state`,
        diff: '',
        commands: [],
      },
    };
  }

  const backup = backupFile(target.id, target.config_path, env);
  const backupNote = backup?.backupPath ?? null;
  const ran: string[][] = [];

  for (const args of plan.argv) {
    const res = await runCli(target.command as string, args, { env, timeoutMs: opts.timeoutMs });
    ran.push([target.command as string, ...args]);
    if (!res.ok) {
      const why = res.error ?? (res.stderr + res.stdout).trim().split('\n')[0] ?? `exit ${String(res.code)}`;
      const restored = restoreBackup(backup);
      return {
        event: null,
        outcome: {
          ...base,
          ok: false,
          // 'rolled-back' is a claim about the target's state, so it is only
          // made when something was genuinely restored. A target with no
          // config_path (nothing to back up) reports 'failed' instead of
          // advertising a rollback that never happened.
          status: wasRestored(restored) ? 'rolled-back' : 'failed',
          message: `${target.id}: ${verb} command failed — ${why}; ${restored}`,
          diff: '',
          backup: backupNote,
          commands: ran,
        },
      };
    }
  }

  if (opts.afterWrite !== undefined) opts.afterWrite(target.id, target.config_path);

  // Verify by READING STATE BACK through the CLI. An exit code proves nothing.
  const after = await readTarget(target, name, opts, env);
  const verified = after.ok && entriesEqual(after.entry, want);
  if (!verified) {
    const why = after.ok
      ? `read-back shows ${renderEntry(after.entry)}, expected ${wantText}`
      : (after.error ?? 'unknown read failure');
    const restored = restoreBackup(backup);
    return {
      event: null,
      outcome: {
        ...base,
        ok: false,
        status: wasRestored(restored) ? 'rolled-back' : 'failed',
        message: `${target.id}: verification failed — ${why}; ${restored}`,
        diff: '',
        backup: backupNote,
        commands: ran,
      },
    };
  }

  const observedDiff = unifiedDiff(
    beforeText,
    renderEntry(after.entry),
    `${label} (before)`,
    `${label} (after)`,
  );
  return {
    event: verb === 'register' ? `registered → ${target.id} (${name})` : `unregistered → ${target.id} (${name})`,
    own: verb === 'register' ? 'record' : 'forget',
    outcome: {
      ...base,
      ok: true,
      status: verb === 'register' ? 'registered' : 'unregistered',
      message:
        `${target.id}: ${verb === 'register' ? 'registered' : 'unregistered'} ${name}, ` +
        `verified via CLI read-back${foreignNote}`,
      diff: observedDiff,
      backup: backupNote,
      commands: ran,
    },
  };
}

function finish(
  db: Db,
  toolId: number,
  serverName: string,
  spec: McpServerSpec | null,
  applied: Applied[],
  opts: RegisterOpts,
  verb: 'register' | 'unregister',
): OpResult<RegistrarResult> {
  const outcomes = applied.map(a => a.outcome);
  const events = applied.map(a => a.event).filter((e): e is string => e !== null);
  const owns = applied.filter(a => a.own !== undefined);
  // One transaction for both: the journal event and the ownership record for the
  // same write land together or not at all, so OSM can never end up owning an
  // entry it has no journal line for, nor the reverse.
  if (events.length > 0 || owns.length > 0) {
    withTransaction(db, () => {
      for (const e of events) addEvent(db, toolId, e);
      for (const a of owns) {
        if (a.own === 'record') recordMcpRegistration(db, toolId, a.outcome.target, serverName);
        else forgetMcpRegistration(db, toolId, a.outcome.target, serverName);
      }
    });
  }
  const result: RegistrarResult = {
    server_name: serverName,
    dry_run: opts.dryRun === true,
    spec,
    targets: outcomes,
    diff: outcomes
      .map(o => o.diff)
      .filter(d => d !== '')
      .join('\n'),
    registrations: selectMcpRegistrations(db, toolId),
  };
  const good = outcomes.filter(o => o.ok).length;
  const bad = outcomes.length - good;
  const verbed = verb === 'register' ? 'registered' : 'unregistered';
  const message =
    opts.dryRun === true
      ? `dry run: ${serverName} across ${String(outcomes.length)} target(s) — nothing executed`
      : `${String(good)} target(s) ${verbed}${bad > 0 ? `, ${String(bad)} failed or skipped` : ''}`;
  return bad > 0 && good === 0 ? { ok: false, message, data: result } : ok(message, result);
}

/**
 * Register a tool's MCP server with the chosen agents. Per-tool, explicit
 * targets, reversible via unregisterMcp.
 */
export async function registerMcp(
  db: Db,
  toolId: number,
  targets: TargetId[],
  opts: RegisterOpts = {},
): Promise<OpResult<RegistrarResult>> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);
    if (targets.length === 0) return fail('no targets given — registration is per-tool and explicit');

    let spec = opts.server ?? null;
    if (spec === null) {
      const derived = deriveServerSpec(db, toolId);
      if (!derived.ok || derived.data === undefined) return fail(derived.message);
      spec = derived.data;
    }
    const name = opts.serverName ?? serverNameFor(tool.name);
    if (!isValidServerName(name)) return fail(refuseBadName(name, 'register'));
    const want = normalizeSpec(spec);
    const env = envFor(opts);
    const found = selectedTargets(targets, env);

    const applied: Applied[] = [];
    for (const id of targets) {
      const target = found.get(id);
      if (target === undefined) {
        applied.push({
          event: null,
          outcome: {
            target: id,
            ok: false,
            status: 'skipped',
            message: `unknown target "${id}"`,
            diff: '',
            backup: null,
            commands: [],
          },
        });
        continue;
      }
      applied.push(
        await applyToTarget(
          target,
          name,
          want,
          addArgvFor(id, name, spec, opts),
          opts,
          env,
          'register',
          isOsmRegistration(db, toolId, id, name),
        ),
      );
    }
    const result = finish(db, toolId, name, spec, applied, opts, 'register');
    // serving_count is a cache of what the agents say, so it is refreshed here
    // by reading them back — not incremented from the outcome above.
    if (opts.dryRun !== true) await syncServingCount(db, toolId, opts);
    return result;
  } catch (err) {
    return fail(`register_mcp failed: ${String(err)}`);
  }
}

/**
 * Remove a tool's MCP server from the chosen agents — the inverse of
 * registerMcp. Without this, retire orphans an entry in every agent config and
 * the UI's "Unregister all" is unimplementable.
 */
export async function unregisterMcp(
  db: Db,
  toolId: number,
  targets: TargetId[],
  opts: RegisterOpts = {},
): Promise<OpResult<RegistrarResult>> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);
    if (targets.length === 0) return fail('no targets given — unregistration is per-tool and explicit');

    const name = opts.serverName ?? serverNameFor(tool.name);
    if (!isValidServerName(name)) return fail(refuseBadName(name, 'unregister'));
    const env = envFor(opts);
    const found = selectedTargets(targets, env);

    const applied: Applied[] = [];
    for (const id of targets) {
      const target = found.get(id);
      if (target === undefined) {
        applied.push({
          event: null,
          outcome: {
            target: id,
            ok: false,
            status: 'skipped',
            message: `unknown target "${id}"`,
            diff: '',
            backup: null,
            commands: [],
          },
        });
        continue;
      }
      // THE ownership gate. Removal is the destructive half, and the name alone
      // proves nothing now that names are the user's own, so OSM removes only a
      // (tool, target, server_name) triple it recorded when it did the write.
      // A caller passing {"serverName":"notion"} gets this refusal instead of
      // `claude mcp remove notion -s user`.
      //
      // Checked only where a removal could actually run: an undetected target or
      // one whose plan is already a refusal keeps its own, more specific message.
      const plan = removeArgvFor(id, name, opts);
      const removable = target.detected && target.can_register && !('refusal' in plan);
      if (removable && !isOsmRegistration(db, toolId, id, name)) {
        applied.push({
          event: null,
          outcome: {
            target: id,
            ok: false,
            status: 'skipped',
            message:
              `${id}: refusing to remove ${JSON.stringify(name)} — OSM has no record of registering ` +
              `it here for ${tool.name}. OSM only ever removes servers it created.`,
            diff: '',
            backup: null,
            commands: [],
          },
        });
        continue;
      }
      applied.push(await applyToTarget(target, name, null, plan, opts, env, 'unregister', true));
    }
    const result = finish(db, toolId, name, null, applied, opts, 'unregister');
    if (opts.dryRun !== true) await syncServingCount(db, toolId, opts);
    return result;
  } catch (err) {
    return fail(`unregister_mcp failed: ${String(err)}`);
  }
}

/**
 * How many agents are currently serving this tool's MCP server.
 *
 * Always read back from the agents; never stored, never inferred from a past
 * register call. A target OSM cannot read counts as not serving — the number is
 * a floor, and `servingDetail` reports which targets were unreadable.
 */
export async function servingCount(toolName: string, opts: RegisterOpts = {}): Promise<number> {
  const detail = await servingDetail(toolName, opts);
  return detail.count;
}

export interface ServingDetail {
  server_name: string;
  count: number;
  serving: TargetId[];
  unreadable: Array<{ target: TargetId; error: string }>;
}

export async function servingDetail(toolName: string, opts: RegisterOpts = {}): Promise<ServingDetail> {
  const name = opts.serverName ?? serverNameFor(toolName);
  const env = envFor(opts);
  const serving: TargetId[] = [];
  const unreadable: Array<{ target: TargetId; error: string }> = [];
  for (const target of detectTargets(env)) {
    if (!target.detected || !target.can_register) continue;
    const read = await readTarget(target, name, opts, env);
    if (!read.ok) {
      unreadable.push({ target: target.id, error: read.error ?? 'unknown read failure' });
      continue;
    }
    if (read.found) serving.push(target.id);
  }
  return { server_name: name, count: serving.length, serving, unreadable };
}

// ---------------------------------------------------------------------------
// observations.serving_count — the writer
// ---------------------------------------------------------------------------
//
// servingDetail() above answers the question; nothing used to store the answer,
// so observations.serving_count stayed at its schema default of 0 forever. That
// silently disabled everything downstream: the `serving ×N` state chip, the
// funnel's Serving tile, and PLAN [R2]'s "retire prompts to unregister if
// serving_count > 0" — retire never offered, so agents kept pointing at retired
// tools. These two functions are the only writers, and both READ BACK from the
// agents first; the column is a cache of that read, never a tally of past calls.

/** Refresh one tool's serving_count from the agents. Returns what it wrote. */
export async function syncServingCount(
  db: Db,
  toolId: number,
  opts: RegisterOpts = {},
): Promise<ServingDetail | null> {
  const tool = selectTool(db, toolId);
  if (!tool) return null;
  const detail = await servingDetail(tool.name, opts);
  upsertObservations(db, toolId, { serving_count: detail.count });
  return detail;
}

/** Every MCP server name each registerable agent currently holds. */
async function readTargetServerNames(
  target: TargetStatus,
  opts: RegisterOpts,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; names: Set<string>; error: string | null }> {
  const cmd = target.command as string;
  if (target.id === 'claude') {
    const list = await runCli(cmd, ['mcp', 'list'], { env, timeoutMs: opts.timeoutMs });
    if (!list.ok) return { ok: false, names: new Set(), error: `claude mcp list failed (exit ${String(list.code)})` };
    return { ok: true, names: new Set(parseClaudeList(list.stdout)), error: null };
  }
  if (target.id === 'codex') {
    const list = await runCli(cmd, ['mcp', 'list', '--json'], { env, timeoutMs: opts.timeoutMs });
    if (!list.ok) {
      return { ok: false, names: new Set(), error: `codex mcp list --json failed (exit ${String(list.code)})` };
    }
    try {
      const parsed: unknown = JSON.parse(list.stdout);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return {
        ok: true,
        names: new Set(
          parsed
            .map(e => (e as { name?: unknown }).name)
            .filter((n): n is string => typeof n === 'string'),
        ),
        error: null,
      };
    } catch (err) {
      return { ok: false, names: new Set(), error: `codex mcp list --json unparseable: ${String(err)}` };
    }
  }
  return { ok: false, names: new Set(), error: `${target.id}: ${target.detail}` };
}

export interface ServingRefresh {
  tools: number;
  /** Targets whose server list could not be read; their tools count as 0. */
  unreadable: Array<{ target: TargetId; error: string }>;
}

/**
 * Refresh serving_count for EVERY tracked tool. One list read per agent, not
 * one per tool — a per-tool read would mean hundreds of CLI spawns on a refresh
 * of a 60-tool machine.
 */
export async function refreshServingCounts(db: Db, opts: RegisterOpts = {}): Promise<ServingRefresh> {
  const env = envFor(opts);
  const byTarget: Array<Set<string>> = [];
  const unreadable: Array<{ target: TargetId; error: string }> = [];
  for (const target of detectTargets(env)) {
    if (!target.detected || !target.can_register || target.command === null) continue;
    const read = await readTargetServerNames(target, opts, env);
    if (!read.ok) {
      unreadable.push({ target: target.id, error: read.error ?? 'unknown read failure' });
      continue;
    }
    byTarget.push(read.names);
  }

  const tools = selectTools(db);
  for (const tool of tools) {
    const name = serverNameFor(tool.name);
    let count = 0;
    for (const names of byTarget) {
      if (names.has(name)) count++;
    }
    upsertObservations(db, tool.id, { serving_count: count });
  }
  return { tools: tools.length, unreadable };
}
