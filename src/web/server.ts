import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname, normalize } from 'node:path';
import type { Db } from '../core/db.js';
import type { OpResult, Settings, ToolKind, Verdict } from '../core/types.js';
import { saveSettings } from '../core/settings.js';
import {
  listTools,
  getTool,
  searchTools,
  trackTool,
  commentOnTool,
  retireTool,
  setFavorite,
  setAutoUpdate,
  addToolTag,
  removeToolTag,
  checkUpstreamOp,
  previewUpdateOp,
  planTrialOp,
  refreshAllUpstreamOp,
  tryItOp,
  tearDownOp,
  trialLogsOp,
  applyUpdateOp,
  registerMcpOp,
  unregisterMcpOp,
  detectTargetsOp,
  type SearchQuery,
  type TrackInput,
} from '../core/ops.js';
import { ALL_TARGETS, type McpServerSpec, type RegisterOpts, type TargetId } from '../core/registrar.js';

export interface ServerHandle {
  server: http.Server;
  port: number;
  /** Per-run random token; required as X-OSM-Token on every mutating request. */
  token: string;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  port?: number;
  uiDir?: string;
  /** Wired by the CLI to the real discovery run; absent → /api/refresh returns 501. */
  onRefresh?: (db: Db, settings: Settings) => unknown;
}

const BODY_LIMIT = 1024 * 1024; // 1 MB
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function createOsmServer(
  db: Db,
  settings: Settings,
  opts: CreateServerOptions = {},
): Promise<ServerHandle> {
  const token = randomBytes(24).toString('hex');
  const requestedPort = opts.port ?? settings.port ?? 7807;
  const uiDir = resolve(opts.uiDir ?? resolve(process.cwd(), 'dist', 'ui'));
  let currentSettings = settings;
  const version = await readVersion();
  const startedAt = Date.now();

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  function fail(message: string): OpResult {
    return { ok: false, message };
  }

  /** DNS-rebinding guard: Host must be exactly this server on loopback. */
  function checkHost(req: http.IncomingMessage, port: number): void {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, 'forbidden host');
    }
  }

  /** CSRF guard: allow no Origin, or an Origin pointing at this loopback server. */
  function checkOrigin(req: http.IncomingMessage, port: number): void {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new HttpError(403, 'forbidden origin');
    }
    const hostOk = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!hostOk || url.port !== String(port)) {
      throw new HttpError(403, 'forbidden origin');
    }
  }

  function checkToken(req: http.IncomingMessage): void {
    if (req.headers['x-osm-token'] !== token) {
      throw new HttpError(403, 'missing or invalid X-OSM-Token');
    }
  }

  function requestHasBody(req: http.IncomingMessage): boolean {
    const len = req.headers['content-length'];
    if (len !== undefined) return Number(len) > 0;
    return 'transfer-encoding' in req.headers;
  }

  function checkContentType(req: http.IncomingMessage): void {
    if (!requestHasBody(req)) return;
    const ct = req.headers['content-type'] ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'content-type must be application/json');
    }
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          reject(new HttpError(413, 'body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req);
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new HttpError(400, 'body must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'invalid JSON body');
    }
  }

  function parseId(raw: string | undefined): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid tool id');
    return id;
  }

  function optString(v: unknown): string | undefined {
    return typeof v === 'string' && v !== '' ? v : undefined;
  }

  function boolParam(url: URL, key: string): boolean | undefined {
    const v = url.searchParams.get(key);
    if (v === null) return undefined;
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return undefined;
  }

  /** Registrar targets are an explicit, closed set — never "apply to all". */
  function parseTargets(v: unknown): TargetId[] {
    if (!Array.isArray(v) || v.length === 0) {
      throw new HttpError(400, `targets must be a non-empty array of: ${ALL_TARGETS.join(', ')}`);
    }
    const out: TargetId[] = [];
    for (const raw of v) {
      if (typeof raw !== 'string' || !(ALL_TARGETS as string[]).includes(raw)) {
        throw new HttpError(
          400,
          `unknown target ${JSON.stringify(raw)} — expected one of: ${ALL_TARGETS.join(', ')}`,
        );
      }
      out.push(raw as TargetId);
    }
    return out;
  }

  /** Optional launch-command override. Strictly shaped: a malformed spec would
   *  otherwise be written verbatim into a real agent config. */
  function parseServerSpec(v: unknown): McpServerSpec | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new HttpError(400, 'server must be an object');
    }
    const o = v as Record<string, unknown>;
    if (o.type === 'http') {
      if (typeof o.url !== 'string' || o.url === '') {
        throw new HttpError(400, 'server.url must be a non-empty string');
      }
      return { type: 'http', url: o.url };
    }
    if (o.type !== 'stdio') throw new HttpError(400, "server.type must be 'stdio' or 'http'");
    if (typeof o.command !== 'string' || o.command === '') {
      throw new HttpError(400, 'server.command must be a non-empty string');
    }
    const args: string[] = [];
    if (o.args !== undefined) {
      if (!Array.isArray(o.args) || o.args.some(a => typeof a !== 'string')) {
        throw new HttpError(400, 'server.args must be an array of strings');
      }
      args.push(...(o.args as string[]));
    }
    const env: Record<string, string> = {};
    if (o.env !== undefined) {
      if (typeof o.env !== 'object' || o.env === null || Array.isArray(o.env)) {
        throw new HttpError(400, 'server.env must be an object of strings');
      }
      for (const [k, val] of Object.entries(o.env as Record<string, unknown>)) {
        if (typeof val !== 'string') throw new HttpError(400, `server.env.${k} must be a string`);
        env[k] = val;
      }
    }
    return { type: 'stdio', command: o.command, args, env };
  }

  function boolField(body: Record<string, unknown>, key: string): boolean {
    const v = body[key];
    if (v !== undefined && typeof v !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
    return v === true;
  }

  /** Registrar knobs shared by register + unregister. `env` is deliberately NOT
   *  accepted over HTTP: it is a test seam for isolating HOME, not an input. */
  function registrarOpts(body: Record<string, unknown>): RegisterOpts {
    const opts: RegisterOpts = {};
    const serverName = optString(body.serverName);
    if (serverName !== undefined) opts.serverName = serverName;
    const dockerProfile = optString(body.dockerProfile);
    if (dockerProfile !== undefined) opts.dockerProfile = dockerProfile;
    const dockerRef = optString(body.dockerRef);
    if (dockerRef !== undefined) opts.dockerRef = dockerRef;
    return opts;
  }

  function assertStringArray(v: unknown, field: string): asserts v is string[] {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
      throw new HttpError(400, `settings.${field} must be an array of strings`);
    }
  }

  /** Loose validation: known keys only, type-checked, merged over current settings. */
  function mergeSettings(current: Settings, patch: Record<string, unknown>): Settings {
    const next: Settings = structuredClone(current);
    if (patch.scanDirs !== undefined) {
      assertStringArray(patch.scanDirs, 'scanDirs');
      next.scanDirs = patch.scanDirs;
    }
    if (patch.skillsDirs !== undefined) {
      assertStringArray(patch.skillsDirs, 'skillsDirs');
      next.skillsDirs = patch.skillsDirs;
    }
    if (patch.clonePath !== undefined) {
      if (typeof patch.clonePath !== 'string') throw new HttpError(400, 'settings.clonePath must be a string');
      next.clonePath = patch.clonePath;
    }
    if (patch.port !== undefined) {
      if (typeof patch.port !== 'number' || !Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
        throw new HttpError(400, 'settings.port must be an integer 1-65535');
      }
      next.port = patch.port;
    }
    if (patch.autoUpdateDefault !== undefined) {
      if (typeof patch.autoUpdateDefault !== 'boolean') {
        throw new HttpError(400, 'settings.autoUpdateDefault must be a boolean');
      }
      next.autoUpdateDefault = patch.autoUpdateDefault;
    }
    if (patch.registerTargets !== undefined) {
      next.registerTargets = mergeBoolGroup(current.registerTargets, patch.registerTargets, 'registerTargets');
    }
    if (patch.catalogs !== undefined) {
      next.catalogs = mergeBoolGroup(current.catalogs, patch.catalogs, 'catalogs');
    }
    return next;
  }

  /** Merge a boolean-flags settings group; unknown keys and non-booleans rejected. */
  function mergeBoolGroup<T extends Record<string, boolean>>(current: T, patch: unknown, name: string): T {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new HttpError(400, `settings.${name} must be an object`);
    }
    const merged: Record<string, boolean> = { ...current };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!(k in merged)) throw new HttpError(400, `unknown settings.${name} key: ${k}`);
      if (typeof v !== 'boolean') throw new HttpError(400, `settings.${name}.${k} must be a boolean`);
      merged[k] = v;
    }
    return merged as T;
  }

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean); // e.g. ['api','tools','3']
    const resource = segments[1];

    if (method === 'GET' && resource === 'health' && segments.length === 2) {
      // Liveness probe: non-mutating, no token (Host check still applies
      // globally). The SELECT 1 proves the db handle actually works.
      db.prepare('SELECT 1 AS ok').get();
      sendJson(res, 200, {
        ok: true,
        version,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        db: 'ok',
      });
      return;
    }

    if (method === 'GET' && resource === 'config' && segments.length === 2) {
      sendJson(res, 200, {
        token,
        version,
        settingsSummary: {
          port: currentSettings.port,
          scanDirs: currentSettings.scanDirs,
          skillsDirs: currentSettings.skillsDirs,
          clonePath: currentSettings.clonePath,
          autoUpdateDefault: currentSettings.autoUpdateDefault,
          registerTargets: currentSettings.registerTargets,
          catalogs: currentSettings.catalogs,
        },
      });
      return;
    }

    if (resource === 'tools') {
      // GET /api/tools
      if (method === 'GET' && segments.length === 2) {
        sendJson(res, 200, listTools(db));
        return;
      }
      // POST /api/tools/track
      if (method === 'POST' && segments[2] === 'track' && segments.length === 3) {
        const body = await parseJsonBody(req);
        const input: TrackInput = {
          url: optString(body.url),
          name: optString(body.name),
          kind: optString(body.kind) as ToolKind | undefined,
          why: optString(body.why),
        };
        sendJson(res, 200, trackTool(db, input));
        return;
      }
      const id = segments.length >= 3 ? parseId(segments[2]) : undefined;
      // GET /api/tools/:id
      if (method === 'GET' && id !== undefined && segments.length === 3) {
        sendJson(res, 200, getTool(db, id));
        return;
      }
      // GET /api/tools/:id/upstream — live check (GET: non-mutating route shape, no token)
      if (method === 'GET' && id !== undefined && segments[3] === 'upstream' && segments.length === 4) {
        sendJson(res, 200, await checkUpstreamOp(db, id));
        return;
      }
      // GET /api/tools/:id/preview-update — read-only fast-forward preview
      if (method === 'GET' && id !== undefined && segments[3] === 'preview-update' && segments.length === 4) {
        sendJson(res, 200, previewUpdateOp(db, id));
        return;
      }
      // GET /api/tools/:id/plan-trial — read-only docker-run plan (never executed)
      if (method === 'GET' && id !== undefined && segments[3] === 'plan-trial' && segments.length === 4) {
        sendJson(res, 200, planTrialOp(db, id));
        return;
      }
      // POST /api/tools/:id/comment
      if (method === 'POST' && id !== undefined && segments[3] === 'comment' && segments.length === 4) {
        const body = await parseJsonBody(req);
        if (typeof body.body !== 'string' || body.body.trim() === '') {
          throw new HttpError(400, 'comment body is required');
        }
        sendJson(res, 200, commentOnTool(db, id, body.body));
        return;
      }
      // POST /api/tools/:id/retire
      if (method === 'POST' && id !== undefined && segments[3] === 'retire' && segments.length === 4) {
        const body = await parseJsonBody(req);
        if (typeof body.reason !== 'string' || body.reason.trim() === '') {
          throw new HttpError(400, 'retire reason is required');
        }
        sendJson(res, 200, retireTool(db, id, body.reason));
        return;
      }
      // PATCH /api/tools/:id
      if (method === 'PATCH' && id !== undefined && segments.length === 3) {
        const body = await parseJsonBody(req);
        let result: OpResult | undefined;
        if (body.favorite !== undefined) {
          if (typeof body.favorite !== 'boolean') throw new HttpError(400, 'favorite must be a boolean');
          result = setFavorite(db, id, body.favorite);
        }
        if (body.auto_update !== undefined) {
          if (typeof body.auto_update !== 'boolean') throw new HttpError(400, 'auto_update must be a boolean');
          result = setAutoUpdate(db, id, body.auto_update);
        }
        if (!result) throw new HttpError(400, 'nothing to update (favorite? auto_update?)');
        sendJson(res, 200, result);
        return;
      }
      // POST /api/tools/:id/tags
      if (method === 'POST' && id !== undefined && segments[3] === 'tags' && segments.length === 4) {
        const body = await parseJsonBody(req);
        if (typeof body.tag !== 'string' || body.tag.trim() === '') {
          throw new HttpError(400, 'tag is required');
        }
        sendJson(res, 200, addToolTag(db, id, body.tag.trim()));
        return;
      }
      // DELETE /api/tools/:id/tags/:tag
      if (method === 'DELETE' && id !== undefined && segments[3] === 'tags' && segments.length === 5) {
        const tag = decodeURIComponent(segments[4]);
        sendJson(res, 200, removeToolTag(db, id, tag));
        return;
      }

      // --- Phase 3/4 ---
      // Every POST below is a MUTATING route shape, so the global guard in
      // createServer() has already enforced Origin + X-OSM-Token + JSON
      // content-type before handleApi() was reached. The GET below is
      // read-only (docker logs) and follows the same no-token shape as
      // /upstream, /preview-update and /plan-trial.

      // POST /api/tools/:id/try { confirm? } — guarded Docker trial
      if (method === 'POST' && id !== undefined && segments[3] === 'try' && segments.length === 4) {
        const body = await parseJsonBody(req);
        sendJson(res, 200, await tryItOp(db, id, { confirm: boolField(body, 'confirm') }));
        return;
      }
      // POST /api/tools/:id/teardown — removes only OSM-created resources
      if (method === 'POST' && id !== undefined && segments[3] === 'teardown' && segments.length === 4) {
        await parseJsonBody(req);
        sendJson(res, 200, await tearDownOp(db, id));
        return;
      }
      // GET /api/tools/:id/trial-logs?tail=200 — read-only
      if (method === 'GET' && id !== undefined && segments[3] === 'trial-logs' && segments.length === 4) {
        const raw = url.searchParams.get('tail');
        let tail = 200;
        if (raw !== null) {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 10_000) {
            throw new HttpError(400, 'tail must be an integer 1-10000');
          }
          tail = n;
        }
        sendJson(res, 200, await trialLogsOp(db, id, tail));
        return;
      }
      // POST /api/tools/:id/update { allowGlobal? } — fast-forward only
      if (method === 'POST' && id !== undefined && segments[3] === 'update' && segments.length === 4) {
        const body = await parseJsonBody(req);
        sendJson(res, 200, await applyUpdateOp(db, id, { allowGlobal: boolField(body, 'allowGlobal') }));
        return;
      }
      // POST /api/tools/:id/register { targets, dryRun? }
      if (method === 'POST' && id !== undefined && segments[3] === 'register' && segments.length === 4) {
        const body = await parseJsonBody(req);
        const targets = parseTargets(body.targets);
        const opts: RegisterOpts = { ...registrarOpts(body), dryRun: boolField(body, 'dryRun') };
        const spec = parseServerSpec(body.server);
        if (spec !== undefined) opts.server = spec;
        sendJson(res, 200, await registerMcpOp(db, id, targets, opts));
        return;
      }
      // POST /api/tools/:id/unregister { targets }
      if (method === 'POST' && id !== undefined && segments[3] === 'unregister' && segments.length === 4) {
        const body = await parseJsonBody(req);
        const targets = parseTargets(body.targets);
        sendJson(res, 200, await unregisterMcpOp(db, id, targets, registrarOpts(body)));
        return;
      }
    }

    // GET /api/mcp/targets — which agents exist here (read-only detection)
    if (method === 'GET' && resource === 'mcp' && segments[2] === 'targets' && segments.length === 3) {
      sendJson(res, 200, detectTargetsOp());
      return;
    }

    // GET /api/search?q=&favorite=&tag=&verdict=&noEvidenceOfUse=&hasUpdate=
    if (method === 'GET' && resource === 'search' && segments.length === 2) {
      const filters: SearchQuery = {
        text: url.searchParams.get('q') ?? undefined,
        favorite: boolParam(url, 'favorite'),
        tag: url.searchParams.get('tag') ?? undefined,
        verdict: (url.searchParams.get('verdict') ?? undefined) as Verdict | undefined,
        noEvidenceOfUse: boolParam(url, 'noEvidenceOfUse'),
        hasUpdate: boolParam(url, 'hasUpdate'),
      };
      sendJson(res, 200, searchTools(db, filters));
      return;
    }

    // POST /api/refresh
    if (method === 'POST' && resource === 'refresh' && segments.length === 2) {
      if (!opts.onRefresh) {
        sendJson(res, 501, fail('refresh is not wired in this process'));
        return;
      }
      const report = (await opts.onRefresh(db, currentSettings)) as OpResult | undefined;
      sendJson(
        res,
        200,
        report && typeof report === 'object' && 'ok' in report
          ? report
          : ({ ok: true, message: 'refresh complete', data: report ?? null } satisfies OpResult),
      );
      return;
    }

    // POST /api/upstream/refresh { limit? } — writes observations, so it is a
    // MUTATING route shape: POST ⇒ token + Origin checks apply (global guard).
    if (method === 'POST' && resource === 'upstream' && segments[2] === 'refresh' && segments.length === 3) {
      const body = await parseJsonBody(req);
      let limit: number | undefined;
      if (body.limit !== undefined) {
        if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1) {
          throw new HttpError(400, 'limit must be a positive integer');
        }
        limit = body.limit;
      }
      sendJson(res, 200, await refreshAllUpstreamOp(db, limit));
      return;
    }

    // GET|PUT /api/settings
    if (resource === 'settings' && segments.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, message: 'ok', data: currentSettings } satisfies OpResult);
        return;
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req);
        currentSettings = mergeSettings(currentSettings, body);
        saveSettings(currentSettings);
        sendJson(res, 200, { ok: true, message: 'settings saved', data: currentSettings } satisfies OpResult);
        return;
      }
    }

    throw new HttpError(404, 'not found');
  }

  async function serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method not allowed');
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    // Resolve inside uiDir and refuse traversal outside it.
    const filePath = resolve(uiDir, `.${normalize(decoded)}`);
    if (filePath !== uiDir && !filePath.startsWith(uiDir + sep)) {
      throw new HttpError(403, 'forbidden path');
    }
    const tryFiles = decoded.endsWith('/') || decoded === '' ? [resolve(filePath, 'index.html')] : [filePath];
    for (const candidate of tryFiles) {
      try {
        const content = await readFile(candidate);
        res.writeHead(200, {
          'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      } catch {
        // fall through to SPA fallback
      }
    }
    // SPA fallback: any non-/api GET that didn't hit a file gets index.html.
    try {
      const content = await readFile(resolve(uiDir, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const boundPort = (server.address() as { port: number }).port;
      try {
        checkHost(req, boundPort);
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
          const method = req.method ?? 'GET';
          if (MUTATING_METHODS.has(method)) {
            checkOrigin(req, boundPort);
            checkToken(req);
            checkContentType(req);
          }
          await handleApi(req, res, url);
        } else {
          await serveStatic(req, res, url);
        }
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, fail(err.message));
        } else {
          sendJson(res, 500, fail('internal error'));
        }
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    token,
    close(): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolvePromise()));
      });
    },
  };
}

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
