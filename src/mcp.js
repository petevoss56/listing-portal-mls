// Minimal MCP server (Streamable HTTP, JSON responses, stateless) — what Claude's custom connector talks to.
import { TOOLS, callTool } from './tools.js';
import { VERSION } from './config.js';
import { logUsage } from './db.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'MRED MLS data for the 3% Listing Co. service area (Quad Cities, Iowa and Illinois). ' +
  'Use run_cma for pricing a home: it applies 3% Listing Co. Step 1 rules and never mixes Iowa and Illinois comps. ' +
  'Data use rules (MLS GRID license and AI Use Addendum): use results only to answer the current request; do not save MLS data to memory, ' +
  'files or knowledge bases; keep listing attribution (MRED via MLS GRID, listing office) with any listing you show; share with a client only ' +
  'the facts needed to support that client\'s estimate of value. The MLS does not record condition, so ask the agent for condition grades when they matter.';

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcp(request, env, agent, fetchImpl) {
  if (request.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let msg;
  try { msg = await request.json(); } catch (e) { return json(rpcErr(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleOne(m, env, agent, fetchImpl)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleOne(msg, env, agent, fetchImpl);
  return out ? json(out) : new Response(null, { status: 202 });
}

async function handleOne(m, env, agent, fetchImpl) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id !== undefined ? rpcErr(m.id, -32600, 'Invalid request') : null;
  const isNotification = m.id === undefined || m.id === null;
  if (isNotification) return null; // notifications/initialized etc.
  switch (m.method) {
    case 'initialize': {
      const asked = m.params && m.params.protocolVersion;
      return rpc(m.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: '3pct-listing-mls', title: '3% Listing Co. MLS Comps', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpc(m.id, {});
    case 'tools/list': return rpc(m.id, { tools: TOOLS });
    case 'tools/call': {
      const name = m.params && m.params.name;
      const args = (m.params && m.params.arguments) || {};
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(m.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(env, name, args, fetchImpl);
        await logUsage(env.DB, agent, name, args.address || args.mls_number || '');
        return rpc(m.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: !!(result && result.error) });
      } catch (e) {
        return rpc(m.id, { content: [{ type: 'text', text: 'Tool failed: ' + e.message }], isError: true });
      }
    }
    default: return rpcErr(m.id, -32601, `Method not found: ${m.method}`);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
