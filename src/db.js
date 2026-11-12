// Database (Cloudflare D1 / SQLite): schema, record mapping, reads and writes.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS listings (
    listing_key TEXT PRIMARY KEY, mls_number TEXT, status TEXT, property_type TEXT, property_subtype TEXT,
    address TEXT, street_number TEXT, street_name TEXT, unit TEXT, city TEXT, state TEXT, zip TEXT, county TEXT,
    lat REAL, lon REAL, list_price REAL, original_list_price REAL, close_price REAL, close_date TEXT, list_date TEXT,
    dom INTEGER, beds INTEGER, baths_full INTEGER, baths_half INTEGER, living_area REAL, above_grade_sqft REAL,
    below_grade_finished_sqft REAL, garage_spaces REAL, year_built INTEGER, lot_acres REAL, style TEXT, basement TEXT,
    remarks TEXT, can_use TEXT, modified TEXT, synced_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_listings_state_status ON listings(state, status)',
  'CREATE INDEX IF NOT EXISTS idx_listings_close ON listings(close_date)',
  'CREATE INDEX IF NOT EXISTS idx_listings_mls ON listings(mls_number)',
  'CREATE INDEX IF NOT EXISTS idx_listings_lat ON listings(lat)',
  `CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT, next_link TEXT, high_water TEXT, run_max TEXT,
    use_select INTEGER DEFAULT 1, last_run_at TEXT, last_run_pages INTEGER, last_run_upserts INTEGER,
    last_run_deletes INTEGER, last_error TEXT, initial_completed_at TEXT)`,
  'INSERT OR IGNORE INTO sync_state (id, mode, use_select) VALUES (1, \'initial\', 1)',
  `CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, agent TEXT, tool TEXT, summary TEXT)`,
];

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}
export function _resetSchemaFlag() { schemaReady = false; }

// Fields requested from MLS Grid ($select). Standard RESO names.
export const SELECT_FIELDS = [
  'ListingKey', 'ListingId', 'OriginatingSystemName', 'MlgCanView', 'MlgCanUse', 'ModificationTimestamp', 'StandardStatus',
  'PropertyType', 'PropertySubType', 'UnparsedAddress', 'StreetNumber', 'StreetDirPrefix', 'StreetName', 'StreetSuffix',
  'StreetDirSuffix', 'UnitNumber', 'City', 'StateOrProvince', 'PostalCode', 'CountyOrParish', 'Latitude', 'Longitude',
  'ListPrice', 'OriginalListPrice', 'ClosePrice', 'CloseDate', 'ListingContractDate', 'OnMarketDate', 'DaysOnMarket',
  'CumulativeDaysOnMarket', 'BedroomsTotal', 'BathroomsFull', 'BathroomsHalf', 'LivingArea', 'AboveGradeFinishedArea',
  'BelowGradeFinishedArea', 'GarageSpaces', 'YearBuilt', 'LotSizeAcres', 'ArchitecturalStyle', 'Basement', 'PublicRemarks',
];

const COLS = ['listing_key', 'mls_number', 'status', 'property_type', 'property_subtype', 'address', 'street_number', 'street_name',
  'unit', 'city', 'state', 'zip', 'county', 'lat', 'lon', 'list_price', 'original_list_price', 'close_price', 'close_date',
  'list_date', 'dom', 'beds', 'baths_full', 'baths_half', 'living_area', 'above_grade_sqft', 'below_grade_finished_sqft',
  'garage_spaces', 'year_built', 'lot_acres', 'style', 'basement', 'remarks', 'can_use', 'modified', 'synced_at'];

const pick = (r, ...keys) => {
  for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return null;
};
const n = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const list = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? null : String(v));
const date = (v) => (v ? String(v).slice(0, 10) : null);

export function mapRecord(r, syncedAt) {
  const street = [r.StreetDirPrefix, r.StreetName, r.StreetSuffix, r.StreetDirSuffix].filter(Boolean).join(' ') || null;
  const addr = r.UnparsedAddress || [r.StreetNumber, street].filter(Boolean).join(' ') || null;
  return {
    listing_key: String(r.ListingKey),
    mls_number: pick(r, 'ListingId'),
    status: pick(r, 'StandardStatus'),
    property_type: pick(r, 'PropertyType'),
    property_subtype: pick(r, 'PropertySubType'),
    address: addr,
    street_number: r.StreetNumber != null ? String(r.StreetNumber) : null,
    street_name: street,
    unit: pick(r, 'UnitNumber'),
    city: pick(r, 'City'),
    state: r.StateOrProvince ? String(r.StateOrProvince).toUpperCase() : null,
    zip: r.PostalCode ? String(r.PostalCode).slice(0, 5) : null,
    county: pick(r, 'CountyOrParish'),
    lat: n(r.Latitude),
    lon: n(r.Longitude),
    list_price: n(r.ListPrice),
    original_list_price: n(r.OriginalListPrice),
    close_price: n(r.ClosePrice),
    close_date: date(r.CloseDate),
    list_date: date(pick(r, 'ListingContractDate', 'OnMarketDate')),
    dom: n(pick(r, 'CumulativeDaysOnMarket', 'DaysOnMarket')),
    beds: n(r.BedroomsTotal),
    baths_full: n(r.BathroomsFull),
    baths_half: n(r.BathroomsHalf),
    living_area: n(r.LivingArea),
    above_grade_sqft: n(r.AboveGradeFinishedArea),
    below_grade_finished_sqft: n(r.BelowGradeFinishedArea),
    garage_spaces: n(r.GarageSpaces),
    year_built: n(r.YearBuilt),
    lot_acres: n(r.LotSizeAcres),
    style: list(r.ArchitecturalStyle),
    basement: list(r.Basement),
    remarks: r.PublicRemarks ? String(r.PublicRemarks).slice(0, 1500) : null,
    can_use: r.MlgCanUse == null ? null : list(r.MlgCanUse),
    modified: pick(r, 'ModificationTimestamp'),
    synced_at: syncedAt,
  };
}

const UPSERT_SQL = `INSERT INTO listings (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
  ON CONFLICT(listing_key) DO UPDATE SET ${COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`;

export async function upsertRows(db, rows) {
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await db.batch(chunk.map((row) => db.prepare(UPSERT_SQL).bind(...COLS.map((c) => (row[c] === undefined ? null : row[c])))));
  }
}

export async function deleteKeys(db, keys) {
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    await db.prepare(`DELETE FROM listings WHERE listing_key IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).run();
  }
}

export async function getSyncState(db) {
  return (await db.prepare('SELECT * FROM sync_state WHERE id = 1').first()) || {};
}
export async function saveSyncState(db, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await db.prepare(`UPDATE sync_state SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`)
    .bind(...keys.map((k) => (patch[k] === undefined ? null : patch[k]))).run();
}

// Listings inside a lat/lon box (callers filter by true distance afterwards).
export async function listingsInBox(db, { state, statuses, box, closedSince }) {
  // Only records the MLS allows for Back Office use (MlgCanUse contains BO). Records without the field are kept.
  const where = ['state = ?', 'lat BETWEEN ? AND ?', 'lon BETWEEN ? AND ?', "(can_use IS NULL OR can_use LIKE '%BO%')"];
  const args = [state, box.minLat, box.maxLat, box.minLon, box.maxLon];
  if (statuses && statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(', ')})`); args.push(...statuses); }
  if (closedSince) { where.push('close_date >= ?'); args.push(closedSince); }
  const res = await db.prepare(`SELECT * FROM listings WHERE ${where.join(' AND ')} LIMIT 3000`).bind(...args).all();
  return res.results || [];
}

export async function listingByMls(db, mls) {
  return db.prepare('SELECT * FROM listings WHERE mls_number = ? ORDER BY modified DESC LIMIT 1').bind(String(mls)).first();
}

export async function searchByAddress(db, query, limit) {
  const q = String(query || '').trim();
  const m = q.match(/^(\d+)\s+(.+)$/);
  let res;
  if (m) {
    const word = m[2].replace(/,.*$/, '').trim().split(/\s+/).find((w) => !/^(n|s|e|w|north|south|east|west)\.?$/i.test(w)) || m[2];
    res = await db.prepare('SELECT * FROM listings WHERE street_number = ? AND (street_name LIKE ? OR address LIKE ?) ORDER BY modified DESC LIMIT ?')
      .bind(m[1], `%${word}%`, `%${word}%`, limit || 10).all();
  } else {
    res = await db.prepare('SELECT * FROM listings WHERE address LIKE ? ORDER BY modified DESC LIMIT ?').bind(`%${q}%`, limit || 10).all();
  }
  return res.results || [];
}

export async function stats(db) {
  const byStatus = (await db.prepare('SELECT state, status, COUNT(*) AS n FROM listings GROUP BY state, status ORDER BY state, n DESC').all()).results || [];
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM listings').first()) || { n: 0 };
  const lastClose = (await db.prepare('SELECT MAX(close_date) AS d FROM listings').first()) || {};
  return { total: total.n, lastCloseDate: lastClose.d || null, byStatus };
}

export async function logUsage(db, agent, tool, summary) {
  try {
    await db.prepare('INSERT INTO usage_log (at, agent, tool, summary) VALUES (?, ?, ?, ?)')
      .bind(new Date().toISOString(), agent, tool, String(summary || '').slice(0, 300)).run();
  } catch (e) { /* logging must never break a request */ }
}
export async function recentUsage(db, limit) {
  return ((await db.prepare('SELECT at, agent, tool, summary FROM usage_log ORDER BY id DESC LIMIT ?').bind(limit || 25).all()).results) || [];
}
