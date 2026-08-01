import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OpResult } from './types.js';
import { type Db, selectInstallations, selectTool } from './db.js';

/**
 * Phase-2 read-only upstream intelligence.
 *
 * Hard rules held here:
 * - NOTHING mutates: no git fetch/pull, no docker run/build, no DB writes.
 *   Every git spawn runs with GIT_OPTIONAL_LOCKS=0 so even index refreshes
 *   are skipped — `git status` is byte-identical before and after a call.
 * - git/docker are spawned via execFileSync with argv ARRAYS, never shell
 *   strings. (In this phase docker is never spawned at all — plan_trial only
 *   produces the argv that WOULD run.)
 * - README/compose content is attacker-controlled input: parsed, validated
 *   against an allowlist, and shown — never executed.
 */

export interface UpdatePreview {
  can_update: boolean;
  reason: string;
  local_version: string | null;
  upstream_ref: string | null;
  ahead_behind: string | null;
}

export interface FlagExplanation {
  flag: string;
  meaning: string;
}

export interface TrialPlan {
  ok_to_run: boolean;
  image: string | null;
  /** The exact docker argv that WOULD run, starting after 'docker run'. */
  argv: string[];
  flag_explanations: FlagExplanation[];
  refusals: string[];
  source: string;
}

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}

function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

interface GitResult {
  ran: boolean;
  stdout: string;
  stderr: string;
}

/** Read-only git invocation. Never a shell string; never an optional lock. */
function git(args: string[], cwd: string): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ran: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ran: false,
      stdout: e.stdout === undefined ? '' : String(e.stdout),
      stderr: e.stderr === undefined ? String(err) : String(e.stderr),
    };
  }
}

/** Present disk installation path, or null. Named scan sources ('npm-g',
 *  'winget', 'skills-dir') are not paths; 'skills-dir:<path>' strips its prefix. */
function diskInstallPath(db: Db, toolId: number): string | null {
  const inst = selectInstallations(db, toolId).find(
    i => i.present === 1 && !['npm-g', 'winget', 'skills-dir'].includes(i.where_),
  );
  if (!inst) return null;
  return inst.where_.startsWith('skills-dir:') ? inst.where_.slice('skills-dir:'.length) : inst.where_;
}

// --- preview_update ---

export function previewUpdate(db: Db, toolId: number): OpResult<UpdatePreview> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    const installs = selectInstallations(db, toolId);
    const dir = diskInstallPath(db, toolId);
    if (!dir) return fail(`tool ${toolId} has no present disk installation`);

    const inst = installs.find(i => i.present === 1 && !['npm-g', 'winget', 'skills-dir'].includes(i.where_));
    const preview: UpdatePreview = {
      can_update: false,
      reason: '',
      local_version: inst?.version_local ?? null,
      upstream_ref: null,
      ahead_behind: null,
    };
    const refuse = (reason: string): OpResult<UpdatePreview> => {
      preview.reason = reason;
      return ok(`cannot update ${tool.name}: ${reason}`, preview);
    };

    const gitPath = join(dir, '.git');
    if (!existsSync(gitPath)) return fail(`${dir} is not a git repository`);

    // Linked worktree: .git is a FILE containing a gitdir: pointer.
    if (statSync(gitPath).isFile()) {
      return refuse('linked worktree (.git is a gitdir pointer) — update the main checkout instead');
    }

    const head = git(['rev-parse', 'HEAD'], dir);
    if (head.ran && preview.local_version === null) {
      preview.local_version = head.stdout.trim().slice(0, 12);
    }

    const status = git(['status', '--porcelain'], dir);
    if (!status.ran) return refuse(`git status failed: ${status.stderr.trim()}`);
    if (status.stdout !== '') return refuse('working tree has uncommitted changes');

    const symref = git(['symbolic-ref', '-q', 'HEAD'], dir);
    if (!symref.ran) return refuse('detached HEAD — check out a branch first');

    const upstream = git(['rev-parse', '--abbrev-ref', '@{upstream}'], dir);
    if (!upstream.ran) return refuse('no upstream tracking branch configured');
    const upstreamName = upstream.stdout.trim(); // e.g. origin/main
    const slash = upstreamName.indexOf('/');
    const remote = slash === -1 ? upstreamName : upstreamName.slice(0, slash);
    const branch = slash === -1 ? '' : upstreamName.slice(slash + 1);

    // ls-remote reads the remote WITHOUT fetching — no ref mutation, no objects written.
    const ls = git(['ls-remote', remote, `refs/heads/${branch}`], dir);
    const remoteSha = ls.ran && ls.stdout.trim() !== '' ? ls.stdout.split(/\s+/)[0] : null;
    if (!remoteSha) {
      return refuse(`cannot query remote '${remote}' (offline, or branch '${branch}' is gone upstream)`);
    }
    preview.upstream_ref = `${upstreamName}@${remoteSha.slice(0, 12)}`;

    const localSha = head.ran ? head.stdout.trim() : '';
    if (remoteSha === localSha) {
      preview.ahead_behind = 'up to date';
      preview.reason = 'already up to date';
      return ok(`${tool.name} is already up to date`, preview);
    }

    // Fast-forward check needs the remote object locally. If it is missing we
    // CANNOT verify ancestry without fetching — and fetching is a mutation we
    // never perform. Report honestly instead.
    const haveObject = git(['cat-file', '-e', `${remoteSha}^{commit}`], dir);
    if (!haveObject.ran) {
      return refuse('cannot verify fast-forward without fetching (run git fetch first)');
    }

    const counts = git(['rev-list', '--left-right', '--count', `HEAD...${remoteSha}`], dir);
    if (counts.ran) {
      const [ahead, behind] = counts.stdout.trim().split(/\s+/);
      preview.ahead_behind = `ahead ${ahead}, behind ${behind}`;
    }

    const ancestor = git(['merge-base', '--is-ancestor', 'HEAD', remoteSha], dir);
    if (!ancestor.ran) {
      return refuse(`not fast-forwardable — local HEAD has diverged from ${upstreamName}`);
    }

    preview.can_update = true;
    preview.reason = `safe fast-forward to ${upstreamName} (${remoteSha.slice(0, 12)})`;
    return ok(`${tool.name} can fast-forward to ${preview.upstream_ref}`, preview);
  } catch (err) {
    return fail(`preview failed: ${String(err)}`);
  }
}

// --- plan_trial ---

/** Docker flag allowlist from PLAN.md §Trial safety. */
const VALUE_FLAGS = new Set(['--name', '--label', '-p', '-v', '-e', '--shm-size', '--memory']);
const NO_VALUE_FLAGS = new Set(['-d']);
const ALLOWLIST = new Set([...VALUE_FLAGS, ...NO_VALUE_FLAGS]);

/** Known-dangerous flags get a tailored refusal; anything else off the
 *  allowlist gets a generic one. Either way the flag is NAMED. */
const DANGEROUS: Record<string, string> = {
  '--privileged': 'grants the container full access to the host',
  '--network': 'host networking exposes the trial to the whole LAN',
  '--cap-add': 'adds kernel capabilities to the container',
  '--pid': 'shares the host PID namespace',
};

/** Tokenize a command line honoring single/double quotes. No shell semantics
 *  beyond quoting — the result feeds execFile-style argv, never a shell. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let quoted = false;
  for (const ch of cmd) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || quoted) {
        tokens.push(cur);
        cur = '';
        quoted = false;
      }
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || quoted) tokens.push(cur);
  return tokens;
}

/** Rewrite any -p form to atomic loopback allocation: 127.0.0.1::<containerPort>.
 *  Never probe-then-bind, never publish on all interfaces. */
function rewritePort(spec: string): string {
  const parts = spec.split(':');
  return `127.0.0.1::${parts[parts.length - 1]}`;
}

/**
 * Docker's own named-volume grammar. This is an ALLOWLIST on purpose: the
 * previous host-path blocklist enumerated shapes (`/…`, `./…`, `C:\…`) and
 * therefore let every backslash-rooted Windows source through as if it were a
 * named volume — `\\.\pipe\docker_engine` (the Windows Docker daemon socket),
 * `\\server\share` UNC paths and `\Users\…`. One rule closes all of them, plus
 * `~/…` and anything not yet imagined.
 */
export const NAMED_VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Source half of a `-v` spec. A drive-letter path puts its own ':' at index 1,
 *  so `C:\x:/y` must not be split down to a bare "C" (which would otherwise
 *  satisfy the volume-name grammar). */
export function mountSource(spec: string): string {
  if (/^[A-Za-z]:[\\/]/.test(spec)) return spec.slice(0, 2);
  return spec.split(':')[0];
}

/** Anything whose source is not a plain named volume is a host path. */
function isBindMount(spec: string): boolean {
  return !NAMED_VOLUME_RE.test(mountSource(spec));
}

/** The Docker daemon endpoint under either OS: the unix socket and the Windows
 *  named pipe. Mounting either hands the container control of the daemon. */
function isDockerDaemonMount(spec: string): boolean {
  return /docker\.sock/.test(spec) || /pipe[\\/]+docker_engine/i.test(spec);
}

interface ParsedRun {
  argv: string[];
  image: string | null;
  refusals: string[];
  explanations: FlagExplanation[];
}

/** Validate a post-'docker run' argv against the allowlist; build the planned
 *  argv (with port rewrites) and per-flag explanations. */
function validateRun(raw: string[]): ParsedRun {
  const argv: string[] = [];
  const refusals: string[] = [];
  const explanations: FlagExplanation[] = [];
  let image: string | null = null;

  let i = 0;
  while (i < raw.length) {
    const tok = raw[i];
    const isFlag = tok.startsWith('-') && tok !== '-';

    if (!isFlag) {
      if (image === null) {
        image = tok;
        argv.push(tok);
        explanations.push({ flag: tok, meaning: 'the image to run' });
      } else {
        argv.push(tok);
        explanations.push({ flag: tok, meaning: 'command/argument passed to the container' });
      }
      i++;
      continue;
    }

    const eq = tok.indexOf('=');
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    let value = eq === -1 ? null : tok.slice(eq + 1);

    if (DANGEROUS[flag]) {
      refusals.push(`refused flag ${tok} — ${DANGEROUS[flag]}`);
      if (value === null && flag !== '--privileged') i++; // skip a separate value token
      i++;
      continue;
    }
    if (!ALLOWLIST.has(flag)) {
      refusals.push(`refused flag ${tok} — not in allowlist (-d, --name, --label, -p, -v, -e, --shm-size, --memory)`);
      i++;
      continue;
    }

    if (VALUE_FLAGS.has(flag) && value === null) {
      value = raw[i + 1] ?? null;
      if (value === null) {
        refusals.push(`flag ${flag} is missing its value`);
        i++;
        continue;
      }
      i++; // consume the value token
    }

    switch (flag) {
      case '-d':
        argv.push('-d');
        explanations.push({ flag: '-d', meaning: 'detached mode — container runs in the background' });
        break;
      case '--name':
        argv.push('--name', value as string);
        explanations.push({ flag: `--name ${value}`, meaning: `names the container "${value}"` });
        break;
      case '--label':
        argv.push('--label', value as string);
        explanations.push({ flag: `--label ${value}`, meaning: `attaches label "${value}" to the container` });
        break;
      case '-e': {
        argv.push('-e', value as string);
        const varName = (value as string).split('=')[0];
        explanations.push({ flag: `-e ${value}`, meaning: `sets environment variable ${varName}` });
        break;
      }
      case '--shm-size':
        argv.push('--shm-size', value as string);
        explanations.push({ flag: `--shm-size ${value}`, meaning: `sets /dev/shm size to ${value}` });
        break;
      case '--memory':
        argv.push('--memory', value as string);
        explanations.push({ flag: `--memory ${value}`, meaning: `limits container memory to ${value}` });
        break;
      case '-p': {
        const rewritten = rewritePort(value as string);
        const containerPort = (value as string).split(':').pop() as string;
        argv.push('-p', rewritten);
        explanations.push({
          flag: `-p ${rewritten}`,
          meaning:
            rewritten === value
              ? `publishes container port ${containerPort} on 127.0.0.1 only — Docker allocates a free loopback port atomically`
              : `rewritten from "-p ${value}" — publishes container port ${containerPort} on 127.0.0.1 only (never all interfaces); Docker allocates a free loopback port atomically`,
        });
        break;
      }
      case '-v': {
        const v = value as string;
        if (isDockerDaemonMount(v)) {
          refusals.push(
            `refused -v ${v} — mounting the Docker daemon endpoint (docker.sock / \\\\.\\pipe\\docker_engine) gives the container control of the Docker daemon`,
          );
        }
        if (isBindMount(v)) {
          refusals.push(
            `refused -v ${v} — source "${mountSource(v)}" is a host path, not a named volume: bind mounts refused; named volumes only`,
          );
        } else {
          argv.push('-v', v);
          const [vol, target] = v.split(':');
          explanations.push({ flag: `-v ${v}`, meaning: `mounts named volume "${vol}" at "${target ?? v}"` });
        }
        break;
      }
    }
    i++;
  }

  return { argv, image, refusals, explanations };
}

// --- minimal YAML subset parser (compose files) ---
// Handles the compose shapes we care about: nested maps by indentation,
// scalar values, scalar lists ('- item'), comments. NOT a general YAML parser.

type YamlVal = string | string[] | YamlMap;
interface YamlMap {
  [key: string]: YamlVal;
}

function stripYamlComment(line: string): string {
  if (/["']/.test(line)) return line; // don't risk cutting a quoted '#'
  const i = line.indexOf(' #');
  return i === -1 ? line : line.slice(0, i);
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseYamlSubset(text: string): Record<string, YamlVal> {
  const lines: { indent: number; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripYamlComment(raw);
    if (noComment.trim() === '') continue;
    lines.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim() });
  }
  let pos = 0;

  function parseBlock(indent: number): YamlVal {
    if (pos >= lines.length) return {};
    if (lines[pos].text.startsWith('-')) {
      const arr: string[] = [];
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('-')) {
        const item = lines[pos].text.replace(/^-\s*/, '');
        arr.push(unquote(item));
        pos++;
      }
      return arr;
    }
    const map: Record<string, YamlVal> = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('-')) {
      const t = lines[pos].text;
      const ci = t.indexOf(':');
      if (ci === -1) {
        pos++;
        continue;
      }
      const key = t.slice(0, ci).trim();
      const val = t.slice(ci + 1).trim();
      pos++;
      if (val !== '') {
        map[key] = unquote(val);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        map[key] = parseBlock(lines[pos].indent);
      } else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('-')) {
        map[key] = parseBlock(indent); // list at the same indent as its key
      } else {
        map[key] = '';
      }
    }
    return map;
  }

  if (lines.length === 0) return {};
  const result = parseBlock(lines[0].indent);
  return typeof result === 'object' && !Array.isArray(result) ? result : {};
}

function asStringList(v: YamlVal | undefined): string[] {
  if (v === undefined) return [];
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v;
  return [];
}

function asEnvList(v: YamlVal | undefined): string[] {
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  return Object.entries(v).map(([k, val]) => `${k}=${typeof val === 'string' ? val : ''}`);
}

function applyParsed(plan: TrialPlan, parsed: ParsedRun): void {
  plan.argv = parsed.argv;
  plan.image = parsed.image;
  plan.flag_explanations = parsed.explanations;
  plan.refusals.push(...parsed.refusals);
  plan.ok_to_run = plan.refusals.length === 0 && plan.image !== null;
}

function planFromCompose(text: string, plan: TrialPlan): void {
  const doc = parseYamlSubset(text);
  const services = doc['services'];
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    plan.refusals.push('compose file declares no services');
    return;
  }
  const entry = Object.entries(services)[0];
  if (!entry) {
    plan.refusals.push('compose file declares no services');
    return;
  }
  const [svcName, svcRaw] = entry;
  if (typeof svcRaw !== 'object' || Array.isArray(svcRaw)) {
    plan.refusals.push(`compose service "${svcName}" is empty`);
    return;
  }
  const svc = svcRaw;

  if (svc['build'] !== undefined && svc['build'] !== '') {
    plan.refusals.push(`compose service "${svcName}" uses build: — only prebuilt images supported`);
  }
  if (svc['privileged'] === 'true') {
    plan.refusals.push('refused flag --privileged (compose privileged: true) — grants the container full access to the host');
  }
  if (svc['network_mode'] === 'host') {
    plan.refusals.push('refused flag --network=host (compose network_mode: host) — exposes the trial to the whole LAN');
  }
  if (svc['pid'] === 'host') {
    plan.refusals.push('refused flag --pid=host (compose pid: host) — shares the host PID namespace');
  }
  const caps = asStringList(svc['cap_add']);
  if (caps.length > 0) {
    plan.refusals.push(`refused flag --cap-add (compose cap_add: ${caps.join(', ')}) — adds kernel capabilities`);
  }

  const image = typeof svc['image'] === 'string' && svc['image'] !== '' ? (svc['image'] as string) : null;
  const containerName = typeof svc['container_name'] === 'string' ? (svc['container_name'] as string) : `osm-trial-${svcName}`;

  const argv: string[] = ['-d', '--name', containerName];
  for (const p of asStringList(svc['ports'])) argv.push('-p', p);
  for (const v of asStringList(svc['volumes'])) argv.push('-v', v);
  for (const e of asEnvList(svc['environment'])) argv.push('-e', e);
  if (image) argv.push(image);

  applyParsed(plan, validateRun(argv));
}

/** Extract the first `docker run` command from README text, joining
 *  backslash line-continuations. */
function extractDockerRun(readme: string): string | null {
  const lines = readme.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/docker\s+run\b/i);
    if (!m || m.index === undefined) continue;
    let cmd = lines[i].slice(m.index).trim();
    while (cmd.endsWith('\\') && i + 1 < lines.length) {
      cmd = `${cmd.slice(0, -1)} ${lines[++i].trim()}`;
    }
    return cmd;
  }
  return null;
}

const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.txt', 'README'];

export function planTrial(db: Db, toolId: number): OpResult<TrialPlan> {
  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);
    const dir = diskInstallPath(db, toolId);
    if (!dir) return fail(`tool ${toolId} has no present disk installation to scan`);

    const plan: TrialPlan = {
      ok_to_run: false,
      image: null,
      argv: [],
      flag_explanations: [],
      refusals: [],
      source: '',
    };

    // 1. docker-compose — first service wins.
    for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      plan.source = name;
      planFromCompose(readFileSync(p, 'utf8'), plan);
      const msg = plan.ok_to_run
        ? `planned trial of ${tool.name} from ${name} — NOT executed`
        : `trial of ${tool.name} refused: ${plan.refusals[0] ?? 'see refusals'}`;
      return ok(msg, plan);
    }

    // 2. README documenting a published image via `docker run`.
    for (const name of README_NAMES) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      const cmd = extractDockerRun(readFileSync(p, 'utf8'));
      if (cmd === null) continue;
      plan.source = name;
      const tokens = tokenize(cmd);
      const start = tokens[0] === 'sudo' ? 1 : 0;
      if (tokens[start] !== 'docker' || !/^run$/i.test(tokens[start + 1] ?? '')) {
        plan.refusals.push(`could not parse docker run command: ${cmd}`);
      } else {
        applyParsed(plan, validateRun(tokens.slice(start + 2)));
      }
      const msg = plan.ok_to_run
        ? `planned trial of ${tool.name} from ${name} — NOT executed`
        : `trial of ${tool.name} refused: ${plan.refusals[0] ?? 'see refusals'}`;
      return ok(msg, plan);
    }

    // 3. Dockerfile only — building is Phase 3+.
    if (existsSync(join(dir, 'Dockerfile'))) {
      plan.source = 'Dockerfile';
      plan.refusals.push('building images is Phase 3+; only prebuilt image runs are plannable');
      return ok(`trial of ${tool.name} refused: ${plan.refusals[0]}`, plan);
    }

    return fail(`no docker run instructions found in README/compose/Dockerfile for ${tool.name}`);
  } catch (err) {
    return fail(`plan_trial failed: ${String(err)}`);
  }
}
