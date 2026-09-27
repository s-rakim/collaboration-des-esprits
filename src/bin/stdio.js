#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from '../core.js';
import { buildServer } from '../mcp/tools.js';

/**
 * Local entrypoint: one process per agent, pinned to that agent's identity, so
 * it never has to pass `as` and shows up in the room the moment its client
 * starts. Point several agents at the same ESPRITS_DB and they share a room.
 *
 * Nothing is written to stdout except protocol traffic — stdout IS the
 * transport, so every diagnostic goes to stderr.
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stderr.write(
    `collaboration-des-esprits — MCP connector for a room of collaborating agents\n\n` +
      `Usage: esprits --as <name> --role <role> [--db <path>]\n\n` +
      `  --as <name>     this agent's handle (or ESPRITS_AGENT)\n` +
      `  --role <role>   architect | critic | researcher | planner | backend | frontend |\n` +
      `                  reviewer | generalist  (or ESPRITS_ROLE, default generalist)\n` +
      `  --kind <k>      agent | human  (default agent)\n` +
      `  --model <name>  optional, shown in the roster\n` +
      `  --db <path>     shared SQLite file (or ESPRITS_DB, default ./data/esprits.sqlite)\n\n` +
      `Every agent that opens the same --db is in the same room.\n`,
  );
  process.exit(0);
}

const name = args.as ?? process.env.ESPRITS_AGENT ?? null;
const role = args.role ?? process.env.ESPRITS_ROLE ?? 'generalist';
const dbPath = args.db ?? process.env.ESPRITS_DB ?? undefined;

const hub = new Hub({ dbPath });

let identity = null;
if (name) {
  // Register on startup so the agent is in the roster from the moment its
  // client connects, without waiting for it to think to call join.
  const joined = hub.join({
    name: String(name),
    role: String(role),
    kind: args.kind === 'human' ? 'human' : 'agent',
    model: args.model ? String(args.model) : '',
  });
  identity = { name: joined.agent.name, role: joined.agent.role };
  process.stderr.write(`esprits: ${identity.name} (${identity.role}) joined — db ${hub.db.name}\n`);
} else {
  process.stderr.write(
    `esprits: no --as/ESPRITS_AGENT given; tools will require an explicit "as" argument\n`,
  );
}

const { server } = buildServer({ hub, identity });

const shutdown = () => {
  try {
    if (identity) hub.setStatus({ name: identity.name, status: 'away', note: '' });
    hub.close();
  } catch {
    // Going away is best-effort; never let cleanup mask the exit.
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
