// API client for the same-origin OSM web server (src/web/server.ts).
// Contract notes (server is built in parallel — shapes centralized here on purpose):
//   GET  /api/config            -> { token } possibly wrapped in OpResult
//   GET  /api/tools             -> ToolView[] possibly wrapped in OpResult
//   GET  /api/tools/:id         -> ToolView & { comments } (or { tool, comments })
//   POST /api/tools/track       -> { url, name?, why? }
//   PATCH /api/tools/:id        -> { favorite? | auto_update? | tags? } (tags = full string list)
//   POST /api/tools/:id/comment -> { body }
//   POST /api/tools/:id/retire  -> { reason } (reason REQUIRED)
//   GET/PUT /api/settings       -> Settings
//   POST /api/refresh           -> OpResult with a scan report in data
// Every mutating request carries X-OSM-Token. OpResult {ok,message,data} is unwrapped here.
import type { Comment, Settings, ToolView } from '../../core/types.js';
import type { UpstreamResult } from '../../core/github.js';
import type { TrialPlan, UpdatePreview } from '../../core/preview.js';
import type { TeardownReport, TrialLogs, TrialRun } from '../../core/trial.js';
import type { UpdateResult } from '../../core/update.js';
import type { RegistrarResult, TargetId, TargetStatus } from '../../core/registrar.js';
import type { ReadmeDoc } from '../../core/readme.js';
import type { SandboxResult } from '../../core/sandbox.js';
import type { AutoUpdateSweep } from '../../core/ops.js';

let token = '';

export function hasToken(): boolean {
  return token.length > 0;
}

export interface ToolDetail extends ToolView {
  comments: Comment[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Unwrap OpResult-shaped bodies; throw on !ok or HTTP error. Never silent. */
function unwrap(res: Response, body: unknown): unknown {
  if (isRecord(body) && 'ok' in body) {
    if (body.ok === false) {
      throw new Error(typeof body.message === 'string' ? body.message : `request failed (${res.status})`);
    }
    if ('data' in body && body.data !== undefined) return body.data;
    return body;
  }
  if (!res.ok) {
    const msg = isRecord(body) && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers['X-OSM-Token'] = token;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('server unreachable — is `osm serve` running?');
  }
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  }
  return unwrap(res, parsed);
}

export async function initToken(): Promise<void> {
  const d = await req('GET', '/api/config');
  if (isRecord(d) && typeof d.token === 'string') {
    token = d.token;
  }
  // Token absent (e.g. dev mode without auth) is fine — header is simply omitted.
}

export async function listTools(): Promise<ToolView[]> {
  const d = await req('GET', '/api/tools');
  if (Array.isArray(d)) return d as ToolView[];
  if (isRecord(d) && Array.isArray(d.tools)) return d.tools as ToolView[];
  return [];
}

export async function getTool(id: number): Promise<ToolDetail> {
  const d = await req('GET', `/api/tools/${id}`);
  if (isRecord(d)) {
    // {tool, comments} wrapper must be flattened FIRST — it also has a comments array
    if (isRecord(d.tool)) {
      return { ...(d.tool as unknown as ToolView), comments: Array.isArray(d.comments) ? (d.comments as Comment[]) : [] };
    }
    if (Array.isArray(d.comments)) return d as unknown as ToolDetail;
  }
  throw new Error('unexpected tool detail shape');
}

export async function trackTool(url: string, why: string): Promise<unknown> {
  return req('POST', '/api/tools/track', { url, why });
}

/** favorite / auto_update are booleans on the wire (server contract). */
export async function patchTool(id: number, patch: { favorite?: boolean; auto_update?: boolean }): Promise<unknown> {
  return req('PATCH', `/api/tools/${id}`, patch);
}

export async function addTag(id: number, tag: string): Promise<unknown> {
  return req('POST', `/api/tools/${id}/tags`, { tag });
}

export async function removeTag(id: number, tag: string): Promise<unknown> {
  return req('DELETE', `/api/tools/${id}/tags/${encodeURIComponent(tag)}`);
}

/** Server-side search — used for the filters that need data not present in ToolView. */
export async function searchTools(params: Record<string, string>): Promise<ToolView[]> {
  const qs = new URLSearchParams(params).toString();
  const d = await req('GET', `/api/search${qs ? '?' + qs : ''}`);
  if (Array.isArray(d)) return d as ToolView[];
  if (isRecord(d) && Array.isArray(d.tools)) return d.tools as ToolView[];
  return [];
}

export async function postComment(id: number, body: string): Promise<unknown> {
  return req('POST', `/api/tools/${id}/comment`, { body });
}

export async function retireTool(id: number, reason: string): Promise<unknown> {
  return req('POST', `/api/tools/${id}/retire`, { reason });
}

/* ---------- Phase 2: read-only upstream intelligence ---------- */

/** OpResult with a typed payload — ok:false is DATA here (rendered), not thrown. */
export interface Op<T> {
  ok: boolean;
  message: string;
  data?: T;
}

/** Like req(), but returns the OpResult body as-is so callers can render
 *  ok:false reasons (rate limits, refusals) instead of catching them. */
async function reqOp<T>(method: string, path: string, body?: unknown): Promise<Op<T>> {
  const headers: Record<string, string> = {};
  if (token) headers['X-OSM-Token'] = token;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('server unreachable — is `osm serve` running?');
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  }
  if (isRecord(parsed) && 'ok' in parsed) return parsed as unknown as Op<T>;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ok: true, message: 'ok', data: parsed as T };
}

export async function getUpstream(id: number): Promise<Op<UpstreamResult>> {
  return reqOp<UpstreamResult>('GET', `/api/tools/${id}/upstream`);
}

export async function getTrialPlan(id: number): Promise<Op<TrialPlan>> {
  return reqOp<TrialPlan>('GET', `/api/tools/${id}/plan-trial`);
}

export interface UpstreamRefreshData {
  checked: number;
  errors: string[];
}

/** No limit = check every github repo on the shelf. A partial check is worse
 *  than a slow one: an unchecked row shows the same "—" as a checked one. */
export async function refreshUpstream(limit?: number): Promise<UpstreamRefreshData> {
  const body = await reqOp<UpstreamRefreshData>(
    'POST',
    '/api/upstream/refresh',
    limit === undefined ? {} : { limit },
  );
  if (!body.ok) throw new Error(body.message);
  return body.data ?? { checked: 0, errors: [] };
}

/* ---------- Phase 3/4: guarded execution, updates, registrar ----------
 * Every one of these returns the OpResult as DATA. A refusal ("not
 * fast-forwardable", "non-allowlisted flag", "docker not available") is the
 * most important thing the panel can show — it must never be swallowed into a
 * generic toast. Callers render res.message on ok:false.
 */

export async function getPreviewUpdate(id: number): Promise<Op<UpdatePreview>> {
  return reqOp<UpdatePreview>('GET', `/api/tools/${id}/preview-update`);
}

/** Same preview, but the server may run `git fetch` first. Only call it after
 *  the user has agreed to that — hence POST, not GET. */
export async function getPreviewUpdateFetching(id: number): Promise<Op<UpdatePreview>> {
  return reqOp<UpdatePreview>('POST', `/api/tools/${id}/preview-update`, {});
}

export async function getReadme(id: number): Promise<Op<ReadmeDoc>> {
  return reqOp<ReadmeDoc>('GET', `/api/tools/${id}/readme`);
}

/** Open the tool's folder/file with the OS default handler. */
export async function openToolPath(id: number): Promise<Op<{ path: string; opener: string }>> {
  return reqOp<{ path: string; opener: string }>('POST', `/api/tools/${id}/open`, {});
}

/** Repoint a row at the right upstream repo. */
export async function setUpstream(id: number, url: string): Promise<Op<ToolView>> {
  return reqOp<ToolView>('POST', `/api/tools/${id}/upstream`, { url });
}

/** Fold `id` into `intoId` — they are the same tool found twice. */
export async function mergeTools(id: number, intoId: number): Promise<Op<ToolView>> {
  return reqOp<ToolView>('POST', `/api/tools/${id}/merge`, { intoId });
}

export async function runAutoUpdate(): Promise<Op<AutoUpdateSweep>> {
  return reqOp<AutoUpdateSweep>('POST', '/api/auto-update/run', {});
}

/** confirm:true means the user has SEEN the plan. Never send it blind. */
export async function tryTool(id: number, confirm: boolean): Promise<Op<TrialRun>> {
  return reqOp<TrialRun>('POST', `/api/tools/${id}/try`, { confirm });
}

/** Clone into a container-only checkout (named volume + idle container). */
export async function cloneTool(id: number): Promise<Op<SandboxResult>> {
  return reqOp<SandboxResult>('POST', `/api/tools/${id}/clone`, {});
}

export async function tearDownTool(id: number): Promise<Op<TeardownReport>> {
  return reqOp<TeardownReport>('POST', `/api/tools/${id}/teardown`, {});
}

export async function getTrialLogs(id: number, tail = 200): Promise<Op<TrialLogs>> {
  return reqOp<TrialLogs>('GET', `/api/tools/${id}/trial-logs?tail=${tail}`);
}

export async function applyUpdate(id: number): Promise<Op<UpdateResult>> {
  return reqOp<UpdateResult>('POST', `/api/tools/${id}/update`, {});
}

export async function getMcpTargets(): Promise<Op<TargetStatus[]>> {
  return reqOp<TargetStatus[]>('GET', '/api/mcp/targets');
}

export async function registerMcp(id: number, targets: TargetId[], dryRun: boolean): Promise<Op<RegistrarResult>> {
  return reqOp<RegistrarResult>('POST', `/api/tools/${id}/register`, { targets, dryRun });
}

export async function unregisterMcp(id: number, targets: TargetId[]): Promise<Op<RegistrarResult>> {
  return reqOp<RegistrarResult>('POST', `/api/tools/${id}/unregister`, { targets });
}

export async function getSettings(): Promise<Settings> {
  const d = await req('GET', '/api/settings');
  return d as Settings;
}

export async function putSettings(s: Settings): Promise<unknown> {
  return req('PUT', '/api/settings', s);
}

/** POST /api/refresh — returns a short human summary of the scan report. */
export async function refreshAll(): Promise<string> {
  // raw body: the report message is the useful bit for the toast
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['X-OSM-Token'] = token;
  let res: Response;
  try {
    res = await fetch('/api/refresh', { method: 'POST', headers, body: '{}' });
  } catch {
    throw new Error('server unreachable — is `osm serve` running?');
  }
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text() || 'null');
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
  if (isRecord(body)) {
    if (body.ok === false) throw new Error(typeof body.message === 'string' ? body.message : `refresh failed (${res.status})`);
    const msg = typeof body.message === 'string' ? body.message : '';
    const d = body.data;
    if (isRecord(d)) {
      const parts: string[] = [];
      for (const key of ['scanned', 'found', 'tools', 'total', 'added', 'updated', 'removed']) {
        const v = d[key];
        if (typeof v === 'number') parts.push(`${key} ${v}`);
      }
      return [msg, ...parts].filter(Boolean).join(' · ') || 'refresh complete';
    }
    return msg || 'refresh complete';
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'refresh complete';
}
