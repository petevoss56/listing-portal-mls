// Fills in map coordinates for listings MRED sends without them, using the free US Census batch geocoder.
// Only street addresses are sent. Runs on its own schedule and never touches MLS Grid.
// Only listings that matter for comps are geocoded: active/pending, and sales from the last GEOCODE_SOLD_MONTHS.

const CENSUS_BATCH = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const ACTIVE = ['Active', 'Coming Soon', 'Pending', 'Active Under Contract'];

export function geoConfig(env) {
  const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
  return {
    enabled: String(env.GEOCODE_ENABLED ?? 'true').toLowerCase() !== 'false',
    batchSize: Math.min(num(env.GEOCODE_BATCH_SIZE, 1000), 10000),
    batchesPerRun: num(env.GEOCODE_BATCHES_PER_RUN, 3),
    soldMonths: num(env.GEOCODE_SOLD_MONTHS, 24),
    timeBudgetMs: num(env.GEOCODE_TIME_BUDGET_MS, 10 * 60 * 1000),
  };
}

const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

/** Parse one CSV line with quoted fields. */
export function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Census batch response: id, input, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lon,lat", tiger id, side */
export function parseCensus(text) {
  const res = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = parseCsvLine(line);
    const id = c[0];
    if (!id) continue;
    if (c[2] === 'Match' && c[5] && c[5].includes(',')) {
      const [lon, lat] = c[5].split(',').map(Number);
      if (isFinite(lat) && isFinite(lon)) { res.set(id, { lat, lon, status: c[3] === 'Exact' ? 'exact' : 'approx' }); continue; }
    }
    res.set(id, { lat: null, lon: null, status: c[2] === 'Tie' ? 'tie' : 'no_match' });
  }
  return res;
}

export async function runGeocode(env, opts) {
  opts = opts || {};
  const cfg = geoConfig(env);
  const db = env.DB;
  const fetchImpl = opts.fetch || fetch;
  const started = Date.now();
  if (!cfg.enabled) return { ok: true, skipped: true };
  const since = new Date(Date.now() - cfg.soldMonths * 30.44 * 864e5).toISOString().slice(0, 10);
  let done = 0, matched = 0, batches = 0, error = null;
  while (batches < cfg.batchesPerRun && Date.now() - started < cfg.timeBudgetMs) {
    const rows = ((await db.prepare(
      `SELECT listing_key, street_number, street_name, unit, city, state, zip FROM listings
       WHERE lat IS NULL AND geo_status IS NULL AND street_number IS NOT NULL AND street_name IS NOT NULL
         AND (status IN (${ACTIVE.map(() => '?').join(', ')}) OR (status = 'Closed' AND close_date >= ?))
       ORDER BY CASE WHEN status = 'Closed' THEN 1 ELSE 0 END, close_date DESC LIMIT ?`,
    ).bind(...ACTIVE, since, cfg.batchSize).all()).results) || [];
    if (!rows.length) break;
    batches++;
    const ids = new Map();
    const csv = rows.map((r, i) => {
      const id = String(i + 1);
      ids.set(id, r.listing_key);
      return [id, `${r.street_number} ${r.street_name}`, r.city, r.state, r.zip].map(csvCell).join(',');
    }).join('\n');
    const form = new FormData();
    form.append('benchmark', 'Public_AR_Current');
    form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
    let text;
    try {
      const res = await fetchImpl(CENSUS_BATCH, { method: 'POST', body: form });
      if (!res.ok) { error = `Census geocoder returned ${res.status}`; break; }
      text = await res.text();
    } catch (e) { error = 'Census geocoder network error: ' + e.message; break; }
    const parsed = parseCensus(text);
    const stmts = [];
    for (const [id, key] of ids) {
      const g = parsed.get(id) || { lat: null, lon: null, status: 'no_match' };
      if (g.lat != null) matched++;
      stmts.push(db.prepare('UPDATE listings SET lat = ?, lon = ?, geo_status = ? WHERE listing_key = ?').bind(g.lat, g.lon, g.status, key));
    }
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
    done += rows.length;
  }
  const remaining = (await db.prepare(
    `SELECT COUNT(*) AS n FROM listings WHERE lat IS NULL AND geo_status IS NULL AND street_number IS NOT NULL
       AND (status IN (${ACTIVE.map(() => '?').join(', ')}) OR (status = 'Closed' AND close_date >= ?))`,
  ).bind(...ACTIVE, since).first()).n;
  return { ok: !error, processed: done, matched, batches, remaining, error };
}
