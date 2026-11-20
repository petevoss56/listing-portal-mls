// MLS Grid replication, following the MLS Grid "Best Practices for Obtaining Data" guide:
//  - Initial import: OriginatingSystemName eq 'mred' and MlgCanView eq true, following @odata.nextLink.
//  - Never start over after an error: resume with "ModificationTimestamp gt <greatest received so far>".
//  - Afterwards, every 15 minutes: "ModificationTimestamp gt <greatest in our database>" (no MlgCanView filter),
//    so records MLS Grid marks MlgCanView = false arrive and are deleted locally.
//  - One request at a time, at most 2 per second, gzip, no parentheses except around "in"/"or".
// Only listings inside SERVICE_AREA are stored.
import { config, normCounty, QC_CITIES } from './config.js';
import { ensureSchema, getSyncState, saveSyncState, mapRecord, upsertRows, deleteKeys, SELECT_FIELDS, LISTING_FIELDS_VERSION,
  mapMember, mapOffice, upsertTable, deleteFromTable, AGENT_TABLE_COLS, OFFICE_TABLE_COLS } from './db.js';

// Agent and office rosters (MLS Grid Member and Office resources). Small, so no $select: we keep only the fields we map.
export const ROSTERS = [
  { name: 'members', resource: 'Member', key: 'MemberKey', table: 'agents', keyCol: 'member_key', cols: AGENT_TABLE_COLS, map: mapMember, state: 'member' },
  { name: 'offices', resource: 'Office', key: 'OfficeKey', table: 'offices', keyCol: 'office_key', cols: OFFICE_TABLE_COLS, map: mapOffice, state: 'office' },
];

export function rosterUrl(cfg, roster, { mode, checkpoint }) {
  const f = [`OriginatingSystemName eq '${cfg.source}'`];
  if (mode !== 'incremental') f.push('MlgCanView eq true');
  if (checkpoint) f.push(`ModificationTimestamp gt ${checkpoint}`);
  return `${cfg.base}/${roster.resource}?$filter=${encodeURIComponent(f.join(' and '))}&$top=${cfg.pageSize}`;
}

export function inServiceArea(rec, area) {
  const st = String(rec.StateOrProvince || '').toUpperCase();
  if (!area[st]) return false;
  if (rec.CountyOrParish) return area[st].has(normCounty(rec.CountyOrParish));
  return (QC_CITIES[st] || []).includes(String(rec.City || '').toLowerCase().trim());
}

export function buildUrl(cfg, { mode, checkpoint, useSelect, useTypeFilter, dropped }) {
  const f = [`OriginatingSystemName eq '${cfg.source}'`];
  if (useTypeFilter !== false && cfg.propertyTypes.length) {
    f.push(cfg.propertyTypes.length === 1
      ? `PropertyType eq '${cfg.propertyTypes[0]}'`
      : `PropertyType in (${cfg.propertyTypes.map((t) => `'${t}'`).join(',')})`);
  }
  if (mode !== 'incremental') f.push('MlgCanView eq true');
  if (checkpoint) f.push(`ModificationTimestamp gt ${checkpoint}`);
  const params = [`$filter=${encodeURIComponent(f.join(' and '))}`, `$top=${cfg.pageSize}`];
  if (useSelect !== false) params.push(`$select=${SELECT_FIELDS.filter((x) => !(dropped && dropped.has(x))).join(',')}`);
  return `${cfg.base}/Property?${params.join('&')}`;
}

// Fields the sync cannot work without; if the MLS lacks one of these we stop and report instead of dropping it.
const CORE_FIELDS = ['ListingKey', 'ModificationTimestamp', 'MlgCanView', 'StandardStatus', 'StateOrProvince'];

const maxTs = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);

export async function runSync(env, opts) {
  opts = opts || {};
  const cfg = config(env);
  const db = env.DB;
  const fetchImpl = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  await ensureSchema(db);
  const now = new Date().toISOString();
  if (!cfg.token) {
    await saveSyncState(db, { last_run_at: now, last_error: 'MLSGRID_TOKEN is not set' });
    return { ok: false, error: 'MLSGRID_TOKEN is not set' };
  }

  const st = await getSyncState(db);
  // Only one sync at a time (MLS Grid: replication requests must be sequential, never in parallel).
  if (st.lock_until && st.lock_until > now && !opts.ignoreLock) return { ok: true, skipped: true, reason: 'Another sync is still running.' };
  await saveSyncState(db, { lock_until: new Date(started + cfg.timeBudgetMs + 120000).toISOString() });
  const mode = st.mode === 'incremental' ? 'incremental' : 'initial';
  // The first import can run faster (INITIAL_IMPORT_MAX_PAGES) during an MLS Grid grace period;
  // once it finishes, every run drops back to SYNC_MAX_PAGES automatically.
  const maxPages = opts.maxPages || (mode === 'initial' ? cfg.initialMaxPages : cfg.maxPages);
  let useSelect = st.use_select !== 0;
  let useTypeFilter = st.use_type_filter !== 0;
  let checkpoint = st.high_water || null; // greatest ModificationTimestamp received so far
  // Fields this MLS doesn't provide; MLS Grid rejects a $select that names them, so we learn and skip them.
  const dropped = new Set(String(st.dropped_fields || '').split(',').filter(Boolean));
  const fresh = () => buildUrl(cfg, { mode, checkpoint, useSelect, useTypeFilter, dropped });
  let url = fresh();
  let firstPage = true;

  // One-time field inventory: which fields this MLS actually sends (names and how many of 5 samples have a value).
  // Field names only are kept — never values. Runs inside the lock, in sequence with the replication requests.
  if (!st.field_inventory && !opts.skipInventory && String(env.FIELD_INVENTORY ?? 'true') !== 'false') {
    try {
      const f = [`OriginatingSystemName eq '${cfg.source}'`, 'MlgCanView eq true'];
      if (useTypeFilter && cfg.propertyTypes.length === 1) f.splice(1, 0, `PropertyType eq '${cfg.propertyTypes[0]}'`);
      const r = await fetchImpl(`${cfg.base}/Property?$filter=${encodeURIComponent(f.join(' and '))}&$top=5`, { headers: { Authorization: `Bearer ${cfg.token}`, 'Accept-Encoding': 'gzip, deflate' } });
      if (r.ok) {
        const j = await r.json();
        const counts = {};
        for (const rec of j.value || []) for (const [k, v] of Object.entries(rec)) counts[k] = (counts[k] || 0) + (v !== null && v !== '' && !(Array.isArray(v) && !v.length) ? 1 : 0);
        await saveSyncState(db, { field_inventory: JSON.stringify({ at: now, samples: (j.value || []).length, fields: counts }) });
      }
      await sleep(cfg.requestGapMs);
    } catch (e) { /* inventory is best-effort */ }
  }
  let pages = 0, upserts = 0, deletes = 0, error = null, finished = false;

  while (pages < maxPages && Date.now() - started < cfg.timeBudgetMs) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.token}`, 'Accept-Encoding': 'gzip, deflate' } });
    } catch (e) { error = 'Network error: ' + e.message; break; }
    pages++;
    if (res.status === 400 && firstPage && useSelect) {
      const body = await res.clone().text().catch(() => '');
      const m = body.match(/field '([A-Za-z0-9_]+)' does not exist/i) || body.match(/Invalid select field[^']*'([A-Za-z0-9_]+)'/i);
      if (m && SELECT_FIELDS.includes(m[1]) && !CORE_FIELDS.includes(m[1]) && !dropped.has(m[1]) && dropped.size < 40) {
        dropped.add(m[1]);
        await saveSyncState(db, { dropped_fields: [...dropped].join(',') });
        url = fresh();
        await sleep(cfg.requestGapMs);
        continue;
      }
    }
    if (res.status === 400 && firstPage && (useTypeFilter || useSelect)) {
      // Request shape not accepted. Falling back means downloading much more data, so it is off unless
      // ALLOW_LARGER_REQUESTS = "true" (keeps us far inside MLS Grid's hourly data caps by default).
      if (!cfg.allowLarger) {
        error = 'MLS Grid rejected the request (400). Larger fallback requests are turned off (ALLOW_LARGER_REQUESTS). ' + (await res.text().catch(() => '')).slice(0, 200);
        break;
      }
      if (useTypeFilter && cfg.propertyTypes.length) { useTypeFilter = false; await saveSyncState(db, { use_type_filter: 0 }); }
      else { useSelect = false; await saveSyncState(db, { use_select: 0 }); }
      url = fresh();
      continue;
    }
    if (res.status === 429) { error = 'MLS Grid rate limit reached (429). Will resume from the checkpoint next run.'; break; }
    if (!res.ok) {
      error = `MLS Grid returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
      break; // next run resumes from the saved checkpoint; never starts over
    }
    firstPage = false;
    const json = await res.json();
    const p = await saveListingPage(db, cfg, json, now, useTypeFilter);
    upserts += p.upserts; deletes += p.deletes;
    checkpoint = maxTs(checkpoint, p.pageMax);
    await saveSyncState(db, { high_water: checkpoint });

    const next = json['@odata.nextLink'];
    if (!next) {
      // A fresh import already has every listing field, so no backfill is needed afterwards.
      if (mode === 'initial') await saveSyncState(db, { mode: 'incremental', initial_completed_at: now, listing_fields_version: LISTING_FIELDS_VERSION });
      finished = true;
      break;
    }
    url = next;
    await sleep(cfg.requestGapMs);
  }
  // Once listings are current, spend any remaining request budget on the agent/office rosters, then on the
  // one-time re-download that adds agent IDs to listings stored before those fields existed.
  const extra = {};
  if (!error && finished) {
    const ctx = {
      db, cfg, now, fetchImpl, sleep,
      canRequest: () => pages < maxPages && Date.now() - started < cfg.timeBudgetMs,
      request: async (u) => { await sleep(cfg.requestGapMs); pages++; return fetchImpl(u, { headers: { Authorization: `Bearer ${cfg.token}`, 'Accept-Encoding': 'gzip, deflate' } }); },
    };
    for (const roster of ROSTERS) {
      extra[roster.name] = await syncRoster(ctx, roster);
      if (extra[roster.name].rateLimited) { error = extra[roster.name].error; break; }
    }
    if (!error) {
      extra.backfill = await backfillListings(ctx, { useSelect, useTypeFilter, dropped });
      if (extra.backfill.error) error = extra.backfill.error;
    }
  }

  await saveSyncState(db, { last_run_at: now, last_run_pages: pages, last_run_upserts: upserts, last_run_deletes: deletes, last_error: error, lock_until: null });
  return Object.assign({ ok: !error, mode, pages, upserts, deletes, finished, error }, extra);
}

/** Store one page of Property records: keep service-area records, delete ones MLS Grid hides. */
async function saveListingPage(db, cfg, json, now, useTypeFilter) {
  const keep = [], drop = [];
  let pageMax = null;
  for (const r of json.value || []) {
    pageMax = maxTs(pageMax, r.ModificationTimestamp);
    if (r.MlgCanView === false) drop.push(String(r.ListingKey));
    else if (inServiceArea(r, cfg.serviceArea) && (!cfg.propertyTypes.length || useTypeFilter || cfg.propertyTypes.includes(r.PropertyType))) keep.push(mapRecord(r, now, cfg.keyPrefix, { livingIsAboveGrade: cfg.livingIsAboveGrade }));
  }
  if (keep.length) await upsertRows(db, keep);
  if (drop.length) await deleteKeys(db, drop);
  return { upserts: keep.length, deletes: drop.length, pageMax };
}

/**
 * Replicate a roster (Member or Office) the same way as listings: first an import of visible records,
 * then "ModificationTimestamp gt <checkpoint>" without the MlgCanView filter so hidden records get deleted.
 * A failure here (e.g. the subscription doesn't include the resource) is recorded but never blocks listings.
 */
async function syncRoster(ctx, roster) {
  const { db, cfg, now } = ctx;
  const st = await getSyncState(db);
  const mode = st[`${roster.state}_mode`] === 'incremental' ? 'incremental' : 'initial';
  let checkpoint = st[`${roster.state}_high_water`] || null;
  let url = rosterUrl(cfg, roster, { mode, checkpoint });
  let saved = 0, removed = 0, error = null, done = false;
  while (ctx.canRequest()) {
    let res;
    try { res = await ctx.request(url); } catch (e) { error = 'Network error: ' + e.message; break; }
    if (res.status === 429) return { saved, removed, rateLimited: true, error: 'MLS Grid rate limit reached (429). Will resume from the checkpoint next run.' };
    if (!res.ok) { error = `MLS Grid ${roster.resource} returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`; break; }
    const json = await res.json();
    const keep = [], drop = [];
    let pageMax = null;
    for (const r of json.value || []) {
      pageMax = maxTs(pageMax, r.ModificationTimestamp);
      if (r[roster.key] == null) continue;
      if (r.MlgCanView === false) drop.push(String(r[roster.key]));
      else keep.push(roster.map(r, now, cfg.keyPrefix));
    }
    if (keep.length) await upsertTable(db, roster.table, roster.cols, keep);
    if (drop.length) await deleteFromTable(db, roster.table, roster.keyCol, drop);
    saved += keep.length; removed += drop.length;
    checkpoint = maxTs(checkpoint, pageMax);
    await saveSyncState(db, { [`${roster.state}_high_water`]: checkpoint });
    const next = json['@odata.nextLink'];
    if (!next) {
      if (mode === 'initial') await saveSyncState(db, { [`${roster.state}_mode`]: 'incremental' });
      done = true;
      break;
    }
    url = next;
  }
  await saveSyncState(db, { [`${roster.state}_error`]: error });
  return { saved, removed, done, error };
}

/**
 * One-time re-download of every visible listing so records stored before agent IDs were added get them.
 * Walks oldest to newest on its own checkpoint, a few pages per run, alongside the normal 15-minute sync.
 */
async function backfillListings(ctx, { useSelect, useTypeFilter, dropped }) {
  const { db, cfg, now } = ctx;
  const st = await getSyncState(db);
  if (st.mode !== 'incremental' || (st.listing_fields_version || 1) >= LISTING_FIELDS_VERSION) return { needed: false };
  let checkpoint = st.backfill_high_water || null;
  let url = buildUrl(cfg, { mode: 'initial', checkpoint, useSelect, useTypeFilter, dropped });
  let pages = 0, saved = 0, error = null, done = false;
  while (ctx.canRequest()) {
    let res;
    try { res = await ctx.request(url); } catch (e) { error = 'Network error: ' + e.message; break; }
    pages++;
    if (res.status === 429) { error = 'MLS Grid rate limit reached (429). Will resume from the checkpoint next run.'; break; }
    if (!res.ok) { error = `MLS Grid returned ${res.status} during the agent-ID backfill: ${(await res.text().catch(() => '')).slice(0, 200)}`; break; }
    const json = await res.json();
    const p = await saveListingPage(db, cfg, json, now, useTypeFilter);
    saved += p.upserts;
    checkpoint = maxTs(checkpoint, p.pageMax);
    await saveSyncState(db, { backfill_high_water: checkpoint });
    const next = json['@odata.nextLink'];
    if (!next) {
      await saveSyncState(db, { listing_fields_version: LISTING_FIELDS_VERSION, backfill_done_at: now, backfill_high_water: null });
      done = true;
      break;
    }
    url = next;
  }
  return { needed: true, pages, saved, done, through: checkpoint, error };
}
