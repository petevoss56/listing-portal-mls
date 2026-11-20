import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, fixtureRecords, fakeMlsGrid, rec, rosterFixtures } from './helpers.js';
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

test('by default a rejected request stops instead of falling back to larger downloads', async () => {
  const env = makeEnv({ ALLOW_LARGER_REQUESTS: 'false' });
  const grid = fakeMlsGrid(fixtureRecords(), 50, { rejectSelect: true });
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(grid.calls.length, 1);
  assert.match(r.error, /ALLOW_LARGER_REQUESTS/);
});

test('first import uses INITIAL_IMPORT_MAX_PAGES, later runs drop back to SYNC_MAX_PAGES', async () => {
  const env = makeEnv({ INITIAL_IMPORT_MAX_PAGES: '3', SYNC_MAX_PAGES: '1' });
  const recs = fixtureRecords();
  const g1 = fakeMlsGrid(recs, 2);
  const r1 = await runSync(env, { fetch: g1.fetch, sleep: async () => {} });
  assert.equal(r1.pages, 3, 'initial import uses the faster setting');
  let r;
  do { r = await runSync(env, { fetch: fakeMlsGrid(recs, 2).fetch, sleep: async () => {} }); } while (!r.finished);
  const later = [Object.assign({}, recs[3], { ModificationTimestamp: new Date(Date.now() + 9e5).toISOString() }), Object.assign({}, recs[4], { ModificationTimestamp: new Date(Date.now() + 9e5 + 1).toISOString() }), Object.assign({}, recs[5], { ModificationTimestamp: new Date(Date.now() + 9e5 + 2).toISOString() })];
  const r2 = await runSync(env, { fetch: fakeMlsGrid(later, 1).fetch, sleep: async () => {} });
  assert.equal(r2.mode, 'incremental');
  assert.equal(r2.pages, 1, 'incremental runs use SYNC_MAX_PAGES');
});

test('a second sync does not start while one is running', async () => {
  const env = makeEnv();
  const recs = fixtureRecords();
  let release;
  const gate = new Promise((res) => (release = res));
  const slowFetch = async (url, init) => { await gate; return fakeMlsGrid(recs, 50).fetch(url, init); };
  const first = runSync(env, { fetch: slowFetch, sleep: async () => {} });
  await new Promise((r) => setTimeout(r, 20));
  const second = await runSync(env, { fetch: async () => { throw new Error('must not run'); }, sleep: async () => {} });
  assert.equal(second.skipped, true);
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal((await getSyncState(env.DB)).lock_until, null, 'lock released');
});

test('fields the MLS does not provide are dropped from $select and remembered', async () => {
  const env = makeEnv({ ALLOW_LARGER_REQUESTS: 'false' });
  const recs = fixtureRecords();
  const grid = fakeMlsGrid(recs, 50, { missingFields: ['UnparsedAddress', 'AboveGradeFinishedArea'] });
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.finished, true);
  assert.deepEqual((await getSyncState(env.DB)).dropped_fields.split(',').sort(), ['AboveGradeFinishedArea', 'UnparsedAddress']);
  assert.ok(!grid.calls.at(-1).url.includes('UnparsedAddress'));
  const row = await env.DB.prepare("SELECT address FROM listings WHERE mls_number = '12000002'").first();
  assert.match(row.address, /3916 8th St/, 'address built from street parts');
  const grid2 = fakeMlsGrid([], 50, { missingFields: ['UnparsedAddress', 'AboveGradeFinishedArea'] });
  await runSync(env, { fetch: grid2.fetch, sleep: async () => {} });
  assert.equal(grid2.calls.filter((c) => c.url.includes('/Property?')).length, 1, 'remembered: no retries on the next run');
});

test('a missing core field stops the sync with a clear error', async () => {
  const env = makeEnv({ ALLOW_LARGER_REQUESTS: 'false' });
  const r = await runSync(env, { fetch: fakeMlsGrid(fixtureRecords(), 50, { missingFields: ['ListingKey'] }).fetch, sleep: async () => {} });
  assert.equal(r.ok, false);
});

test('basement rate: $35/sf over 30 years old, $70/sf otherwise, each home at its own rate', async () => {
  const { adjust } = await import('../src/cma.js');
  const yr = new Date().getFullYear();
  const subj = { sqft: 1500, grade: 'C', full: 2, half: 0, garage: 2, bsmt: 0, year: yr - 10, state: 'IA' };
  const newComp = { above_grade_sqft: 1500, baths_full: 2, baths_half: 0, garage_spaces: 2, below_grade_finished_sqft: 500, year_built: yr - 10 };
  assert.equal(adjust(subj, newComp, 300000).bsmt, -35000);
  const oldComp = Object.assign({}, newComp, { year_built: yr - 40 });
  assert.equal(adjust(subj, oldComp, 300000).bsmt, -17500);
  assert.equal(adjust(Object.assign({}, subj, { bsmt: 500, year: yr - 40 }), oldComp, 300000).bsmt, 0);
  assert.equal(adjust(subj, Object.assign({}, newComp, { year_built: yr - 30 }), 300000).bsmt, -35000, 'exactly 30 years uses $70');
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
  assert.deepEqual(names, ['run_cma', 'find_sold_comps', 'find_active_listings', 'get_listing', 'search_listings_by_address', 'find_agent', 'sync_status']);
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
  assert.ok(!data.sold_comps.some((c) => c.flags.includes('Bedroom count outside range')), 'bedroom rule enforced');
  const s8 = data.sold_comps.find((c) => /3916 8th/.test(c.address));
  assert.equal(s8.adjustments.basement, -11760, 'basement $35/sf for a 1962 home');
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
  assert.equal(st.records.total, 16);
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

// ---- Agents, offices and agent IDs on listings ----

async function syncedWithAgents() {
  const env = makeEnv();
  const recs = fixtureRecords();
  // 3916 8th St: listed by Jane, sold to Bob's buyer. 740 41st Ave: Jane's active listing.
  Object.assign(recs[1], { ListAgentKey: 'MRDA1', ListAgentMlsId: 'MRD111', ListAgentFullName: 'Jane Lister', ListOfficeKey: 'MRDO1', BuyerAgentKey: 'MRDA2', BuyerAgentMlsId: 'MRD222', BuyerAgentFullName: 'Bob Buyer', BuyerOfficeKey: 'MRDO2', BuyerOfficeName: 'Other Realty', ListingContractDate: new Date(Date.now() - 80 * 864e5).toISOString().slice(0, 10) });
  Object.assign(recs[8], { ListAgentKey: 'MRDA1', ListAgentMlsId: 'MRD111', ListAgentFullName: 'Jane Lister', ListOfficeKey: 'MRDO1', ListingContractDate: new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10) });
  const ros = rosterFixtures();
  const grid = fakeMlsGrid(recs, 50, ros);
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  return { env, recs, ros, grid, r };
}

test('sync pulls agent and office rosters and stores agent IDs on listings', async () => {
  const { env, r, grid } = await syncedWithAgents();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.members.saved, 2);
  assert.equal(r.offices.saved, 1);
  assert.ok(grid.calls.some((c) => c.url.includes('/Member?') && decodeURIComponent(c.url).includes('MlgCanView eq true')));
  assert.ok(decodeURIComponent(grid.calls[0].url).includes('ListAgentKey'), 'agent fields requested on listings');
  const row = await env.DB.prepare("SELECT list_agent_key, list_agent_mls_id, buyer_agent_key, buyer_office_name FROM listings WHERE mls_number = '12000002'").first();
  assert.deepEqual({ ...row }, { list_agent_key: 'MRDA1', list_agent_mls_id: '111', buyer_agent_key: 'MRDA2', buyer_office_name: 'Other Realty' });
  const jane = await env.DB.prepare("SELECT mls_id, email, office_mls_id FROM agents WHERE member_key = 'MRDA1'").first();
  assert.deepEqual({ ...jane }, { mls_id: '111', email: 'jane@example.com', office_mls_id: '900' });
  assert.equal((await getSyncState(env.DB)).member_mode, 'incremental');
  assert.equal(r.backfill.needed, false, 'a fresh import needs no backfill');
});

test('roster updates are incremental and hidden agents are removed', async () => {
  const { env, ros } = await syncedWithAgents();
  const later = new Date(Date.now() + 60000).toISOString();
  const members = [Object.assign({}, ros.members[0], { MemberEmail: 'jane@new.example.com', ModificationTimestamp: later }), Object.assign({}, ros.members[1], { MlgCanView: false, ModificationTimestamp: later })];
  const grid = fakeMlsGrid([], 50, { members, offices: [] });
  const r = await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  const memberUrl = decodeURIComponent(grid.calls.find((c) => c.url.includes('/Member?')).url);
  assert.ok(memberUrl.includes('ModificationTimestamp gt') && !memberUrl.includes('MlgCanView eq true'));
  assert.equal(r.members.saved, 1);
  assert.equal(r.members.removed, 1);
  assert.equal((await env.DB.prepare("SELECT email FROM agents WHERE member_key = 'MRDA1'").first()).email, 'jane@new.example.com');
  assert.equal(await env.DB.prepare("SELECT * FROM agents WHERE member_key = 'MRDA2'").first(), null);
});

test('a roster the subscription lacks is reported but never blocks listings', async () => {
  const env = makeEnv();
  const r = await runSync(env, { fetch: fakeMlsGrid(fixtureRecords(), 50, { rosterStatus: 403 }).fetch, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.match(r.members.error, /403/);
  const st = (await callTool(env, 'sync_status', {})).data;
  assert.match(st.agent_roster.members_error, /403/);
  assert.equal(st.records.total, 16);
});

test('existing databases get agent IDs through a paced one-time backfill', async () => {
  // 5 requests per run: 1 listings + 1 agents + 1 offices leaves 2 for the backfill.
  const env = makeEnv({ SYNC_MAX_PAGES: '5' });
  const recs = fixtureRecords();
  await runSync(env, { fetch: fakeMlsGrid(recs, 50).fetch, sleep: async () => {} });
  // Simulate a database imported before agent fields existed.
  await env.DB.prepare('UPDATE sync_state SET listing_fields_version = NULL').run();
  await env.DB.prepare('UPDATE listings SET list_agent_key = NULL').run();
  recs.forEach((x) => Object.assign(x, { ListAgentKey: 'MRDA1' }));
  const r1 = await runSync(env, { fetch: fakeMlsGrid(recs, 5).fetch, sleep: async () => {} });
  assert.equal(r1.backfill.needed, true);
  assert.equal(r1.backfill.done, false, 'stays within the per-run request budget');
  assert.equal(r1.pages, 5);
  assert.equal(r1.backfill.pages, 2);
  let r, runs = 0;
  do { r = await runSync(env, { fetch: fakeMlsGrid(recs, 5).fetch, sleep: async () => {} }); runs++; } while (!r.backfill.done && runs < 10);
  assert.equal(r.backfill.done, true);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM listings WHERE list_agent_key IS NULL').first()).n, 0);
  const st = await getSyncState(env.DB);
  assert.equal(st.listing_fields_version, 2);
  assert.equal(st.backfill_high_water, null);
  const again = await runSync(env, { fetch: fakeMlsGrid(recs, 5).fetch, sleep: async () => {} });
  assert.equal(again.backfill.needed, false);
});

test('find_agent returns contact info and local activity; get_listing names the agents', async () => {
  const { env } = await syncedWithAgents();
  const byName = (await callTool(env, 'find_agent', { name: 'jane' })).data;
  assert.equal(byName.count, 1);
  const jane = byName.results[0];
  assert.equal(jane.email, 'jane@example.com');
  assert.equal(jane.phones.mobile, '563-555-0101');
  assert.equal(jane.office.name, 'Example Realty 1');
  assert.equal(jane.office.phone, '563-555-0000');
  assert.deepEqual(jane.last_12_months, { listings_taken: 2, closed_list_side: 1, closed_buyer_side: 0, current_listings: 1 });
  const byId = (await callTool(env, 'find_agent', { mls_id: 'MRD222' })).data;
  assert.equal(byId.results[0].name, 'Bob Buyer');
  assert.equal(byId.results[0].last_12_months.closed_buyer_side, 1);
  const byOffice = (await callTool(env, 'find_agent', { office: 'Other' })).data;
  assert.equal(byOffice.count, 1);
  assert.equal((await callTool(env, 'find_agent', {})).isError, true);
  const one = (await callTool(env, 'get_listing', { mls_number: '12000002' })).data;
  assert.equal(one.listing_agent.name, 'Jane Lister');
  assert.equal(one.listing_agent.email, 'jane@example.com');
  assert.equal(one.buyer_agent.name, 'Bob Buyer');
  assert.equal(one.buyer_agent.office, 'Other Realty');
  const log = await env.DB.prepare("SELECT summary FROM usage_log WHERE tool = 'find_agent'").all();
  assert.equal(log.results[0].summary, 'jane');
});
