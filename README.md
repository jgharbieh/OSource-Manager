# OSource-Manager

See it, try it, keep it or kill it — a local registry for repos, global CLIs, MCP servers, and skills.

## Usage

```bash
pnpm install
pnpm build
node dist/cli.js setup      # first-run import + optional self-registration
node dist/cli.js serve      # web UI at http://localhost:7807
node dist/cli.js refresh    # re-import from disk/package managers/configs
node dist/cli.js mcp        # start MCP server on stdio
```

## Stack

TypeScript, ESM, Vite, `node:sqlite`. One package with three doors: CLI, web UI, and MCP server.
