// Database (Cloudflare D1 / SQLite): schema, record mapping, reads and writes.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS listings (
    listing_key TEXT PRIMARY KEY, mls_number TEXT, status TEXT, property_type TEXT, property_subtype TEXT,
    address TEXT, street_number TEXT, street_name TEXT, unit TEXT, city TEXT, state TEXT, zip TEXT, county TEXT,
    lat REAL, lon REAL, list_price REAL, original_list_price REAL, close_price REAL, close_date TEXT, list_date TEXT,
    dom INTEGER, beds INTEGER, baths_full INTEGER, baths_half INTEGER, living_area REAL, above_grade_sqft REAL,
    below_grade_finished_sqft REAL, garage_spaces REAL, year_built INTEGER, lot_acres REAL, style TEXT, basement TEXT,
    remarks TEXT, can_use TEXT, list_office TEXT, modified TEXT, synced_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_listings_state_status ON listings(state, status)',
  'CREATE INDEX IF NOT EXISTS idx_listings_close ON listings(close_date)',
  'CREATE INDEX IF NOT EXISTS idx_listings_mls ON listings(mls_number)',
  'CREATE INDEX IF NOT EXISTS idx_listings_lat ON listings(lat)',
  `CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT, next_link TEXT, high_water TEXT, run_max TEXT,
    use_select INTEGER DEFAULT 1, use_type_filter INTEGER DEFAULT 1, last_run_at TEXT, last_run_pages INTEGER, last_run_upserts INTEGER,
    last_run_deletes INTEGER, last_error TEXT, initial_completed_at TEXT)`,
  'INSERT OR IGNORE INTO sync_state (id, mode, use_select) VALUES (1, \'initial\', 1)',
  `CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, agent TEXT, tool TEXT, summary TEXT)`,
  // Agents and offices (MLS Grid Member and Office resources), for in-house contact lookups and sales rankings.
  `CREATE TABLE IF NOT EXISTS agents (
    member_key TEXT PRIMARY KEY, mls_id TEXT, full_name TEXT, first_name TEXT, last_name TEXT, email TEXT,
    mobile_phone TEXT, direct_phone TEXT, preferred_phone TEXT, office_phone TEXT, office_key TEXT, office_mls_id TEXT,
    office_name TEXT, license TEXT, status TEXT, member_type TEXT, city TEXT, state TEXT, modified TEXT, synced_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_agents_mls ON agents(mls_id)',
  'CREATE INDEX IF NOT EXISTS idx_agents_last ON agents(last_name)',
  'CREATE INDEX IF NOT EXISTS idx_agents_office ON agents(office_key)',
  `CREATE TABLE IF NOT EXISTS offices (
    office_key TEXT PRIMARY KEY, mls_id TEXT, name TEXT, phone TEXT, email TEXT, address TEXT, city TEXT, state TEXT,
    zip TEXT, broker_key TEXT, broker_mls_id TEXT, status TEXT, modified TEXT, synced_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_offices_mls ON offices(mls_id)',
];

// Agent/office columns on listings. Raw MLS Grid keys are kept so they join to agents.member_key / offices.office_key.
export const AGENT_COLS = ['list_agent_key', 'list_agent_mls_id', 'list_agent_name', 'co_list_agent_key', 'co_list_agent_mls_id', 'co_list_agent_name',
  'list_office_key', 'list_office_mls_id', 'buyer_agent_key', 'buyer_agent_mls_id', 'buyer_agent_name', 'co_buyer_agent_key',
  'co_buyer_agent_mls_id', 'co_buyer_agent_name', 'buyer_office_key', 'buyer_office_mls_id', 'buyer_office_name'];
// Bump when new listing fields are added, so existing records are re-downloaded once (see sync.js backfill).
export const LISTING_FIELDS_VERSION = 2;

let schemaReady = false;
// Columns added after the first deploy. Each runs once; "duplicate column" errors are expected afterwards.
const MIGRATIONS = [
  'ALTER TABLE sync_state ADD COLUMN lock_until TEXT',
  'ALTER TABLE sync_state ADD COLUMN dropped_fields TEXT',
  'ALTER TABLE sync_state ADD COLUMN field_inventory TEXT',
  'ALTER TABLE sync_state ADD COLUMN geo_last_run TEXT',
  'ALTER TABLE listings ADD COLUMN geo_status TEXT',
  'ALTER TABLE listings ADD COLUMN basement_total_sqft REAL',
  'ALTER TABLE listings ADD COLUMN bsmt_estimated INTEGER',
  'ALTER TABLE listings ADD COLUMN sqft_note TEXT',
  // Agent and office IDs on each listing (list side and buyer side).
  ...AGENT_COLS.map((c) => `ALTER TABLE listings ADD COLUMN ${c} TEXT`),
  'CREATE INDEX IF NOT EXISTS idx_listings_list_agent ON listings(list_agent_key)',
  'CREATE INDEX IF NOT EXISTS idx_listings_co_list_agent ON listings(co_list_agent_key)',
  'CREATE INDEX IF NOT EXISTS idx_listings_buyer_agent ON listings(buyer_agent_key)',
  'CREATE INDEX IF NOT EXISTS idx_listings_co_buyer_agent ON listings(co_buyer_agent_key)',
  'CREATE INDEX IF NOT EXISTS idx_listings_list_office ON listings(list_office_key)',
  'CREATE INDEX IF NOT EXISTS idx_listings_buyer_office ON listings(buyer_office_key)',
  'ALTER TABLE sync_state ADD COLUMN listing_fields_version INTEGER',
  'ALTER TABLE sync_state ADD COLUMN backfill_high_water TEXT',
  'ALTER TABLE sync_state ADD COLUMN backfill_done_at TEXT',
  'ALTER TABLE sync_state ADD COLUMN member_mode TEXT',
  'ALTER TABLE sync_state ADD COLUMN member_high_water TEXT',
  'ALTER TABLE sync_state ADD COLUMN member_error TEXT',
  'ALTER TABLE sync_state ADD COLUMN office_mode TEXT',
  'ALTER TABLE sync_state ADD COLUMN office_high_water TEXT',
  'ALTER TABLE sync_state ADD COLUMN office_error TEXT',
];

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  for (const m of MIGRATIONS) { try { await db.prepare(m).run(); } catch (e) { /* already applied */ } }
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
  'ListOfficeName', 'MRD_BSMNT_SQFT',
  'ListAgentKey', 'ListAgentMlsId', 'ListAgentFullName', 'CoListAgentKey', 'CoListAgentMlsId', 'CoListAgentFullName',
  'ListOfficeKey', 'ListOfficeMlsId', 'BuyerAgentKey', 'BuyerAgentMlsId', 'BuyerAgentFullName', 'CoBuyerAgentKey',
  'CoBuyerAgentMlsId', 'CoBuyerAgentFullName', 'BuyerOfficeKey', 'BuyerOfficeMlsId', 'BuyerOfficeName',
];

const COLS = ['listing_key', 'mls_number', 'status', 'property_type', 'property_subtype', 'address', 'street_number', 'street_name',
  'unit', 'city', 'state', 'zip', 'county', 'lat', 'lon', 'list_price', 'original_list_price', 'close_price', 'close_date',
  'list_date', 'dom', 'beds', 'baths_full', 'baths_half', 'living_area', 'above_grade_sqft', 'below_grade_finished_sqft',
  'garage_spaces', 'year_built', 'lot_acres', 'style', 'basement', 'remarks', 'can_use', 'list_office', 'basement_total_sqft', 'bsmt_estimated', 'sqft_note', 'modified', 'synced_at', ...AGENT_COLS];

const pick = (r, ...keys) => {
  for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return null;
};
const n = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const list = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? null : String(v));
const date = (v) => (v ? String(v).slice(0, 10) : null);
const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

// MLS Grid puts an MLS prefix on key fields (e.g. MRD...). It must be removed before display.
export const stripPrefix = (v, prefix) => (v == null ? null : prefix && String(v).toUpperCase().startsWith(prefix.toUpperCase()) ? String(v).slice(prefix.length) : String(v));

// Finished basement area. Use the standard field when the MLS fills it; otherwise estimate it from MRED's basement
// size (MRD_BSMNT_SQFT) and the Basement description: finished = all of it, partially finished = half, else none.
export function finishedBasement(r) {
  const reported = n(r.BelowGradeFinishedArea);
  if (reported != null) return { sqft: reported, estimated: 0 };
  const total = n(r.MRD_BSMNT_SQFT);
  const desc = (Array.isArray(r.Basement) ? r.Basement.join(' ') : String(r.Basement || '')).toLowerCase();
  if (!total || !desc || /\b(none|crawl|slab)\b/.test(desc) && !/finished/.test(desc)) return { sqft: total ? 0 : null, estimated: total ? 1 : 0 };
  if (/partial(ly)?[ -]?finished|part finished/.test(desc)) return { sqft: Math.round(total / 2), estimated: 1 };
  if (/unfinished/.test(desc) && !/(^|[^n])finished/.test(desc.replace(/unfinished/g, ''))) return { sqft: 0, estimated: 1 };
  if (/finished/.test(desc)) return { sqft: total, estimated: 1 };
  return { sqft: 0, estimated: 1 };
}

export function mapRecord(r, syncedAt, prefix, opts) {
  opts = opts || {};
  const bsmt = finishedBasement(r);
  const above = n(r.AboveGradeFinishedArea);
  const living = n(r.LivingArea);
  const street = [r.StreetDirPrefix, r.StreetName, r.StreetSuffix, r.StreetDirSuffix].filter(Boolean).join(' ') || null;
  const addr = r.UnparsedAddress || [r.StreetNumber, street].filter(Boolean).join(' ') || null;
  return {
    listing_key: String(r.ListingKey),
    mls_number: stripPrefix(pick(r, 'ListingId'), prefix),
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
    // MRED's LivingArea is its "approx. sq ft" above grade (basement is reported separately), so it stands in for
    // AboveGradeFinishedArea when ABOVE_GRADE_FROM_LIVING_AREA is on.
    above_grade_sqft: above != null ? above : opts.livingIsAboveGrade ? living : null,
    below_grade_finished_sqft: bsmt.sqft,
    garage_spaces: n(r.GarageSpaces),
    year_built: n(r.YearBuilt),
    lot_acres: n(r.LotSizeAcres),
    style: list(r.ArchitecturalStyle),
    basement: list(r.Basement),
    basement_total_sqft: n(r.MRD_BSMNT_SQFT),
    bsmt_estimated: bsmt.estimated,
    sqft_note: above != null ? null : opts.livingIsAboveGrade && living != null ? 'living area used as above grade' : null,
    remarks: r.PublicRemarks ? String(r.PublicRemarks).slice(0, 1500) : null,
    can_use: r.MlgCanUse == null ? null : list(r.MlgCanUse),
    list_office: pick(r, 'ListOfficeName'),
    modified: pick(r, 'ModificationTimestamp'),
    synced_at: syncedAt,
    list_agent_key: str(r.ListAgentKey),
    list_agent_mls_id: stripPrefix(pick(r, 'ListAgentMlsId'), prefix),
    list_agent_name: pick(r, 'ListAgentFullName'),
    co_list_agent_key: str(r.CoListAgentKey),
    co_list_agent_mls_id: stripPrefix(pick(r, 'CoListAgentMlsId'), prefix),
    co_list_agent_name: pick(r, 'CoListAgentFullName'),
    list_office_key: str(r.ListOfficeKey),
    list_office_mls_id: stripPrefix(pick(r, 'ListOfficeMlsId'), prefix),
    buyer_agent_key: str(r.BuyerAgentKey),
    buyer_agent_mls_id: stripPrefix(pick(r, 'BuyerAgentMlsId'), prefix),
    buyer_agent_name: pick(r, 'BuyerAgentFullName'),
    co_buyer_agent_key: str(r.CoBuyerAgentKey),
    co_buyer_agent_mls_id: stripPrefix(pick(r, 'CoBuyerAgentMlsId'), prefix),
    co_buyer_agent_name: pick(r, 'CoBuyerAgentFullName'),
    buyer_office_key: str(r.BuyerOfficeKey),
    buyer_office_mls_id: stripPrefix(pick(r, 'BuyerOfficeMlsId'), prefix),
    buyer_office_name: pick(r, 'BuyerOfficeName'),
  };
}

// MLS Grid Member record -> agents row.
export function mapMember(r, syncedAt, prefix) {
  return {
    member_key: String(r.MemberKey),
    mls_id: stripPrefix(pick(r, 'MemberMlsId'), prefix),
    full_name: pick(r, 'MemberFullName') || [r.MemberFirstName, r.MemberLastName].filter(Boolean).join(' ') || null,
    first_name: pick(r, 'MemberFirstName'),
    last_name: pick(r, 'MemberLastName'),
    email: pick(r, 'MemberEmail'),
    mobile_phone: pick(r, 'MemberMobilePhone'),
    direct_phone: pick(r, 'MemberDirectPhone'),
    preferred_phone: pick(r, 'MemberPreferredPhone'),
    office_phone: pick(r, 'MemberOfficePhone'),
    office_key: str(r.OfficeKey),
    office_mls_id: stripPrefix(pick(r, 'OfficeMlsId'), prefix),
    office_name: pick(r, 'OfficeName'),
    license: pick(r, 'MemberStateLicense'),
    status: pick(r, 'MemberStatus'),
    member_type: pick(r, 'MemberType'),
    city: pick(r, 'MemberCity'),
    state: pick(r, 'MemberStateOrProvince'),
    modified: pick(r, 'ModificationTimestamp'),
    synced_at: syncedAt,
  };
}

// MLS Grid Office record -> offices row.
export function mapOffice(r, syncedAt, prefix) {
  return {
    office_key: String(r.OfficeKey),
    mls_id: stripPrefix(pick(r, 'OfficeMlsId'), prefix),
    name: pick(r, 'OfficeName'),
    phone: pick(r, 'OfficePhone'),
    email: pick(r, 'OfficeEmail'),
    address: [r.OfficeAddress1, r.OfficeAddress2].filter(Boolean).join(' ') || null,
    city: pick(r, 'OfficeCity'),
    state: pick(r, 'OfficeStateOrProvince'),
    zip: r.OfficePostalCode ? String(r.OfficePostalCode).slice(0, 5) : null,
    broker_key: str(r.OfficeBrokerKey),
    broker_mls_id: stripPrefix(pick(r, 'OfficeBrokerMlsId'), prefix),
    status: pick(r, 'OfficeStatus'),
    modified: pick(r, 'ModificationTimestamp'),
    synced_at: syncedAt,
  };
}

export const AGENT_TABLE_COLS = ['member_key', 'mls_id', 'full_name', 'first_name', 'last_name', 'email', 'mobile_phone', 'direct_phone',
  'preferred_phone', 'office_phone', 'office_key', 'office_mls_id', 'office_name', 'license', 'status', 'member_type', 'city', 'state', 'modified', 'synced_at'];
export const OFFICE_TABLE_COLS = ['office_key', 'mls_id', 'name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'broker_key',
  'broker_mls_id', 'status', 'modified', 'synced_at'];

// Generic upsert / delete for the agents and offices tables.
export async function upsertTable(db, table, cols, rows) {
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(${cols[0]}) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await db.batch(chunk.map((row) => db.prepare(sql).bind(...cols.map((c) => (row[c] === undefined ? null : row[c])))));
  }
}
export async function deleteFromTable(db, table, keyCol, keys) {
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    await db.prepare(`DELETE FROM ${table} WHERE ${keyCol} IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).run();
  }
}

const UPSERT_SQL = `INSERT INTO listings (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
  ON CONFLICT(listing_key) DO UPDATE SET ${COLS.slice(1).map((c) => (c === 'lat' || c === 'lon' ? `${c} = COALESCE(excluded.${c}, listings.${c})` : `${c} = excluded.${c}`)).join(', ')}`;
// (Coordinates are kept when an update arrives without them, so geocoded positions survive MLS updates.)

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
  const agents = (await db.prepare('SELECT COUNT(*) AS n FROM agents').first()) || { n: 0 };
  const offices = (await db.prepare('SELECT COUNT(*) AS n FROM offices').first()) || { n: 0 };
  const withAgent = (await db.prepare('SELECT COUNT(*) AS n FROM listings WHERE list_agent_key IS NOT NULL').first()) || { n: 0 };
  return { total: total.n, lastCloseDate: lastClose.d || null, byStatus, agents: agents.n, offices: offices.n, listings_with_agent_ids: withAgent.n };
}

export async function agentByKey(db, key) {
  if (!key) return null;
  return db.prepare('SELECT a.*, o.phone AS office_main_phone FROM agents a LEFT JOIN offices o ON o.office_key = a.office_key WHERE a.member_key = ?').bind(key).first();
}

/** Search agents by MLS ID, name words and/or office name. */
export async function searchAgents(db, { mlsId, name, office, limit }) {
  const where = [], args = [];
  if (mlsId) { where.push('a.mls_id = ?'); args.push(String(mlsId)); }
  for (const w of String(name || '').split(/[\s,]+/).filter(Boolean)) { where.push('a.full_name LIKE ?'); args.push(`%${w}%`); }
  if (office) { where.push('(a.office_name LIKE ? OR o.name LIKE ?)'); args.push(`%${office}%`, `%${office}%`); }
  if (!where.length) return [];
  const sql = `SELECT a.*, o.name AS office_full_name, o.phone AS office_main_phone, o.address AS office_address, o.city AS office_city,
    o.state AS office_state, o.zip AS office_zip FROM agents a LEFT JOIN offices o ON o.office_key = a.office_key
    WHERE ${where.join(' AND ')} ORDER BY a.last_name, a.first_name LIMIT ?`;
  return ((await db.prepare(sql).bind(...args, limit || 10).all()).results) || [];
}

/** An agent's activity in the stored (service-area) listings since a date. */
export async function agentActivity(db, key, since) {
  return db.prepare(`SELECT
    SUM(CASE WHEN (list_agent_key = ?1 OR co_list_agent_key = ?1) AND list_date >= ?2 THEN 1 ELSE 0 END) AS listings_taken,
    SUM(CASE WHEN (list_agent_key = ?1 OR co_list_agent_key = ?1) AND status = 'Closed' AND close_date >= ?2 THEN 1 ELSE 0 END) AS closed_list_side,
    SUM(CASE WHEN (buyer_agent_key = ?1 OR co_buyer_agent_key = ?1) AND status = 'Closed' AND close_date >= ?2 THEN 1 ELSE 0 END) AS closed_buyer_side,
    SUM(CASE WHEN (list_agent_key = ?1 OR co_list_agent_key = ?1) AND status IN ('Active','Coming Soon','Pending','Active Under Contract') THEN 1 ELSE 0 END) AS current_listings
    FROM listings WHERE list_agent_key = ?1 OR co_list_agent_key = ?1 OR buyer_agent_key = ?1 OR co_buyer_agent_key = ?1`).bind(key, since).first();
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
