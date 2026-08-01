import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../dist/core/db.js';
import { DEFAULT_SETTINGS } from '../dist/core/types.js';
import * as ops from '../dist/core/ops.js';
import { createOsmServer, type ServerHandle } from '../dist/web/server.js';
import {
  TOOLS,
  callOsmTool,
  createOsmMcpServer,
  findTool,
  renderResult,
  type OsmToolDef,
} from '../dist/mcp/server.js';

// Tests run against compiled output: `npx tsc -p tsconfig.json` first, same as
// every other suite here.
//
// SAFETY: no network, no docker, no agent CLI is ever spawned.
//  - Every case that would reach docker or a registrar CLI is set up to fail
//    EARLIER than that (unknown tool id, or a tool with no disk installation),
//    which is exactly where the guards live. Nothing on this machine is touched.
//  - No test writes to a real agent config. GET /api/mcp/targets only *reads*
//    PATH and checks for the existence of config files, which PLAN.md permits.

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];
const handles: ServerHandle[] = [];

after(async () => {
  for (const h of handles.splice(0)) {
    try {
      await h.close();
    } catch {
      // already closed
    }
  }
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): ReturnType<typeof openDb> {
  const dir = mkdtempSync(join(tmpdir(), 'osm-mcp-test-'));
  tmpDirs.push(dir);
  const db = openDb(join(dir, 'osm.db'));
  openDbs.push(db);
  return db;
}

/* ------------------------------------------------------------------ *
 * 1. Identity: one function per operation, shared by both doors.
 * ------------------------------------------------------------------ */

/**
 * The contract this whole file exists to defend: an MCP tool and its HTTP route
 * are two doors onto the SAME function in src/core/ops.ts. `op` is the exact
 * function object the route imports — not a copy, not a wrapper around a copy.
 */
const PAIRS: Array<{ tool: string; op: keyof typeof ops; route: string }> = [
  { tool: 'search', op: 'searchTools', route: 'GET /api/search' },
  { tool: 'track', op: 'trackTool', route: 'POST /api/tools/track' },
  { tool: 'comment', op: 'commentOnTool', route: 'POST /api/tools/:id/comment' },
  { tool: 'try_it', op: 'tryItOp', route: 'POST /api/tools/:id/try' },
  { tool: 'tear_down', op: 'tearDownOp', route: 'POST /api/tools/:id/teardown' },
  { tool: 'register_mcp', op: 'registerMcpOp', route: 'POST /api/tools/:id/register' },
  { tool: 'retire', op: 'retireTool', route: 'POST /api/tools/:id/retire' },
  { tool: 'update', op: 'applyUpdateOp', route: 'POST /api/tools/:id/update' },
  { tool: 'unregister_mcp', op: 'unregisterMcpOp', route: 'POST /api/tools/:id/unregister' },
];

test('the tool table is exactly the planned set, with no duplicates', () => {
  const names = TOOLS.map(t => t.name);
  assert.deepEqual([...names].sort(), [...PAIRS.map(p => p.tool)].sort());
  assert.equal(new Set(names).size, names.length, 'duplicate tool name');
});

test('every MCP tool holds the identical ops.ts function its HTTP route calls', () => {
  for (const pair of PAIRS) {
    const tool = findTool(pair.tool);
    assert.ok(tool, `tool ${pair.tool} is missing`);
    const opFn = ops[pair.op];
    assert.equal(typeof opFn, 'function', `ops.${String(pair.op)} is not a function`);
    assert.ok(
      Object.is(tool.op, opFn),
      `${pair.tool} does not dispatch through ops.${String(pair.op)} (the function ${pair.route} calls)`,
    );
  }
});

test('no tool reaches around ops.ts for its implementation', () => {
  // Anything callable that is NOT one of the ops exports would mean a second
  // implementation had crept in behind the MCP door.
  const opFunctions = new Set(Object.values(ops).filter(v => typeof v === 'function'));
  for (const tool of TOOLS) {
    assert.ok(opFunctions.has(tool.op as never), `${tool.name}.op is not an export of core/ops.ts`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. inputSchema well-formedness.
 * ------------------------------------------------------------------ */

const SCHEMA_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);

test('every inputSchema is a well-formed, JSON-serializable object schema', () => {
  for (const tool of TOOLS as OsmToolDef[]) {
    const where = `tool ${tool.name}`;
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${where}: name must be lower_snake_case`);
    assert.equal(typeof tool.description, 'string', `${where}: description missing`);
    assert.ok(tool.description.length > 40, `${where}: description is too thin to guide a model`);
    assert.equal(typeof tool.argsFor, 'function', `${where}: argsFor missing`);

    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object', `${where}: inputSchema.type must be "object"`);
    assert.equal(schema.additionalProperties, false, `${where}: inputSchema must refuse extra properties`);
    assert.ok(
      schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties),
      `${where}: inputSchema.properties must be an object`,
    );

    for (const [key, prop] of Object.entries(schema.properties)) {
      const at = `${where}.${key}`;
      assert.match(key, /^[A-Za-z][A-Za-z0-9_]*$/, `${at}: odd property name`);
      assert.ok(SCHEMA_TYPES.has(prop.type), `${at}: unknown JSON Schema type ${String(prop.type)}`);
      assert.equal(typeof prop.description, 'string', `${at}: description missing`);
      assert.ok(prop.description.length > 0, `${at}: description is empty`);
      if (prop.enum !== undefined) {
        assert.ok(Array.isArray(prop.enum) && prop.enum.length > 0, `${at}: enum must be a non-empty array`);
        assert.ok(prop.enum.every(v => typeof v === 'string'), `${at}: enum values must be strings`);
      }
      if (prop.type === 'array') {
        assert.ok(prop.items !== undefined, `${at}: array property needs items`);
        assert.equal(typeof prop.items?.type, 'string', `${at}: items.type must be a string`);
      }
    }

    const required = schema.required ?? [];
    assert.ok(Array.isArray(required), `${where}: required must be an array`);
    for (const key of required) {
      assert.equal(typeof key, 'string', `${where}: required entries must be strings`);
      assert.ok(key in schema.properties, `${where}: required "${key}" is not declared in properties`);
    }

    // It has to survive the wire.
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, `${where}: schema is not JSON round-trippable`);
  }
});

test('every tool that acts on a specific tool requires tool_id', () => {
  for (const tool of TOOLS as OsmToolDef[]) {
    if (!('tool_id' in tool.inputSchema.properties)) continue;
    assert.ok(
      (tool.inputSchema.required ?? []).includes('tool_id'),
      `${tool.name} declares tool_id but does not require it`,
    );
    assert.equal(tool.inputSchema.properties.tool_id.type, 'integer');
  }
  // search and track are the only two that take no tool_id — everything else
  // must, or an agent has no way to name what it is acting on.
  const withoutId = TOOLS.filter(t => !('tool_id' in t.inputSchema.properties)).map(t => t.name);
  assert.deepEqual(withoutId.sort(), ['search', 'track']);
});

/* ------------------------------------------------------------------ *
 * 3. Behavioural identity: same input in either door, same answer out.
 * ------------------------------------------------------------------ */

interface HttpCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

interface Case {
  tool: string;
  args: Record<string, unknown>;
  http: HttpCall;
  /** What the shared op is expected to answer, as a sanity anchor. */
  expect: RegExp;
}

/**
 * Every case below is chosen so the shared op refuses BEFORE it would reach
 * docker, the network, or an agent CLI — that refusal is the guard, and it is
 * identical whichever door the call arrived through.
 */
const CASES: Case[] = [
  { tool: 'search', args: { text: 'widget' }, http: { method: 'GET', path: '/api/search?q=widget' }, expect: /tool\(s\)/ },
  {
    tool: 'track',
    args: { url: 'https://github.com/owner/second', why: 'a second one' },
    http: { method: 'POST', path: '/api/tools/track', body: { url: 'https://github.com/owner/second', why: 'a second one' } },
    expect: /tracked second/,
  },
  {
    tool: 'comment',
    args: { tool_id: 1, body: 'a note from both doors' },
    http: { method: 'POST', path: '/api/tools/1/comment', body: { body: 'a note from both doors' } },
    expect: /comment added/,
  },
  {
    tool: 'try_it',
    args: { tool_id: 1 },
    http: { method: 'POST', path: '/api/tools/1/try', body: {} },
    expect: /no present disk installation/,
  },
  {
    tool: 'tear_down',
    args: { tool_id: 1 },
    http: { method: 'POST', path: '/api/tools/1/teardown', body: {} },
    expect: /no trial recorded/,
  },
  {
    tool: 'update',
    args: { tool_id: 1 },
    http: { method: 'POST', path: '/api/tools/1/update', body: {} },
    expect: /no present disk installation/,
  },
  {
    tool: 'retire',
    args: { tool_id: 999, reason: 'never existed' },
    http: { method: 'POST', path: '/api/tools/999/retire', body: { reason: 'never existed' } },
    expect: /tool 999 not found/,
  },
  {
    tool: 'register_mcp',
    args: { tool_id: 999, targets: ['claude'] },
    http: { method: 'POST', path: '/api/tools/999/register', body: { targets: ['claude'] } },
    expect: /tool 999 not found/,
  },
  {
    tool: 'unregister_mcp',
    args: { tool_id: 999, targets: ['claude'] },
    http: { method: 'POST', path: '/api/tools/999/unregister', body: { targets: ['claude'] } },
    expect: /tool 999 not found/,
  },
];

test('every MCP tool and its HTTP route return the same answer for the same input', async () => {
  // Two databases kept in lockstep: the HTTP server drives one, callOsmTool the
  // other. Identical seed, identical calls in identical order — any divergence
  // in the answer means the two doors are not sharing a code path.
  const dbHttp = freshDb();
  const dbMcp = freshDb();
  for (const db of [dbHttp, dbMcp]) {
    const seeded = ops.trackTool(db, { url: 'https://github.com/owner/widget', why: 'seed' });
    assert.equal(seeded.ok, true);
    assert.equal(seeded.data?.id, 1);
  }

  const handle = await createOsmServer(dbHttp, structuredClone(DEFAULT_SETTINGS), {
    port: 0,
    uiDir: join(tmpdir(), 'osm-mcp-test-no-ui'),
  });
  handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;

  for (const c of CASES) {
    const init: RequestInit =
      c.http.method === 'GET'
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-osm-token': handle.token },
            body: JSON.stringify(c.http.body ?? {}),
          };
    const res = await fetch(base + c.http.path, init);
    assert.equal(res.status, 200, `${c.tool}: ${c.http.method} ${c.http.path} returned ${res.status}`);
    const viaHttp = (await res.json()) as { ok: boolean; message: string };

    const viaMcp = await callOsmTool(dbMcp, c.tool, c.args);

    assert.equal(viaMcp.ok, viaHttp.ok, `${c.tool}: ok differs (http ${viaHttp.ok}, mcp ${viaMcp.ok})`);
    assert.equal(viaMcp.message, viaHttp.message, `${c.tool}: message differs`);
    assert.match(viaMcp.message, c.expect, `${c.tool}: unexpected message "${viaMcp.message}"`);
  }
});

/* ------------------------------------------------------------------ *
 * 4. The new HTTP routes inherit the existing guards.
 * ------------------------------------------------------------------ */

test('new mutating routes require the token, the JSON content-type and a same-origin Origin', async () => {
  const db = freshDb();
  const seeded = ops.trackTool(db, { url: 'https://github.com/owner/guarded' });
  assert.equal(seeded.data?.id, 1);
  const handle = await createOsmServer(db, structuredClone(DEFAULT_SETTINGS), {
    port: 0,
    uiDir: join(tmpdir(), 'osm-mcp-test-no-ui'),
  });
  handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;

  const mutating = [
    { path: '/api/tools/1/try', body: {} },
    { path: '/api/tools/1/teardown', body: {} },
    { path: '/api/tools/1/update', body: {} },
    { path: '/api/tools/1/register', body: { targets: ['claude'] } },
    { path: '/api/tools/1/unregister', body: { targets: ['claude'] } },
  ];

  for (const m of mutating) {
    const noToken = await fetch(base + m.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(m.body),
    });
    assert.equal(noToken.status, 403, `${m.path} accepted a request with no token`);

    const badToken = await fetch(base + m.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-osm-token': 'nope' },
      body: JSON.stringify(m.body),
    });
    assert.equal(badToken.status, 403, `${m.path} accepted a bad token`);

    const crossOrigin = await fetch(base + m.path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-osm-token': handle.token,
        origin: 'http://evil.example.com',
      },
      body: JSON.stringify(m.body),
    });
    assert.equal(crossOrigin.status, 403, `${m.path} accepted a cross-origin request`);

    const wrongType = await fetch(base + m.path, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-osm-token': handle.token },
      body: 'nope',
    });
    assert.equal(wrongType.status, 415, `${m.path} accepted a non-JSON content-type`);
  }
});

test('register/unregister reject an empty or unknown target list before doing anything', async () => {
  const db = freshDb();
  ops.trackTool(db, { url: 'https://github.com/owner/targets' });
  const handle = await createOsmServer(db, structuredClone(DEFAULT_SETTINGS), {
    port: 0,
    uiDir: join(tmpdir(), 'osm-mcp-test-no-ui'),
  });
  handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-osm-token': handle.token },
      body: JSON.stringify(body),
    });

  assert.equal((await post('/api/tools/1/register', { targets: [] })).status, 400);
  assert.equal((await post('/api/tools/1/register', { targets: ['not-an-agent'] })).status, 400);
  assert.equal((await post('/api/tools/1/register', {})).status, 400);
  assert.equal((await post('/api/tools/1/unregister', { targets: [42] })).status, 400);

  // The MCP door refuses the same inputs, as data rather than a status code.
  for (const bad of [{ tool_id: 1, targets: [] }, { tool_id: 1, targets: ['not-an-agent'] }, { tool_id: 1 }]) {
    const res = await callOsmTool(db, 'register_mcp', bad);
    assert.equal(res.ok, false);
    assert.match(res.message, /targets must be a non-empty array|unknown target/);
  }
});

test('GET /api/mcp/targets and /api/tools/:id/trial-logs are read-only and need no token', async () => {
  const db = freshDb();
  ops.trackTool(db, { url: 'https://github.com/owner/reader' });
  const handle = await createOsmServer(db, structuredClone(DEFAULT_SETTINGS), {
    port: 0,
    uiDir: join(tmpdir(), 'osm-mcp-test-no-ui'),
  });
  handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;

  const targets = await fetch(`${base}/api/mcp/targets`);
  assert.equal(targets.status, 200);
  const tBody = (await targets.json()) as { ok: boolean; data: Array<{ id: string; can_register: boolean }> };
  assert.equal(tBody.ok, true);
  assert.ok(Array.isArray(tBody.data) && tBody.data.length > 0);
  // Detection only reports; it never claims to have written anything.
  for (const t of tBody.data) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.can_register, 'boolean');
  }
  // Same answer as the op the route calls.
  assert.deepEqual(tBody.data, ops.detectTargetsOp().data);

  // No trial exists, so this refuses before it would ever spawn docker.
  const logs = await fetch(`${base}/api/tools/1/trial-logs`);
  assert.equal(logs.status, 200);
  const lBody = (await logs.json()) as { ok: boolean; message: string };
  assert.equal(lBody.ok, false);
  assert.match(lBody.message, /no trial recorded/);
  assert.deepEqual(lBody, JSON.parse(JSON.stringify(await ops.trialLogsOp(db, 1))));

  const badTail = await fetch(`${base}/api/tools/1/trial-logs?tail=0`);
  assert.equal(badTail.status, 400);
});

/* ------------------------------------------------------------------ *
 * 5. Dispatch behaviour.
 * ------------------------------------------------------------------ */

test('callOsmTool validates input and never throws', async () => {
  const db = freshDb();

  const unknown = await callOsmTool(db, 'definitely_not_a_tool', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /unknown tool/);

  for (const bad of [{}, { tool_id: 0 }, { tool_id: -3 }, { tool_id: 1.5 }, { tool_id: '1' }]) {
    const res = await callOsmTool(db, 'tear_down', bad);
    assert.equal(res.ok, false, `tear_down accepted ${JSON.stringify(bad)}`);
    assert.match(res.message, /tool_id must be a positive integer/);
  }

  const noBody = await callOsmTool(db, 'comment', { tool_id: 1 });
  assert.equal(noBody.ok, false);
  assert.match(noBody.message, /body is required/);

  const noReason = await callOsmTool(db, 'retire', { tool_id: 1 });
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /reason is required/);

  const nothingToTrack = await callOsmTool(db, 'track', {});
  assert.equal(nothingToTrack.ok, false);
  assert.match(nothingToTrack.message, /url or name required/);

  const badVerdict = await callOsmTool(db, 'search', { verdict: 'maybe' });
  assert.equal(badVerdict.ok, false);
  assert.match(badVerdict.message, /verdict must be one of/);
});

test('renderResult leads with the outcome and appends the payload as JSON', () => {
  assert.equal(renderResult({ ok: true, message: 'done' }), 'ok: done');
  assert.equal(renderResult({ ok: false, message: 'nope' }), 'FAILED: nope');
  const withData = renderResult({ ok: true, message: 'two', data: { a: 1 } });
  assert.ok(withData.startsWith('ok: two\n\n'));
  assert.deepEqual(JSON.parse(withData.slice('ok: two\n\n'.length)), { a: 1 });
});

/* ------------------------------------------------------------------ *
 * 6. The real MCP server, over a real transport (in-process, no stdio).
 * ------------------------------------------------------------------ */

async function connectedClient(db: ReturnType<typeof openDb>): Promise<Client> {
  const server = createOsmMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'osm-test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('tools/list over the MCP protocol advertises every tool with its schema', async () => {
  const db = freshDb();
  const client = await connectedClient(db);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(t => t.name).sort(),
      TOOLS.map(t => t.name).sort(),
    );
    for (const t of listed.tools) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.inputSchema.type, 'object');
      const local = findTool(t.name);
      assert.ok(local);
      assert.deepEqual(t.inputSchema, JSON.parse(JSON.stringify(local.inputSchema)));
    }
  } finally {
    await client.close();
  }
});

test('tools/call runs the shared op and reports failures as isError, not exceptions', async () => {
  const db = freshDb();
  const client = await connectedClient(db);
  try {
    const tracked = await client.callTool({
      name: 'track',
      arguments: { url: 'https://github.com/owner/from-mcp', why: 'came in over stdio' },
    });
    const trackedText = (tracked.content as Array<{ type: string; text: string }>)[0].text;
    assert.ok(trackedText.startsWith('ok: tracked from-mcp'), trackedText);
    assert.notEqual(tracked.isError, true);

    // The write really landed in the shared database.
    const found = ops.searchTools(db, { text: 'from-mcp' });
    assert.equal(found.data?.length, 1);
    assert.equal(found.data?.[0].canonical_key, 'github.com/owner/from-mcp');
    const id = found.data?.[0].id as number;

    // …and the journal carries it, same as the HTTP door would have.
    const detail = ops.getTool(db, id);
    assert.ok(detail.data?.comments.some(c => c.kind === 'event' && c.body.includes('tracked')));

    const refused = await client.callTool({ name: 'try_it', arguments: { tool_id: id } });
    assert.equal(refused.isError, true);
    const refusedText = (refused.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(refusedText, /^FAILED: /);
    assert.match(refusedText, /no present disk installation/);

    const badArgs = await client.callTool({ name: 'comment', arguments: { tool_id: id } });
    assert.equal(badArgs.isError, true);
    assert.match((badArgs.content as Array<{ type: string; text: string }>)[0].text, /body is required/);
  } finally {
    await client.close();
  }
});
