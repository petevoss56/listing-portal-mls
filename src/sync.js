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

export function buildUrl(cfg, { mode, checkpoint, useSelect, useTypeFilter }) {
  const f = [`OriginatingSystemName eq '${cfg.source}'`];
  if (useTypeFilter !== false && cfg.propertyTypes.length) {
    f.push(cfg.propertyTypes.length === 1
      ? `PropertyType eq '${cfg.propertyTypes[0]}'`
      : `PropertyType in (${cfg.propertyTypes.map((t) => `'${t}'`).join(',')})`);
  }
  if (mode !== 'incremental') f.push('MlgCanView eq true');
  if (checkpoint) f.push(`ModificationTimestamp gt ${checkpoint}`);
  const params = [`$filter=${encodeURIComponent(f.join(' and '))}`, `$top=${cfg.pageSize}`];
  if (useSelect !== false) params.push(`$select=${SELECT_FIELDS.join(',')}`);
  return `${cfg.base}/Property?${params.join('&')}`;
}

const maxTs = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);

export async function runSync(env, opts) {
  opts = opts || {};
  const cfg = config(env);
  const db = env.DB;
  const fetchImpl = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxPages = opts.maxPages || cfg.maxPages;
  const started = Date.now();
  await ensureSchema(db);
  const now = new Date().toISOString();
  if (!cfg.token) {
    await saveSyncState(db, { last_run_at: now, last_error: 'MLSGRID_TOKEN is not set' });
    return { ok: false, error: 'MLSGRID_TOKEN is not set' };
  }

  const st = await getSyncState(db);
  const mode = st.mode === 'incremental' ? 'incremental' : 'initial';
  let useSelect = st.use_select !== 0;
  let useTypeFilter = st.use_type_filter !== 0;
  let checkpoint = st.high_water || null; // greatest ModificationTimestamp received so far
  const fresh = () => buildUrl(cfg, { mode, checkpoint, useSelect, useTypeFilter });
  let url = fresh();
  let firstPage = true;
  let pages = 0, upserts = 0, deletes = 0, error = null, finished = false;

  while (pages < maxPages && Date.now() - started < cfg.timeBudgetMs) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.token}`, 'Accept-Encoding': 'gzip, deflate' } });
    } catch (e) { error = 'Network error: ' + e.message; break; }
    pages++;
    if (res.status === 400 && firstPage && (useTypeFilter || useSelect)) {
      // Request shape not accepted: drop the property-type filter first, then the field list, and remember.
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
      else if (inServiceArea(r, cfg.serviceArea) && (!cfg.propertyTypes.length || useTypeFilter || cfg.propertyTypes.includes(r.PropertyType))) keep.push(mapRecord(r, now, cfg.keyPrefix));
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
  await saveSyncState(db, { last_run_at: now, last_run_pages: pages, last_run_upserts: upserts, last_run_deletes: deletes, last_error: error });
  return { ok: !error, mode, pages, upserts, deletes, finished, error };
}
