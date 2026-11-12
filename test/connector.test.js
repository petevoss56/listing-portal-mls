import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, fixtureRecords, fakeMlsGrid, rec } from './helpers.js';
import { runSync, buildUrl } from '../src/sync.js';
import { config } from '../src/config.js';
import worker from '../src/index.js';
import { getSyncState } from '../src/db.js';

const SUBJECT = { address: '709 40th Ave', city: 'East Moline', state: 'IL', sqft_above_grade: 1110, beds: 3, baths_full: 1, baths_half: 0, garage_spaces: 1, basement_finished_sqft: 0, year_built: 1961 };

async function synced() {
  const env = makeEnv();
  const recs = fixtureRecords();
  const grid = fakeMlsGrid(recs, 4);
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  return { env, recs, grid, r };
}

const mcp = (env, body, key) => worker.fetch(new Request('https://x.test/mcp', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (key || 'pete-key-0123456789abcdef') }, body: JSON.stringify(body),
}), env);

test('first sync imports only service-area records, across pages, and sets a checkpoint', async () => {
  const { env, recs, grid, r } = await synced();
  assert.equal(r.ok, true);
  assert.equal(r.finished, true);
  assert.ok(r.pages >= 4, 'paged through results');
  assert.ok(grid.calls[0].url.includes("OriginatingSystemName%20eq%20'mred'"));
  assert.ok(grid.calls[0].url.includes('MlgCanView%20eq%20true'));
  assert.equal(grid.calls[0].auth, 'Bearer test-token');
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()).n;
  assert.equal(n, recs.length - 1, 'Chicago record skipped');
  const st = await getSyncState(env.DB);
  assert.equal(st.mode, 'incremental');
  assert.ok(st.high_water);
  assert.ok(st.initial_completed_at);
});

test('incremental sync asks only for changes and deletes records MLS Grid hides', async () => {
  const { env, recs } = await synced();
  const later = new Date(Date.now() + 60000).toISOString();
  const changed = [
    Object.assign({}, recs[8], { ListPrice: 149000, ModificationTimestamp: later }),
    Object.assign({}, recs[9], { MlgCanView: false, ModificationTimestamp: later }),
  ];
  const grid = fakeMlsGrid(recs.concat(changed.map((c) => Object.assign({}, c))).filter((x, i, a) => a.findLastIndex((y) => y.ListingKey === x.ListingKey) === i), 50);
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.ok(grid.calls[0].url.includes('ModificationTimestamp%20gt'));
  assert.equal(r.upserts, 1);
  assert.equal(r.deletes, 1);
  const price = (await env.DB.prepare('SELECT list_price FROM listings WHERE listing_key = ?').bind(recs[8].ListingKey).first()).list_price;
  assert.equal(price, 149000);
  assert.equal(await env.DB.prepare('SELECT * FROM listings WHERE listing_key = ?').bind(recs[9].ListingKey).first(), null);
});

test('a page limit pauses the import and the next run resumes where it stopped', async () => {
  const env = makeEnv();
  const recs = fixtureRecords();
  const grid = fakeMlsGrid(recs, 3);
  const r1 = await runSync(env, { fetch: grid.fetch, sleep: async () => {}, maxPages: 2 });
  assert.equal(r1.finished, false);
  const mid = await getSyncState(env.DB);
  assert.equal(mid.mode, 'initial');
  assert.ok(mid.high_water, 'checkpoint saved after each page');
  const r2 = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r2.finished, true);
  const resumeUrl = decodeURIComponent(grid.calls[2].url);
  assert.ok(resumeUrl.includes('MlgCanView eq true') && resumeUrl.includes('ModificationTimestamp gt ' + mid.high_water), 'resumes, never starts over');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, recs.length - 1);
});

test('an error mid-import keeps the checkpoint and the next run resumes from it', async () => {
  const env = makeEnv();
  const recs = fixtureRecords();
  const r1 = await runSync(env, { fetch: fakeMlsGrid(recs, 4, { failAfter: 2 }).fetch, sleep: async () => {} });
  assert.equal(r1.ok, false);
  const cp = (await getSyncState(env.DB)).high_water;
  assert.ok(cp);
  const grid = fakeMlsGrid(recs, 4);
  const r2 = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r2.finished, true);
  assert.ok(decodeURIComponent(grid.calls[0].url).includes('ModificationTimestamp gt ' + cp));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()).n, recs.length - 1);
});

test('falls back without the property-type filter if MLS Grid rejects it, still keeping only residential', async () => {
  const env = makeEnv();
  const recs = fixtureRecords().concat([Object.assign({}, fixtureRecords()[1], { ListingKey: 'MRDLAND', ListingId: 'MRD99', PropertyType: 'Land' })]);
  const grid = fakeMlsGrid(recs, 50, { rejectTypeFilter: true });
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal((await getSyncState(env.DB)).use_type_filter, 0);
  assert.equal(await env.DB.prepare("SELECT * FROM listings WHERE listing_key = 'MRDLAND'").first(), null);
});

test('falls back to full records if MLS Grid rejects the field list', async () => {
  const env = makeEnv();
  const grid = fakeMlsGrid(fixtureRecords(), 50, { rejectSelect: true });
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal((await getSyncState(env.DB)).use_select, 0);
});

test('missing token is reported, not thrown', async () => {
  const env = makeEnv({ MLSGRID_TOKEN: '' });
  const r = await runSync(env, { fetch: async () => { throw new Error('should not call'); } });
  assert.equal(r.ok, false);
});

test('rate limit stops the run cleanly', async () => {
  const env = makeEnv();
  const r = await runSync(env, { fetch: async () => new Response('slow down', { status: 429 }), sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /429/);
});

test('buildUrl uses the configured source and page size', () => {
  const cfg = config({ ORIGINATING_SYSTEM: 'mred', SYNC_PAGE_SIZE: '5000' });
  const u = buildUrl(cfg, { mode: 'initial', useSelect: true });
  assert.ok(u.startsWith('https://api.mlsgrid.com/v2/Property?'));
  assert.ok(u.includes('$top=5000'));
  assert.ok(u.includes('$select=ListingKey'));
  assert.ok(decodeURIComponent(u).includes("PropertyType eq 'Residential' and"));
  assert.ok(!decodeURIComponent(u).includes('('), 'no parentheses around single conditions');
  const multi = buildUrl(config({ SYNC_PROPERTY_TYPES: 'Residential,Residential Income' }), { mode: 'incremental', checkpoint: '2026-01-01T00:00:00.000Z' });
  assert.ok(decodeURIComponent(multi).includes("PropertyType in ('Residential','Residential Income')"));
  assert.ok(!decodeURIComponent(multi).split('&$top')[0].includes('MlgCanView eq true'), 'incremental requests include deletions');
});

test('MCP: keys are required and per-person', async () => {
  const { env } = await synced();
  const bad = await mcp(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong-key-0000000000');
  assert.equal(bad.status, 401);
  const health = await worker.fetch(new Request('https://x.test/health'), env);
  assert.equal(health.status, 200);
});

test('MCP: initialize, tools/list and notifications behave per protocol', async () => {
  const { env } = await synced();
  const init = await (await mcp(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const note = await mcp(env, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const list = await (await mcp(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['run_cma', 'find_sold_comps', 'find_active_listings', 'get_listing', 'search_listings_by_address', 'sync_status']);
  const unknown = await (await mcp(env, { jsonrpc: '2.0', id: 3, method: 'nope' })).json();
  assert.equal(unknown.error.code, -32601);
  const get = await worker.fetch(new Request('https://x.test/mcp', { headers: { Authorization: 'Bearer pete-key-0123456789abcdef' } }), env);
  assert.equal(get.status, 405);
});

async function callTool(env, name, args, key) {
  const res = await (await mcp(env, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, key)).json();
  return { isError: res.result.isError, data: JSON.parse(res.result.content[0].text) };
}

test('run_cma on 709 40th Ave: Illinois-only comps, rules applied, range and confidence', async () => {
  const { env } = await synced();
  const { isError, data } = await callTool(env, 'run_cma', SUBJECT);
  assert.equal(isError, false, JSON.stringify(data));
  const v = data.valuation;
  assert.ok(v.model_value > 110000 && v.model_value < 160000, 'value in a sensible band: ' + v.model_value);
  assert.equal(v.range_high - v.range_low, 10000);
  assert.ok(v.recommended_list_price >= v.range_low && v.recommended_list_price <= v.range_high);
  assert.ok(v.confidence >= 35 && v.confidence <= 95);
  assert.ok(data.sold_comps.length >= 5 && data.sold_comps.length <= 8);
  assert.ok(data.sold_comps.every((c) => c.state === 'IL'), 'never crosses the state line');
  assert.ok(!data.sold_comps.some((c) => /500 42nd/.test(c.address)), 'condo excluded from detached search');
  assert.ok(!data.sold_comps.some((c) => /^709 40th/.test(c.address)), 'subject excluded from its own comps');
  assert.ok(!data.sold_comps.some((c) => /^777 39th/.test(c.address)), 'IDX-only record not used for Back Office comps');
  const s8 = data.sold_comps.find((c) => /3916 8th/.test(c.address));
  assert.equal(s8.adjustments.basement, -23520, 'basement $70/sf');
  const morton = data.sold_comps.find((c) => /3906 Morton/.test(c.address));
  assert.equal(morton.adjustments.garage, -10000, '$10k per garage stall');
  assert.ok(data.active_competition.length >= 1);
  assert.ok(data.top_competitors.length >= 1 && data.top_competitors.length <= 3);
  assert.ok(data.concerns.some((c) => /condition/i.test(c)), 'condition concern listed');
  const log = await env.DB.prepare('SELECT agent, tool FROM usage_log').all();
  assert.deepEqual({ ...log.results.at(-1) }, { agent: 'pete', tool: 'run_cma' });
});

test('run_cma fills facts from the MLS and honors comp grades and exclusions', async () => {
  const { env } = await synced();
  const { data } = await callTool(env, 'run_cma', { address: '709 40th Ave', city: 'East Moline', condition_grade: 'C', comp_grades: { '12000002': 'B' }, exclude_mls: ['12000004'] }, 'chris-key-0123456789abcd');
  assert.equal(data.subject.sqft_above_grade, 1110);
  assert.equal(data.subject.state, 'IL');
  assert.match(data.subject.facts_source, /MLS #/);
  const graded = data.sold_comps.find((c) => c.mls_number === '12000002');
  assert.equal(graded.adjustments.condition, -10000, 'B comp vs C subject at 1,000–1,500 sf');
  assert.ok(!data.sold_comps.some((c) => c.mls_number === '12000004'));
});

test('run_cma explains what is missing instead of guessing', async () => {
  const { env } = await synced();
  const fetchFail = async () => new Response('', { status: 500 });
  globalThis.__origFetch = globalThis.fetch; globalThis.fetch = fetchFail;
  try {
    const { isError, data } = await callTool(env, 'run_cma', { address: '1 Nowhere Ln', state: 'IL' });
    assert.equal(isError, true);
    assert.match(data.error, /square footage/);
  } finally { globalThis.fetch = globalThis.__origFetch; }
});

test('find tools, lookups and status', async () => {
  const { env } = await synced();
  const sold = (await callTool(env, 'find_sold_comps', Object.assign({}, SUBJECT, { radius_miles: 1 }))).data;
  assert.ok(sold.count >= 4);
  assert.ok(sold.results.every((r) => r.state === 'IL' && r.close_price));
  const act = (await callTool(env, 'find_active_listings', Object.assign({}, SUBJECT, { statuses: ['Pending'] }))).data;
  assert.ok(act.results.every((r) => r.status === 'Pending'));
  const one = (await callTool(env, 'get_listing', { mls_number: '12000009' })).data;
  assert.match(one.address, /740 41st/);
  const addr = (await callTool(env, 'search_listings_by_address', { address: '709 40th Ave' })).data;
  assert.equal(addr.count, 1);
  const st = (await callTool(env, 'sync_status', {})).data;
  assert.equal(st.records.total, 15);
  assert.ok(st.recent_usage.length >= 1);
});

test('license safeguards: prefixes stripped, attribution included, kill switch, result cap', async () => {
  const { env } = await synced();
  const one = (await callTool(env, 'get_listing', { mls_number: 'MRD12000009' })).data;
  assert.equal(one.mls_number, '12000009', 'MLS prefix removed for display and accepted on input');
  assert.ok(one.listing_office);
  assert.match(one.source, /MRED.*MLS GRID/);
  const cma = (await callTool(env, 'run_cma', SUBJECT)).data;
  assert.ok(cma.sold_comps.every((c) => c.listing_office));
  const capped = (await callTool(env, 'find_sold_comps', Object.assign({}, SUBJECT, { limit: 500, radius_miles: 5, months: 60 }))).data;
  assert.ok(capped.results.length <= 25);
  env.AI_ACCESS_ENABLED = 'false';
  const off = await mcp(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(off.status, 403);
  const portal = await worker.fetch(new Request('https://x.test/api/tools/get_listing', { method: 'POST', headers: { Authorization: 'Bearer pete-key-0123456789abcdef' }, body: JSON.stringify({ mls_number: '12000009' }) }), env);
  assert.equal(portal.status, 200, 'portal keeps working when AI access is off');
});

test('portal API and admin sync permissions', async () => {
  const { env } = await synced();
  const api = await worker.fetch(new Request('https://x.test/api/tools/run_cma', { method: 'POST', headers: { Authorization: 'Bearer pete-key-0123456789abcdef' }, body: JSON.stringify(SUBJECT) }), env);
  assert.equal(api.status, 200);
  assert.ok((await api.json()).valuation);
  const denied = await worker.fetch(new Request('https://x.test/admin/sync', { method: 'POST', headers: { Authorization: 'Bearer chris-key-0123456789abcd' } }), env);
  assert.equal(denied.status, 403);
});
