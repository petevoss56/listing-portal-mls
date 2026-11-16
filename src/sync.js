// MLS Grid replication, following the MLS Grid "Best Practices for Obtaining Data" guide:
//  - Initial import: OriginatingSystemName eq 'mred' and MlgCanView eq true, following @odata.nextLink.
//  - Never start over after an error: resume with "ModificationTimestamp gt <greatest received so far>".
//  - Afterwards, every 15 minutes: "ModificationTimestamp gt <greatest in our database>" (no MlgCanView filter),
//    so records MLS Grid marks MlgCanView = false arrive and are deleted locally.
//  - One request at a time, at most 2 per second, gzip, no parentheses except around "in"/"or".
// Only listings inside SERVICE_AREA are stored.
import { config, normCounty, QC_CITIES } from './config.js';
import { ensureSchema, getSyncState, saveSyncState, mapRecord, upsertRows, deleteKeys, SELECT_FIELDS } from './db.js';

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
      if (m && SELECT_FIELDS.includes(m[1]) && !CORE_FIELDS.includes(m[1]) && !dropped.has(m[1]) && dropped.size < 25) {
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
    const keep = [], drop = [];
    let pageMax = null;
    for (const r of json.value || []) {
      pageMax = maxTs(pageMax, r.ModificationTimestamp);
      if (r.MlgCanView === false) drop.push(String(r.ListingKey));
      else if (inServiceArea(r, cfg.serviceArea) && (!cfg.propertyTypes.length || useTypeFilter || cfg.propertyTypes.includes(r.PropertyType))) keep.push(mapRecord(r, now, cfg.keyPrefix, { livingIsAboveGrade: cfg.livingIsAboveGrade }));
    }
    if (keep.length) await upsertRows(db, keep);
    if (drop.length) await deleteKeys(db, drop);
    upserts += keep.length; deletes += drop.length;
    checkpoint = maxTs(checkpoint, pageMax);
    await saveSyncState(db, { high_water: checkpoint });

    const next = json['@odata.nextLink'];
    if (!next) {
      if (mode === 'initial') await saveSyncState(db, { mode: 'incremental', initial_completed_at: now });
      finished = true;
      break;
    }
    url = next;
    await sleep(cfg.requestGapMs);
  }
  await saveSyncState(db, { last_run_at: now, last_run_pages: pages, last_run_upserts: upserts, last_run_deletes: deletes, last_error: error, lock_until: null });
  return { ok: !error, mode, pages, upserts, deletes, finished, error };
}
