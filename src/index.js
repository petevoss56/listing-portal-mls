// Cloudflare Worker entry point.
//   POST /mcp         Claude custom connector (needs header  Authorization: Bearer <your key>)
//   POST /api/tools/<name>   same tools as plain JSON, for the Listing Portal
//   POST /admin/sync  run a sync now (admin keys only)
//   GET  /health      quick check, no key needed
// A cron trigger (see wrangler.toml) runs the MLS Grid sync every 15 minutes.
import { config, VERSION } from './config.js';
import { handleMcp } from './mcp.js';
import { runSync } from './sync.js';
import { callTool, TOOLS } from './tools.js';
import { ensureSchema, logUsage } from './db.js';

export function authenticate(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  for (const k of config(env).keys) if (safeEqual(token, k.key)) return k.name;
  return null;
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (obj, status) => new Response(JSON.stringify(obj, null, 1), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: '3pct-listing-mls', version: VERSION });
    if (!config(env).keys.length) return json({ error: 'No connector keys are set up yet (CONNECTOR_KEYS).' }, 503);
    const agent = authenticate(request, env);
    if (!agent) return json({ error: 'Missing or invalid key.' }, 401);
    await ensureSchema(env.DB);

    if (url.pathname === '/mcp') return handleMcp(request, env, agent);

    if (url.pathname.startsWith('/api/tools/') && request.method === 'POST') {
      const name = url.pathname.slice('/api/tools/'.length);
      if (!TOOLS.some((t) => t.name === name)) return json({ error: 'Unknown tool' }, 404);
      const args = await request.json().catch(() => ({}));
      const result = await callTool(env, name, args);
      await logUsage(env.DB, agent, name, args.address || args.mls_number || '');
      return json(result, result && result.error ? 400 : 200);
    }

    if (url.pathname === '/admin/sync' && request.method === 'POST') {
      if (!config(env).adminAgents.includes(agent.toLowerCase())) return json({ error: 'Admin only.' }, 403);
      return json(await runSync(env, { maxPages: Number(url.searchParams.get('pages')) || undefined }));
    }
    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },
};
