import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { OpResult, Verdict } from './types.js';
import {
  type Db,
  addEvent,
  beginTrial,
  endTrial,
  latestTrial,
  selectInstallations,
  selectTool,
  updateToolVerdict,
  upsertObservations,
  withTransaction,
} from './db.js';
import { planTrial } from './preview.js';

/**
 * Phase-3 guarded container execution.
 *
 * Hard rules held here:
 * - NOTHING runs that plan_trial refused. planTrial() is called fresh on every
 *   tryIt(); `ok_to_run === false` is a hard stop, and its refusals are the
 *   failure message.
 * - docker is spawned through execFile with an argv ARRAY, never a shell
 *   string. Repo-supplied text (README/compose) reaches argv only after
 *   preview.ts has validated it against the flag allowlist, and splitArgv()
 *   below re-checks that allowlist as defence in depth.
 * - OWNERSHIP IS NEVER INFERRED FROM ABSENCE OF EVIDENCE. Images and volumes
 *   that already existed before the trial are never recorded as OSM-created,
 *   and therefore can never be removed by tearDown(). Two independent things
 *   must both hold before OSM claims a volume: it carries OUR
 *   `osm.trial=<uid>` label (read back from the daemon, not assumed), and it
 *   was absent from the before-snapshot. A snapshot command that FAILS aborts
 *   the trial before `docker run` — an empty Set from a failed read is
 *   indistinguishable from "nothing exists" and would hand somebody else's
 *   data to `docker volume rm`.
 * - docker missing or its daemon down => every export returns a clean fail().
 *   Nothing in this file throws.
 */

// --- result shapes ---

export interface TrialPort {
  /** e.g. "80/tcp" */
  container_port: string;
  /** Always expected to be a loopback address — the plan rewrites every -p. */
  host_ip: string;
  host_port: string;
}

export interface TrialRun {
  trial_id: number;
  trial_uid: string;
  container: string;
  image: string;
  ports: TrialPort[];
  /** The exact argv handed to docker, starting at "run". */
  argv: string[];
  image_created_by_osm: number;
  volumes_created_by_osm: string[];
  /** Which file the plan came from (README.md, docker-compose.yml, ...). */
  source: string;
  warnings: string[];
}

export interface TeardownReport {
  trial_uid: string;
  container: string | null;
  /** Resources OSM created and has now removed. */
  removed: string[];
  /** Resources deliberately left alone, each with the reason. */
  kept: string[];
  errors: string[];
  verdict: Verdict;
}

export interface TrialLogs {
  container: string;
  tail: number;
  logs: string;
}

export interface TryItOpts {
  /**
   * PLAN.md §Trial safety: "First trial of any source requires explicit
   * confirmation." A tool with no trial history refuses to run until the
   * caller has shown the plan to the user and passes confirm: true.
   */
  confirm?: boolean;
  /** Override the docker binary (tests / non-standard installs). */
  dockerBin?: string;
  /** Per-docker-command timeout in ms. Image pulls get 5x this. */
  timeoutMs?: number;
}

// --- OpResult helpers (same shape as ops.ts / preview.ts) ---

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}

function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

// --- docker invocation ---

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MULTIPLIER = 5;
const MAX_BUFFER = 8 * 1024 * 1024;

interface Cmd {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Best-available error text; null when ok. */
  error: string | null;
}

function dockerBinFrom(opts: { dockerBin?: string }): string {
  // docker ships as docker.exe on Windows, which execFile resolves from PATH
  // without a shell. No .cmd shim is involved (unlike claude/codex).
  return opts.dockerBin ?? process.env.OSM_DOCKER_BIN ?? 'docker';
}

async function docker(
  bin: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Cmd> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr, error: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = e.stderr ?? '';
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr,
      error: stderr.trim() || e.message?.trim() || String(err),
    };
  }
}

/** Daemon reachable? Covers both "docker not installed" and "daemon down". */
async function dockerAvailable(bin: string): Promise<boolean> {
  const res = await docker(bin, ['version', '--format', '{{.Server.Version}}'], 20_000);
  return res.ok && res.stdout.trim() !== '';
}

const DOCKER_UNAVAILABLE =
  'docker is not available (binary missing or daemon not running) — nothing was executed';

function lines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '');
}

// --- image / volume snapshots (ownership evidence) ---

/**
 * Normalize an image reference so "alpine", "alpine:latest",
 * "docker.io/library/alpine:latest" all compare equal. Without this, a trial
 * of "alpine" would look absent next to a snapshot line of "alpine:latest"
 * and OSM would wrongly claim ownership of a shared base image.
 */
function normalizeImageRef(ref: string): string {
  let r = ref.trim();
  for (const prefix of ['index.docker.io/', 'docker.io/', 'registry-1.docker.io/']) {
    if (r.startsWith(prefix)) r = r.slice(prefix.length);
  }
  if (r.startsWith('library/')) r = r.slice('library/'.length);
  if (!r.includes('@')) {
    const lastColon = r.lastIndexOf(':');
    const lastSlash = r.lastIndexOf('/');
    if (lastColon <= lastSlash) r = `${r}:latest`;
  }
  return r;
}

/**
 * A snapshot that knows whether it is real. `ok: false` means the read FAILED
 * and the set is meaningless — callers must abort, never treat it as "empty".
 */
interface Snapshot {
  ok: boolean;
  error: string | null;
  set: Set<string>;
}

function snapshotFailed(error: string | null): Snapshot {
  return { ok: false, error: error ?? 'unknown error', set: new Set<string>() };
}

async function snapshotImages(bin: string): Promise<Snapshot> {
  const res = await docker(bin, ['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (!res.ok) return snapshotFailed(res.error);
  const set = new Set<string>();
  for (const line of lines(res.stdout)) {
    if (line.startsWith('<none>')) continue;
    set.add(normalizeImageRef(line));
  }
  return { ok: true, error: null, set };
}

async function snapshotVolumes(bin: string): Promise<Snapshot> {
  const res = await docker(bin, ['volume', 'ls', '--format', '{{.Name}}']);
  if (!res.ok) return snapshotFailed(res.error);
  return { ok: true, error: null, set: new Set(lines(res.stdout)) };
}

/**
 * The volumes the daemon says carry OUR trial label. This — not a before/after
 * diff, and not the container's mount list — is the ownership signal: OSM
 * stamps `osm.trial=<uid>` on every volume it creates, so anything without it
 * belongs to somebody else no matter when it appeared.
 */
async function labelledVolumes(bin: string, uid: string, timeoutMs: number): Promise<Snapshot> {
  const res = await docker(
    bin,
    ['volume', 'ls', '--filter', `label=osm.trial=${uid}`, '--format', '{{.Name}}'],
    timeoutMs,
  );
  if (!res.ok) return snapshotFailed(res.error);
  return { ok: true, error: null, set: new Set(lines(res.stdout)) };
}

interface VolumeLabelProbe {
  /** The read itself worked. False = state UNKNOWN, so do not remove. */
  ok: boolean;
  missing: boolean;
  /** Value of osm.trial, '' when the volume carries no such label. */
  label: string;
  error: string | null;
}

/** Re-read a volume's `osm.trial` label straight from the daemon. Used as the
 *  last gate before `docker volume rm`, so a stale or wrong DB row can never
 *  destroy a volume OSM did not create. */
async function volumeTrialLabel(bin: string, name: string, timeoutMs: number): Promise<VolumeLabelProbe> {
  const res = await docker(
    bin,
    ['volume', 'inspect', name, '--format', '{{index .Labels "osm.trial"}}'],
    timeoutMs,
  );
  if (res.ok) {
    // A volume with no labels at all renders as Go's "<no value>".
    const raw = res.stdout.trim();
    return { ok: true, missing: false, label: raw === '<no value>' ? '' : raw, error: null };
  }
  const error = res.error ?? 'unknown error';
  if (/no such volume/i.test(error)) return { ok: true, missing: true, label: '', error: null };
  return { ok: false, missing: false, label: '', error };
}

async function imageExists(bin: string, image: string): Promise<boolean> {
  const res = await docker(bin, ['image', 'inspect', image, '--format', '{{.Id}}']);
  return res.ok && res.stdout.trim() !== '';
}

// --- argv construction ---

/**
 * Flag allowlist, mirrored from preview.ts (not exported there, and preview.ts
 * is out of scope for this file). Kept in sync deliberately: this is the
 * last gate before argv reaches the daemon.
 */
const VALUE_FLAGS = new Set(['--name', '--label', '-p', '-v', '-e', '--shm-size', '--memory']);
const NO_VALUE_FLAGS = new Set(['-d']);

/**
 * Docker's named-volume grammar, mirrored from preview.ts. The allowlist here
 * is checked on -v VALUES, not just flag names: a name-only gate would wave
 * through `-v \\.\pipe\docker_engine:...` (full daemon control on Windows) or
 * any UNC/host path that reached the plan.
 */
const NAMED_VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Source half of a -v spec; a drive-letter path keeps its own ':'. */
function mountSource(spec: string): string {
  if (/^[A-Za-z]:[\\/]/.test(spec)) return spec.slice(0, 2);
  return spec.split(':')[0];
}

function isNamedVolumeMount(spec: string): boolean {
  return NAMED_VOLUME_RE.test(mountSource(spec));
}

interface SplitArgv {
  /** Flags (with their values) that precede the image. */
  pre: string[];
  image: string | null;
  /** Command/arguments after the image. */
  tail: string[];
  /** Tokens that are NOT on the allowlist. Non-empty => refuse to run. */
  bad: string[];
}

/** Walk a planned argv, separating flags / image / container command, and
 *  re-verifying every flag against the allowlist. */
function splitArgv(argv: string[]): SplitArgv {
  const pre: string[] = [];
  const bad: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith('-') || tok === '-') break; // first bare token = image

    const eq = tok.indexOf('=');
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const inlineValue = eq !== -1;

    if (!VALUE_FLAGS.has(flag) && !NO_VALUE_FLAGS.has(flag)) {
      bad.push(tok);
      i++;
      continue;
    }
    if (VALUE_FLAGS.has(flag) && !inlineValue) {
      const value = argv[i + 1];
      if (value === undefined) {
        bad.push(`${flag} (missing value)`);
        i++;
        continue;
      }
      if (flag === '-v' && !isNamedVolumeMount(value)) {
        bad.push(`-v ${value} (host path "${mountSource(value)}" — named volumes only)`);
        i += 2;
        continue;
      }
      pre.push(tok, value);
      i += 2;
      continue;
    }
    if (flag === '-v' && inlineValue) {
      const value = tok.slice(eq + 1);
      if (!isNamedVolumeMount(value)) {
        bad.push(`${tok} (host path "${mountSource(value)}" — named volumes only)`);
        i++;
        continue;
      }
    }
    pre.push(tok);
    i++;
  }

  const image = i < argv.length ? argv[i] : null;
  const tail = i < argv.length ? argv.slice(i + 1) : [];
  return { pre, image, tail, bad };
}

/** Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*. */
function containerNameFor(toolName: string): string {
  const slug = toolName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `osm-try-${slug === '' ? 'tool' : slug}`;
}

interface BuiltRun {
  argv: string[];
  /** Named volumes the plan asks for, in mount order. */
  namedVolumes: string[];
}

/**
 * Rebuild the run argv from the plan: force detached mode, force OUR container
 * name, and stamp osm.trial=<uid> last so it wins over any label the repo
 * supplied. Everything else the plan produced is carried through unchanged.
 */
function buildRunArgv(split: SplitArgv, image: string, uid: string, containerName: string): BuiltRun {
  const flags: string[] = [];
  const namedVolumes: string[] = [];

  let i = 0;
  while (i < split.pre.length) {
    const tok = split.pre[i];
    const eq = tok.indexOf('=');
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const inlineValue = eq !== -1;
    const value = inlineValue ? tok.slice(eq + 1) : split.pre[i + 1];
    const step = inlineValue || NO_VALUE_FLAGS.has(flag) ? 1 : 2;

    // Dropped and re-added by us: the repo does not get to name the container
    // or decide whether the trial blocks the caller.
    if (flag === '--name' || flag === '-d') {
      i += step;
      continue;
    }
    if (flag === '-v' && value !== undefined) {
      const volName = value.split(':')[0];
      if (volName !== '') namedVolumes.push(volName);
    }
    flags.push(tok);
    if (step === 2 && value !== undefined) flags.push(value);
    i += step;
  }

  const argv = [
    'run',
    '-d',
    '--name',
    containerName,
    ...flags,
    '--label',
    `osm.trial=${uid}`,
    image,
    ...split.tail,
  ];
  return { argv, namedVolumes };
}

// --- port readback ---

/** Parse `docker port <container>` output: "80/tcp -> 127.0.0.1:49154". */
function parsePorts(stdout: string): TrialPort[] {
  const ports: TrialPort[] = [];
  for (const line of lines(stdout)) {
    const arrow = line.indexOf('->');
    if (arrow === -1) continue;
    const containerPort = line.slice(0, arrow).trim();
    const hostPart = line.slice(arrow + 2).trim();
    const colon = hostPart.lastIndexOf(':');
    if (colon === -1) continue;
    ports.push({
      container_port: containerPort,
      host_ip: hostPart.slice(0, colon),
      host_port: hostPart.slice(colon + 1),
    });
  }
  return ports;
}

function isLoopback(hostIp: string): boolean {
  const ip = hostIp.replace(/^\[|\]$/g, '');
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/** Volume-type mount names actually attached to the container. */
async function containerVolumeMounts(bin: string, container: string): Promise<string[]> {
  const res = await docker(bin, [
    'inspect',
    container,
    '--format',
    '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}\n{{end}}{{end}}',
  ]);
  return res.ok ? lines(res.stdout) : [];
}

// --- disk-installation check (mirrors preview.ts diskInstallPath) ---

const NON_DISK_SOURCES = ['npm-g', 'winget', 'skills-dir'];

function installedOnDisk(db: Db, toolId: number): boolean {
  return selectInstallations(db, toolId).some(
    i => i.present === 1 && !NON_DISK_SOURCES.includes(i.where_),
  );
}

// --- try_it ---

export async function tryIt(db: Db, toolId: number, opts: TryItOpts = {}): Promise<OpResult<TrialRun>> {
  const bin = dockerBinFrom(opts);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    const prior = latestTrial(db, toolId);
    if (prior && prior.ended_at === null) {
      return fail(
        `trial ${prior.trial_uid} of ${tool.name} is still running (container ${prior.container ?? '?'}) — tear it down first`,
      );
    }

    // 1. Re-plan every time. A refused plan is a hard stop.
    const planned = planTrial(db, toolId);
    if (!planned.ok || !planned.data) return fail(planned.message);
    const plan = planned.data;
    if (!plan.ok_to_run) {
      const why = plan.refusals.length > 0 ? plan.refusals.join('; ') : 'plan is not runnable';
      return fail(`refused to run ${tool.name} (${plan.source || 'unknown source'}): ${why}`);
    }
    if (!plan.image) return fail(`plan for ${tool.name} has no image to run`);

    // 2. First trial of a source needs the user to have seen the plan.
    if (!prior && opts.confirm !== true) {
      return fail(
        `first trial of ${tool.name} from ${plan.source} requires explicit confirmation — ` +
          `review the plan (${plan.argv.length} planned args, image ${plan.image}) then re-run with confirm: true`,
      );
    }

    // 3. Re-verify the planned argv against the allowlist before it can run.
    const split = splitArgv(plan.argv);
    if (split.bad.length > 0) {
      return fail(`refused to run ${tool.name}: non-allowlisted flag(s) in plan — ${split.bad.join(', ')}`);
    }
    if (split.image === null) return fail(`plan for ${tool.name} has no image to run`);

    if (!(await dockerAvailable(bin))) return fail(DOCKER_UNAVAILABLE);

    // Pin the exact tag before anything runs. Ownership is decided by comparing
    // against normalized snapshot entries, so the container must run the very
    // ref that comparison was made on: "alpine" and "alpine:latest" are the same
    // image to docker, but only one of them compares equal to `docker images`
    // output — and only a pinned ref makes the recorded trial row unambiguous.
    const image = normalizeImageRef(split.image);
    const uid = randomUUID().replace(/-/g, '').slice(0, 12);
    const container = containerNameFor(tool.name);

    // A probe that FAILED tells us nothing. Proceeding on it is how `docker run`
    // ends up colliding with a container OSM did not create.
    const clash = await docker(bin, ['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Names}}'], timeout);
    if (!clash.ok) {
      return fail(
        `refused to run ${tool.name}: could not check whether container ${container} already exists ` +
          `(${clash.error ?? 'unknown error'}) — nothing was executed`,
      );
    }
    if (lines(clash.stdout).includes(container)) {
      return fail(`container ${container} already exists — remove it (or tear down the previous trial) first`);
    }

    // 4. BEFORE snapshot. Everything already here belongs to the machine, not
    //    to OSM, and must survive teardown. A FAILED snapshot is fatal: an
    //    empty set would read as "the machine owns nothing" and every volume
    //    the run touches would be claimed and later destroyed.
    const imagesBefore = await snapshotImages(bin);
    if (!imagesBefore.ok) {
      return fail(
        `refused to run ${tool.name}: could not list docker images (${imagesBefore.error ?? 'unknown error'}) — ` +
          `resource ownership cannot be established, nothing was executed`,
      );
    }
    const volumesBefore = await snapshotVolumes(bin);
    if (!volumesBefore.ok) {
      return fail(
        `refused to run ${tool.name}: could not list docker volumes (${volumesBefore.error ?? 'unknown error'}) — ` +
          `resource ownership cannot be established, nothing was executed`,
      );
    }
    const imagePresentBefore = imagesBefore.set.has(image) || (await imageExists(bin, image));

    const { argv, namedVolumes } = buildRunArgv(split, image, uid, container);

    // 5. Pull only when genuinely absent, so a shared base image is untouched.
    if (!imagePresentBefore) {
      const pull = await docker(bin, ['pull', image], timeout * PULL_TIMEOUT_MULTIPLIER);
      if (!pull.ok) return fail(`docker pull ${image} failed: ${pull.error ?? 'unknown error'}`);
    }

    // 6. Pre-create only the volumes that do not exist yet, so OSM-made ones
    //    carry the trial label. Pre-existing ones are reused untouched.
    const createdVolumes: string[] = [];
    for (const vol of namedVolumes) {
      if (volumesBefore.set.has(vol)) continue;
      const made = await docker(bin, ['volume', 'create', '--label', `osm.trial=${uid}`, vol], timeout);
      if (made.ok) createdVolumes.push(vol);
    }

    // 7. Run.
    const run = await docker(bin, argv, timeout);
    if (!run.ok) {
      const err = run.error ?? 'unknown error';
      // A name conflict means some OTHER container already holds that name. It
      // is by definition not ours, so the container is never touched — cleanup
      // is limited to what this attempt itself created.
      const nameConflict = /conflict\.|already in use/i.test(err);
      const cleaned = await cleanupFailedStart(
        bin,
        uid,
        createdVolumes,
        imagePresentBefore ? null : image,
        timeout,
        !nameConflict,
      );
      const note = cleaned.length > 0 ? ` (cleaned up: ${cleaned.join(', ')})` : '';
      const conflictNote = nameConflict
        ? ` — container ${container} belongs to something OSM did not create, so it was left untouched`
        : '';
      return fail(`docker run failed for ${tool.name}: ${err}${conflictNote}${note}`);
    }

    const warnings: string[] = [];

    // 8. Ownership. The LABEL is authoritative: only volumes the daemon reports
    //    as carrying osm.trial=<uid> are candidates, and they must also have
    //    been absent from the before-snapshot. Neither the container's mount
    //    list nor an after/before diff can claim a volume on its own — a
    //    concurrent `docker volume create` elsewhere would satisfy both.
    const labelled = await labelledVolumes(bin, uid, timeout);
    let ownedVolumes: string[] = [];
    if (labelled.ok) {
      ownedVolumes = [...labelled.set].filter(v => !volumesBefore.set.has(v)).sort();
    } else {
      warnings.push(
        `could not list volumes labelled osm.trial=${uid} (${labelled.error ?? 'unknown error'}) — ` +
          `no volume is recorded as OSM-created, so teardown will keep them all`,
      );
    }

    const imagesAfter = await snapshotImages(bin);
    const imageOwned = !imagePresentBefore && imagesAfter.ok && imagesAfter.set.has(image);

    // 9. Read the assigned port back — never probe-then-bind.
    const portRes = await docker(bin, ['port', container], timeout);
    const ports = portRes.ok ? parsePorts(portRes.stdout) : [];

    for (const p of ports) {
      if (!isLoopback(p.host_ip)) {
        warnings.push(`port ${p.container_port} is published on ${p.host_ip} — expected loopback only`);
      }
    }
    if (!imagesAfter.ok) {
      warnings.push(
        `could not re-list docker images (${imagesAfter.error ?? 'unknown error'}) — ` +
          `image ${image} recorded as NOT osm-created`,
      );
    } else if (!imagePresentBefore && !imageOwned) {
      warnings.push(`image ${image} was pulled but is not in the image list — recorded as NOT osm-created`);
    }

    const portSummary = ports.map(p => `${p.host_ip}:${p.host_port}->${p.container_port}`).join(', ');

    // 10. Persist: trial row, journal event and verdict change in ONE tx.
    const trialId = withTransaction(db, () => {
      const id = beginTrial(db, toolId, {
        trial_uid: uid,
        container,
        image,
        ports: JSON.stringify(ports),
        image_created_by_osm: imageOwned ? 1 : 0,
        volumes_created_by_osm: ownedVolumes,
      });
      upsertObservations(db, toolId, { trial_running: 1 });
      updateToolVerdict(db, toolId, 'trying', tool.retire_reason);
      addEvent(
        db,
        toolId,
        `trial started ${uid}: ${image} as ${container}` +
          (portSummary === '' ? '' : ` (${portSummary})`) +
          ` [image_created_by_osm=${imageOwned ? 1 : 0}, volumes_created_by_osm=${ownedVolumes.length === 0 ? 'none' : ownedVolumes.join(', ')}]`,
      );
      return id;
    });

    const data: TrialRun = {
      trial_id: trialId,
      trial_uid: uid,
      container,
      image,
      ports,
      argv,
      image_created_by_osm: imageOwned ? 1 : 0,
      volumes_created_by_osm: ownedVolumes,
      source: plan.source,
      warnings,
    };
    return ok(
      `trial ${uid} running: ${container} from ${image}` + (portSummary === '' ? '' : ` on ${portSummary}`),
      data,
    );
  } catch (err) {
    return fail(`try_it failed: ${String(err)}`);
  }
}

/**
 * Best-effort rollback when `docker run` itself fails: leave no orphans and no
 * DB row.
 *
 * Removes ONLY what this attempt provably created. The container is resolved by
 * OUR `osm.trial=<uid>` label — never by name. `docker rm -f <name>` was the
 * bug: on a name conflict the name belongs to a container OSM never created, and
 * force-removing it kills somebody else's running workload. An empty id set
 * means nothing was created, so nothing is removed. Volumes get the same
 * treatment: the label is re-read before any `volume rm`.
 */
async function cleanupFailedStart(
  bin: string,
  uid: string,
  createdVolumes: string[],
  pulledImage: string | null,
  timeoutMs: number,
  removeContainer = true,
): Promise<string[]> {
  const cleaned: string[] = [];

  if (removeContainer) {
    const ids = await docker(bin, ['ps', '-aq', '--filter', `label=osm.trial=${uid}`], timeoutMs);
    if (ids.ok) {
      for (const id of lines(ids.stdout)) {
        const rm = await docker(bin, ['rm', '-f', id], timeoutMs);
        if (rm.ok) cleaned.push(`container ${id}`);
      }
    }
  }

  for (const vol of createdVolumes) {
    const probe = await volumeTrialLabel(bin, vol, timeoutMs);
    if (!probe.ok || probe.missing || probe.label !== uid) continue;
    const res = await docker(bin, ['volume', 'rm', vol], timeoutMs);
    if (res.ok) cleaned.push(`volume ${vol}`);
  }

  if (pulledImage !== null) {
    const res = await docker(bin, ['rmi', pulledImage], timeoutMs);
    if (res.ok) cleaned.push(`image ${pulledImage}`);
  }
  return cleaned;
}

// --- tear_down ---

export async function tearDown(
  db: Db,
  toolId: number,
  opts: { dockerBin?: string; timeoutMs?: number } = {},
): Promise<OpResult<TeardownReport>> {
  const bin = dockerBinFrom(opts);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    const trial = latestTrial(db, toolId);
    if (!trial) return fail(`no trial recorded for ${tool.name}`);
    if (trial.ended_at !== null) {
      return fail(`trial ${trial.trial_uid} of ${tool.name} was already torn down at ${trial.ended_at}`);
    }
    if (!(await dockerAvailable(bin))) return fail(DOCKER_UNAVAILABLE);

    let ownedVolumes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(trial.volumes_created_by_osm || '[]');
      if (Array.isArray(parsed)) ownedVolumes = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      ownedVolumes = [];
    }

    const removed: string[] = [];
    const kept: string[] = [];
    const errors: string[] = [];

    // Inspect BEFORE removal so shared volumes can be named in the report.
    const mounted = trial.container ? await containerVolumeMounts(bin, trial.container) : [];

    // 1. Container: always removed.
    if (trial.container) {
      const rm = await docker(bin, ['rm', '-f', trial.container], timeout);
      if (rm.ok) {
        removed.push(`container ${trial.container}`);
      } else if (/No such container/i.test(rm.error ?? '')) {
        kept.push(`container ${trial.container} was already gone`);
      } else {
        errors.push(`could not remove container ${trial.container}: ${rm.error ?? 'unknown error'}`);
      }
    } else {
      kept.push('no container was recorded for this trial');
    }

    // 2. Volumes: ONLY the ones OSM created — and the recorded row is not
    //    trusted on its own. Each volume's osm.trial label is re-read from the
    //    daemon immediately before removal; anything that does not carry THIS
    //    trial's uid (or cannot be verified) is kept and reported.
    for (const vol of ownedVolumes) {
      const probe = await volumeTrialLabel(bin, vol, timeout);
      if (!probe.ok) {
        kept.push(`kept volume ${vol}: could not verify its osm.trial label (${probe.error ?? 'unknown error'})`);
        continue;
      }
      if (probe.missing) {
        kept.push(`volume ${vol} was already gone`);
        continue;
      }
      if (probe.label !== trial.trial_uid) {
        kept.push(
          `kept volume ${vol}: osm.trial label is ${probe.label === '' ? '(none)' : probe.label}, ` +
            `not this trial (${trial.trial_uid}) — not created by OSM`,
        );
        continue;
      }
      const rm = await docker(bin, ['volume', 'rm', vol], timeout);
      if (rm.ok) {
        removed.push(`volume ${vol}`);
      } else if (/no such volume/i.test(rm.error ?? '')) {
        kept.push(`volume ${vol} was already gone`);
      } else {
        errors.push(`could not remove volume ${vol}: ${rm.error ?? 'unknown error'}`);
      }
    }
    for (const vol of mounted) {
      if (!ownedVolumes.includes(vol)) kept.push(`kept shared volume ${vol} (not created by OSM)`);
    }

    // 3. Image: ONLY if OSM pulled it. A shared base image is never deleted.
    if (trial.image) {
      if (trial.image_created_by_osm === 1) {
        const rm = await docker(bin, ['rmi', trial.image], timeout);
        if (rm.ok) {
          removed.push(`image ${trial.image}`);
        } else {
          errors.push(`could not remove image ${trial.image}: ${rm.error ?? 'unknown error'}`);
        }
      } else {
        kept.push(`kept shared image ${trial.image} (not created by OSM)`);
      }
    }

    // 4. Verdict: back to 'wanted' unless the tool is on disk, in which case
    //    the clone outliving the trial makes 'kept' the honest state. Only a
    //    'trying' verdict is touched — a manual verdict is never clobbered.
    const onDisk = installedOnDisk(db, toolId);
    const nextVerdict: Verdict = onDisk ? 'kept' : 'wanted';
    const changeVerdict = tool.verdict === 'trying';
    const outcome = errors.length > 0 ? 'torn-down-with-errors' : 'torn-down';

    withTransaction(db, () => {
      endTrial(db, trial.id, outcome);
      upsertObservations(db, toolId, { trial_running: 0 });
      if (changeVerdict) updateToolVerdict(db, toolId, nextVerdict, tool.retire_reason);
      const parts = [
        removed.length > 0 ? `removed ${removed.join(', ')}` : 'removed nothing',
        ...kept,
        ...errors,
      ];
      addEvent(db, toolId, `trial ended ${trial.trial_uid} (${outcome}): ${parts.join('; ')}`);
    });

    const report: TeardownReport = {
      trial_uid: trial.trial_uid,
      container: trial.container,
      removed,
      kept,
      errors,
      verdict: changeVerdict ? nextVerdict : tool.verdict,
    };

    const summary = [
      removed.length > 0 ? `removed ${removed.join(', ')}` : 'removed nothing',
      ...kept,
      ...errors,
    ].join('; ');
    return ok(`torn down trial ${trial.trial_uid} of ${tool.name}: ${summary}`, report);
  } catch (err) {
    return fail(`tear_down failed: ${String(err)}`);
  }
}

// --- trial_logs (read-only) ---

export async function trialLogs(
  db: Db,
  toolId: number,
  tailLines = 200,
  opts: { dockerBin?: string; timeoutMs?: number } = {},
): Promise<OpResult<TrialLogs>> {
  const bin = dockerBinFrom(opts);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    const trial = latestTrial(db, toolId);
    if (!trial) return fail(`no trial recorded for ${tool.name}`);
    if (!trial.container) return fail(`trial ${trial.trial_uid} has no container to read logs from`);
    if (!(await dockerAvailable(bin))) return fail(DOCKER_UNAVAILABLE);

    const tail = Number.isFinite(tailLines) && tailLines > 0 ? Math.floor(tailLines) : 200;
    const res = await docker(bin, ['logs', '--tail', String(tail), trial.container], timeout);
    if (!res.ok) {
      return fail(`docker logs failed for ${trial.container}: ${res.error ?? 'unknown error'}`);
    }

    // Container stdout AND stderr both belong in the log view.
    const logs = `${res.stdout}${res.stderr}`;
    return ok(`${tail} line tail of ${trial.container}`, { container: trial.container, tail, logs });
  } catch (err) {
    return fail(`trial_logs failed: ${String(err)}`);
  }
}
