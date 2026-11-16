import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, fixtureRecords, fakeMlsGrid } from './helpers.js';
import { runSync } from '../src/sync.js';
import { runGeocode, parseCensus, parseCsvLine } from '../src/geocode.js';
import { getSyncState } from '../src/db.js';
import worker, { GEOCODE_CRON } from '../src/index.js';
import { callTool } from '../src/tools.js';

// MRED via MLS Grid does not send coordinates: strip them like the real feed.
const noCoords = () => fixtureRecords().map((r) => { const c = Object.assign({}, r); delete c.Latitude; delete c.Longitude; return c; });
const COORDS = { '709 40th Ave': [41.5005, -90.4329], '3916 8th St': [41.4985, -90.4349], '3906 Morton Dr': [41.4945, -90.4249], '764 41st Ave': [41.502, -90.4319],
  '307 33rd Ave': [41.4905, -90.4389], '1009 38th Ave': [41.4975, -90.4289], '3707 9th St': [41.4965, -90.4309], '1132 37th Ave': [41.4955, -90.4269],
  '740 41st Ave': [41.5017, -90.4321], '806 22nd Ave': [41.4755, -90.4429], '220 30th Ave': [41.4855, -90.4449], '947 36th Ave': [41.4945, -90.4299],
  '100 River Dr': [41.5045, -90.4369], '500 42nd Ave': [41.5025, -90.4319] };

function fakeCensus(calls) {
  return async (url, init) => {
    calls.push(url);
    const csv = await init.body.get('addressFile').text();
    const out = csv.split('\n').map((line) => {
      const c = parseCsvLine(line);
      const hit = COORDS[c[1]];
      return hit ? `"${c[0]}","${c[1]}, ${c[2]}","Match","Exact","${c[1].toUpperCase()}","${hit[1]},${hit[0]}","1","L"` : `"${c[0]}","${c[1]}","No_Match"`;
    });
    return new Response(out.join('\n'), { status: 200 });
  };
}

test('parseCensus reads matches, ties and misses', () => {
  const m = parseCensus('"1","709 40th Ave, East Moline, IL, 61244","Match","Exact","709 40TH AVE, EAST MOLINE, IL, 61244","-90.4329,41.5005","123","L"\n"2","x","No_Match"\n"3","y","Tie"');
  assert.deepEqual(m.get('1'), { lat: 41.5005, lon: -90.4329, status: 'exact' });
  assert.equal(m.get('2').status, 'no_match');
  assert.equal(m.get('3').status, 'tie');
});

test('listings without coordinates get geocoded, then CMAs work; coordinates survive later MLS updates', async () => {
  const env = makeEnv();
  const recs = noCoords();
  await runSync(env, { fetch: fakeMlsGrid(recs, 50).fetch, sleep: async () => {} });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM listings WHERE lat IS NOT NULL').first()).n, 0);
  const calls = [];
  const g = await runGeocode(env, { fetch: fakeCensus(calls) });
  assert.equal(g.ok, true, g.error);
  assert.ok(g.matched >= 10);
  assert.equal(g.remaining, 0);
  // The old 2022 sale of the subject is outside the 24-month window and is not geocoded.
  assert.equal((await env.DB.prepare("SELECT lat FROM listings WHERE mls_number = '12000001'").first()).lat, null);
  // An MLS update without coordinates must not wipe them.
  const upd = Object.assign({}, recs[8], { ListPrice: 151000, ModificationTimestamp: new Date(Date.now() + 1e6).toISOString() });
  await runSync(env, { fetch: fakeMlsGrid([upd], 50).fetch, sleep: async () => {} });
  const row = await env.DB.prepare('SELECT lat, list_price FROM listings WHERE listing_key = ?').bind(recs[8].ListingKey).first();
  assert.equal(row.list_price, 151000);
  assert.ok(row.lat, 'coordinates kept');
  const cma = await callTool(env, 'run_cma', { address: '709 40th Ave', city: 'East Moline', state: 'IL', sqft_above_grade: 1110, lat: 41.5005, lon: -90.4329 });
  assert.ok(cma.valuation, JSON.stringify(cma).slice(0, 300));
  assert.ok(cma.sold_comps.length >= 5);
});

test('field inventory records field names only, once', async () => {
  const env = makeEnv({ FIELD_INVENTORY: 'true' });
  const grid = fakeMlsGrid(noCoords(), 50);
  await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  const inv = JSON.parse((await getSyncState(env.DB)).field_inventory);
  assert.ok(inv.fields.LivingArea >= 0);
  assert.ok(!JSON.stringify(inv).includes('Morton'), 'no values stored');
  const n = grid.calls.length;
  await runSync(env, { fetch: grid.fetch, sleep: async () => {} });
  assert.ok(!grid.calls.slice(n).some((c) => c.url.includes('$top=5&') || c.url.endsWith('$top=5')), 'not repeated');
  const st = await callTool(env, 'sync_status', {});
  assert.ok(st.mls_fields.total_fields > 10);
  assert.ok(st.map_coordinates.comp_ready_listings > 0);
});

test('the geocode schedule runs geocoding, the other runs the sync', async () => {
  const env = makeEnv();
  await runSync(env, { fetch: fakeMlsGrid(noCoords(), 50).fetch, sleep: async () => {} });
  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = fakeCensus(calls);
  try {
    const waits = [];
    await worker.scheduled({ cron: GEOCODE_CRON }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally { globalThis.fetch = origFetch; }
  assert.equal(calls.length, 1);
  const st = await getSyncState(env.DB);
  assert.ok(JSON.parse(st.geo_last_run).matched > 0);
});
