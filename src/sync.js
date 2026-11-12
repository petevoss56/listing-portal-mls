// MLS Grid replication. MLS Grid does not answer live searches, so we keep our own copy:
//  - first run(s): full import of viewable records (MlgCanView eq true), resumable across runs
//  - afterwards: only records changed since the newest ModificationTimestamp we have
//  - records flagged MlgCanView = false are deleted locally, as MLS Grid requires
// Only listings inside SERVICE_AREA are stored.
import { config, normCounty, QC_CITIES } from './config.js';
import { ensureSchema, getSyncState, saveSyncState, mapRecord, upsertRows, deleteKeys, SELECT_FIELDS } from './db.js';

export function inServiceArea(rec, area) {
  const st = String(rec.StateOrProvince || '').toUpperCase();
  if (!area[st]) return false;
  if (rec.CountyOrParish) return area[st].has(normCounty(rec.CountyOrParish));
  return (QC_CITIES[st] || []).includes(String(rec.City || '').toLowerCase().trim());
}

export function buildUrl(cfg, { mode, highWater, useSelect }) {
  const f = [`OriginatingSystemName eq '${cfg.source}'`];
  if (cfg.propertyTypes.length) f.push('(' + cfg.propertyTypes.map((t) => `PropertyType eq '${t}'`).join(' or ') + ')');
  if (mode === 'incremental' && highWater) f.push(`ModificationTimestamp gt ${highWater}`);
  else f.push('MlgCanView eq true');
  const params = [`$filter=${encodeURIComponent(f.join(' and '))}`, `$top=${cfg.pageSize}`];
  if (useSelect) params.push(`$select=${SELECT_FIELDS.join(',')}`);
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
  if (!cfg.token) {
    await saveSyncState(db, { last_run_at: new Date().toISOString(), last_error: 'MLSGRID_TOKEN is not set' });
    return { ok: false, error: 'MLSGRID_TOKEN is not set' };
  }

  let st = await getSyncState(db);
  let mode = st.high_water ? 'incremental' : 'initial';
  let useSelect = st.use_select !== 0;
  let url = st.next_link || buildUrl(cfg, { mode, highWater: st.high_water, useSelect });
  let runMax = st.run_max || null;
  let pages = 0, upserts = 0, deletes = 0, error = null, finished = false;
  const now = new Date().toISOString();

  while (pages < maxPages && Date.now() - started < cfg.timeBudgetMs) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.token}`, 'Accept-Encoding': 'gzip' } });
    } catch (e) { error = 'Network error: ' + e.message; break; }
    pages++;
    if (res.status === 400 && useSelect && !st.next_link) {
      // Field list not accepted: fall back to full records and remember that.
      useSelect = false;
      await saveSyncState(db, { use_select: 0 });
      url = buildUrl(cfg, { mode, highWater: st.high_water, useSelect });
      continue;
    }
    if (res.status === 429) { error = 'MLS Grid rate limit reached (429). Will resume next run.'; break; }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      error = `MLS Grid returned ${res.status}: ${body}`;
      if (st.next_link) await saveSyncState(db, { next_link: null }); // stale page link: restart from the last checkpoint
      break;
    }
    const json = await res.json();
    const records = json.value || [];
    const keep = [], drop = [];
    for (const r of records) {
      runMax = maxTs(runMax, r.ModificationTimestamp);
      if (r.MlgCanView === false) drop.push(String(r.ListingKey));
      else if (inServiceArea(r, cfg.serviceArea)) keep.push(mapRecord(r, now));
    }
    if (keep.length) await upsertRows(db, keep);
    if (drop.length) await deleteKeys(db, drop);
    upserts += keep.length; deletes += drop.length;

    const next = json['@odata.nextLink'] || null;
    if (next) {
      await saveSyncState(db, { next_link: next, run_max: runMax, mode });
      st = Object.assign(st, { next_link: next });
      url = next;
      await sleep(cfg.requestGapMs);
    } else {
      const hw = maxTs(st.high_water, runMax);
      const patch = { next_link: null, run_max: null, high_water: hw, mode: 'incremental' };
      if (mode === 'initial') patch.initial_completed_at = now;
      await saveSyncState(db, patch);
      finished = true;
      break;
    }
  }
  await saveSyncState(db, { last_run_at: now, last_run_pages: pages, last_run_upserts: upserts, last_run_deletes: deletes, last_error: error });
  return { ok: !error, mode, pages, upserts, deletes, finished, error };
}
