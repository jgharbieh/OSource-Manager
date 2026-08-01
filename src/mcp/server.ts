import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OpResult } from '../core/types.js';
import { type Db, openDb } from '../core/db.js';
import { defaultDbPath } from '../core/settings.js';
import {
  applyUpdateOp,
  commentOnTool,
  registerMcpOp,
  retireTool,
  searchTools,
  tearDownOp,
  trackTool,
  tryItOp,
  unregisterMcpOp,
  type SearchQuery,
  type TrackInput,
} from '../core/ops.js';
import { ALL_TARGETS, type RegisterOpts, type TargetId } from '../core/registrar.js';

/**
 * Phase-4 MCP server — stdio transport, the same eight-ish operations the web
 * UI drives.
 *
 * THE ARCHITECTURAL CONSTRAINT: every tool below dispatches through its `op`
 * field, and that field holds the *identical function object* that the matching
 * HTTP route in src/web/server.ts imports from src/core/ops.ts. There is no
 * second implementation, no MCP-only shortcut, and nothing here re-derives a
 * guard. The dispatcher calls `def.op(db, ...def.argsFor(input))` — it cannot
 * call anything else — so a tool and its route can never drift apart. That
 * identity is what test/mcp.test.ts asserts.
 *
 * Deliberate omissions on the agent-facing surface:
 * - The `server` launch-command override that POST /api/tools/:id/register
 *   accepts is NOT exposed. deriveServerSpec fails loudly rather than guessing,
 *   and a model inventing a command to write into a real agent config is
 *   exactly the failure mode PLAN.md's registrar rules exist to prevent.
 * - No tool takes `env`; that is a test seam for isolating HOME, not an input.
 *
 * stdout belongs to the JSON-RPC transport. Nothing in this file prints.
 */

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly string[];
  items?: { type: string; enum?: readonly string[] };
  minimum?: number;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

/** Any ops.ts export. `never[]` params make this accept every function shape
 *  while still being a real function type (not `Function`). */
type AnyOp = (...args: never[]) => unknown;

export interface OsmToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** The exact src/core/ops.ts function the HTTP counterpart calls. */
  op: AnyOp;
  /** Validated positional arguments AFTER the Db. Throws on bad input. */
  argsFor(input: Record<string, unknown>): unknown[];
}

// --- input validation (throws plain Errors; the dispatcher turns them into
//     ok:false results, never an exception across the transport) ---

function toolId(input: Record<string, unknown>): number {
  const v = input.tool_id;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error('tool_id must be a positive integer (see the search tool for ids)');
  }
  return v;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${key} is required and must be a non-empty string`);
  return v;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v === '' ? undefined : v;
}

function optionalBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${key} must be a boolean`);
  return v;
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = optionalString(input, key);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

function targetList(input: Record<string, unknown>): TargetId[] {
  const v = input.targets;
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`targets must be a non-empty array of: ${ALL_TARGETS.join(', ')}`);
  }
  const out: TargetId[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string' || !(ALL_TARGETS as string[]).includes(raw)) {
      throw new Error(`unknown target ${JSON.stringify(raw)} — expected one of: ${ALL_TARGETS.join(', ')}`);
    }
    out.push(raw as TargetId);
  }
  return out;
}

/** Registrar knobs common to register_mcp and unregister_mcp. */
function registrarOpts(input: Record<string, unknown>): RegisterOpts {
  const opts: RegisterOpts = {};
  const serverName = optionalString(input, 'serverName');
  if (serverName !== undefined) opts.serverName = serverName;
  const dockerProfile = optionalString(input, 'dockerProfile');
  if (dockerProfile !== undefined) opts.dockerProfile = dockerProfile;
  const dockerRef = optionalString(input, 'dockerRef');
  if (dockerRef !== undefined) opts.dockerRef = dockerRef;
  return opts;
}

const VERDICTS = ['wanted', 'trying', 'kept', 'retired'] as const;
const KINDS = ['repo', 'global-cli', 'skill', 'binary'] as const;

const TOOL_ID_PROP: JsonSchemaProperty = {
  type: 'integer',
  description: 'Numeric id of the tool on the shelf (from the search tool).',
  minimum: 1,
};

const TARGETS_PROP: JsonSchemaProperty = {
  type: 'array',
  description:
    'Agents to write to. Explicit and per-tool — there is no "apply to all". ' +
    'Run search first if unsure; undetected targets are reported as skipped.',
  items: { type: 'string', enum: ALL_TARGETS },
};

/**
 * The tools. Ordered as PLAN.md lists them: search · track · comment · try_it ·
 * tear_down · register_mcp · retire, then the two the plan added in review
 * (update, unregister_mcp) because registration and updating both need an
 * inverse/apply half to be usable at all.
 */
export const TOOLS: OsmToolDef[] = [
  {
    name: 'search',
    description:
      'Search the local shelf: every tool OSM has discovered or been told about, with its verdict, ' +
      'installations, tags and observed state. Read-only. Start here — every other tool takes a tool_id.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring match over name, canonical key and aliases.' },
        favorite: { type: 'boolean', description: 'Only starred tools when true, only unstarred when false.' },
        tag: { type: 'string', description: 'Exact tag match, case-insensitive.' },
        verdict: {
          type: 'string',
          description: "Joseph's verdict on the tool.",
          enum: VERDICTS,
        },
        noEvidenceOfUse: {
          type: 'boolean',
          description:
            'Installed but with zero user comments and zero trials. This is ABSENCE OF RECORDS, ' +
            'not proof the tool is unused — OSM cannot see launches outside itself.',
        },
        hasUpdate: { type: 'boolean', description: 'Only tools whose last upstream check found something newer.' },
      },
      additionalProperties: false,
    },
    op: searchTools,
    argsFor: input => {
      const q: SearchQuery = {};
      const text = optionalString(input, 'text');
      if (text !== undefined) q.text = text;
      const favorite = optionalBool(input, 'favorite');
      if (favorite !== undefined) q.favorite = favorite;
      const tag = optionalString(input, 'tag');
      if (tag !== undefined) q.tag = tag;
      const verdict = optionalEnum(input, 'verdict', VERDICTS);
      if (verdict !== undefined) q.verdict = verdict;
      const never = optionalBool(input, 'noEvidenceOfUse');
      if (never !== undefined) q.noEvidenceOfUse = never;
      const upd = optionalBool(input, 'hasUpdate');
      if (upd !== undefined) q.hasUpdate = upd;
      return [q];
    },
  },
  {
    name: 'track',
    description:
      'Put a tool on the shelf at verdict "wanted". Give a git URL, or a bare name for an npm package / ' +
      'local binary. The URL is canonicalized first, so an ssh/https/.git variant of something already ' +
      'tracked merges into the existing row instead of duplicating it. "why" is stored and journalled.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Git URL, e.g. https://github.com/owner/repo. Preferred.' },
        name: { type: 'string', description: 'Bare name when there is no repo: an npm package or a local binary.' },
        kind: { type: 'string', description: 'Override the inferred kind.', enum: KINDS },
        why: { type: 'string', description: 'Why you want it. Stored on the row AND appended to the journal.' },
      },
      additionalProperties: false,
    },
    op: trackTool,
    argsFor: input => {
      const t: TrackInput = {};
      const url = optionalString(input, 'url');
      if (url !== undefined) t.url = url;
      const name = optionalString(input, 'name');
      if (name !== undefined) t.name = name;
      const kind = optionalEnum(input, 'kind', KINDS);
      if (kind !== undefined) t.kind = kind;
      const why = optionalString(input, 'why');
      if (why !== undefined) t.why = why;
      if (t.url === undefined && t.name === undefined) throw new Error('url or name required');
      return [t];
    },
  },
  {
    name: 'comment',
    description:
      "Append to a tool's comment stream — the append-only journal that interleaves your notes with " +
      'every state change OSM made. This is what makes a six-month-old decision legible. Nothing is ever edited.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: TOOL_ID_PROP,
        body: { type: 'string', description: 'The note. Kept verbatim, forever.' },
      },
      required: ['tool_id', 'body'],
      additionalProperties: false,
    },
    op: commentOnTool,
    argsFor: input => [toolId(input), requiredString(input, 'body')],
  },
  {
    name: 'try_it',
    description:
      'Run the tool in a local Docker container. The plan is re-derived from the repo and re-checked ' +
      'against the flag allowlist on every call; anything the plan refused (--privileged, host network, ' +
      'the docker socket, bind mounts) is a hard stop. Ports publish on loopback only. The FIRST trial of ' +
      'a tool refuses unless confirm is true — read the plan out loud to the user before setting it.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: TOOL_ID_PROP,
        confirm: {
          type: 'boolean',
          description:
            'Required (true) for the first trial of a tool. Means: the plan has been shown to the user ' +
            'and they said go. Do not set it on their behalf.',
        },
      },
      required: ['tool_id'],
      additionalProperties: false,
    },
    op: tryItOp,
    argsFor: input => [toolId(input), { confirm: optionalBool(input, 'confirm') === true }],
  },
  {
    name: 'tear_down',
    description:
      "End the tool's running trial. Removes the container always; removes the image ONLY if OSM pulled " +
      'it, and volumes ONLY the ones OSM created. Shared images and pre-existing volumes survive and are ' +
      'named in the report as kept.',
    inputSchema: {
      type: 'object',
      properties: { tool_id: TOOL_ID_PROP },
      required: ['tool_id'],
      additionalProperties: false,
    },
    op: tearDownOp,
    argsFor: input => [toolId(input)],
  },
  {
    name: 'register_mcp',
    description:
      "Add this tool's MCP server to the chosen agents via their official CLIs (claude mcp add-json, " +
      'codex mcp add, docker mcp profile server add). ALWAYS call with dryRun true first and show the ' +
      'returned diff to the user — the live call backs up the config, then verifies by reading state back ' +
      'through the CLI and rolls back if the read-back disagrees. The launch command is derived from the ' +
      'tool itself and fails loudly when it cannot be derived; it is never guessed.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: TOOL_ID_PROP,
        targets: TARGETS_PROP,
        dryRun: { type: 'boolean', description: 'Build the diff and the argv, execute nothing. Do this first.' },
        serverName: {
          type: 'string',
          description:
            "Override the server name. Defaults to the tool's own slugified name (a tool called trello " +
            'is served as "trello"). Letters, digits, dot, underscore and dash only.',
        },
        dockerProfile: {
          type: 'string',
          description: 'Docker MCP Toolkit profile. Required for the docker target — enabling is profile-based.',
        },
        dockerRef: {
          type: 'string',
          description: 'Docker MCP Toolkit server reference (catalog:// docker:// https:// file://).',
        },
      },
      required: ['tool_id', 'targets'],
      additionalProperties: false,
    },
    op: registerMcpOp,
    argsFor: input => [
      toolId(input),
      targetList(input),
      { ...registrarOpts(input), dryRun: optionalBool(input, 'dryRun') === true },
    ],
  },
  {
    name: 'retire',
    description:
      'Set the verdict to "retired" with a reason that is kept forever. The row, its journal and its ' +
      'installation history all survive — nothing is deleted. If the tool is still serving as an MCP ' +
      'server anywhere, call unregister_mcp too, or the agents keep pointing at a tool you killed.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: TOOL_ID_PROP,
        reason: { type: 'string', description: 'Why it is going. Required — this is the whole point.' },
      },
      required: ['tool_id', 'reason'],
      additionalProperties: false,
    },
    op: retireTool,
    argsFor: input => [toolId(input), requiredString(input, 'reason')],
  },
  {
    name: 'update',
    description:
      'Apply an update. Repos are FAST-FORWARD ONLY via explicit fetch + merge --ff-only (never git pull): ' +
      'a dirty worktree, detached HEAD, missing tracking branch, linked worktree or diverged history all ' +
      'refuse without touching the checkout. Global CLI updates (npm -g / winget) stay gated behind ' +
      'allowGlobal. Breaking-change keywords found in the changelog are surfaced in the result.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: TOOL_ID_PROP,
        allowGlobal: {
          type: 'boolean',
          description: 'Permit npm -g / winget mutation. Off by default; ask the user before setting it.',
        },
      },
      required: ['tool_id'],
      additionalProperties: false,
    },
    op: applyUpdateOp,
    argsFor: input => [toolId(input), { allowGlobal: optionalBool(input, 'allowGlobal') === true }],
  },
  {
    name: 'unregister_mcp',
    description:
      "The inverse of register_mcp: remove this tool's MCP server from the chosen agents. Without this, " +
      'retiring a tool leaves an orphaned entry in every agent config. Same backup / verify-by-read-back / ' +
      'rollback path as registration. Only entries OSM itself registered are removable — a name OSM has ' +
      'no record of writing is refused, so a third-party server can never be deleted through this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: TOOL_ID_PROP,
        targets: TARGETS_PROP,
        serverName: {
          type: 'string',
          description:
            "Override the server name. Defaults to the tool's own slugified name. Must be a name OSM " +
            'recorded registering for this tool, or the removal is refused.',
        },
        dockerProfile: { type: 'string', description: 'Docker MCP Toolkit profile. Required for the docker target.' },
      },
      required: ['tool_id', 'targets'],
      additionalProperties: false,
    },
    op: unregisterMcpOp,
    argsFor: input => [toolId(input), targetList(input), registrarOpts(input)],
  },
];

export function findTool(name: string): OsmToolDef | undefined {
  return TOOLS.find(t => t.name === name);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Validate the input, then call the op. The op is invoked through `def.op`,
 * which is the same function object the HTTP route imports — there is no other
 * code path a tool could take. Never throws: bad input and op failures both
 * come back as an ok:false OpResult.
 */
export async function callOsmTool(
  db: Db,
  name: string,
  input: Record<string, unknown> = {},
): Promise<OpResult<unknown>> {
  const def = findTool(name);
  if (def === undefined) {
    return { ok: false, message: `unknown tool "${name}" — known tools: ${TOOLS.map(t => t.name).join(', ')}` };
  }
  let args: unknown[];
  try {
    args = def.argsFor(input);
  } catch (err) {
    return { ok: false, message: `${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const invoke = def.op as (...a: unknown[]) => OpResult<unknown> | Promise<OpResult<unknown>>;
    return await invoke(db, ...args);
  } catch (err) {
    return { ok: false, message: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** OpResult → the text an agent reads. The message leads; data follows as JSON. */
export function renderResult(result: OpResult<unknown>): string {
  const head = `${result.ok ? 'ok' : 'FAILED'}: ${result.message}`;
  if (result.data === undefined) return head;
  let body: string;
  try {
    body = JSON.stringify(result.data, null, 2);
  } catch {
    body = String(result.data);
  }
  return `${head}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createOsmMcpServer(db: Db): Server {
  const server = new Server(
    { name: 'osource-manager', version: packageVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        'OSource-Manager is Joseph\'s local shelf of tools: what is on this machine, what upstream did, ' +
        'and whether he still wants it. Call search first — every other tool takes a tool_id from it. ' +
        'try_it and update mutate the machine; register_mcp and unregister_mcp write to real agent ' +
        'configs. Show the user the dry run or the plan before you commit to any of those.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callOsmTool(db, request.params.name, input);
    return {
      content: [{ type: 'text' as const, text: renderResult(result) }],
      isError: !result.ok,
    };
  });

  return server;
}

/** `osm mcp` — stdio transport over the real registry database. */
export async function startOsmMcpServer(): Promise<void> {
  const db = openDb(defaultDbPath());
  const server = createOsmMcpServer(db);
  await server.connect(new StdioServerTransport());

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server
      .close()
      .catch(() => {
        // best effort
      })
      .finally(() => {
        try {
          db.close();
        } catch {
          // best effort
        }
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
