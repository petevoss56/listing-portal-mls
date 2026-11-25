// The tools Claude (and the Listing Portal) can call.
import { runCma, candidates, compSqft } from './cma.js';
import { geocode } from './geo.js';
import { listingByMls, searchByAddress, stats, getSyncState, recentUsage, stripPrefix, agentByKey, searchAgents, agentActivity, searchByStatus, OFF_MARKET_STATUSES, LISTING_FIELDS_VERSION } from './db.js';
import { VERSION, config } from './config.js';

// Every response carries attribution (AI Use Addendum 3(d)) and the permitted-use reminder.
export const ATTRIBUTION = 'Listing data from MRED (Midwest Real Estate Data), provided via MLS GRID. Each listing is courtesy of the listing office shown. Licensed to 3% Listing Co. for internal brokerage and CMA use; share only the facts needed to support a client\'s estimate of value, with that client only. Do not save this data to memory or reuse it outside this request.';

const subjectProps = {
  address: { type: 'string', description: 'Street address of the subject, e.g. "709 40th Ave"' },
  city: { type: 'string' },
  state: { type: 'string', enum: ['IA', 'IL'], description: 'Comps never cross state lines.' },
  zip: { type: 'string' },
  mls_number: { type: 'string', description: "Subject's MLS number, if it has been listed before. Facts are filled from the MLS record." },
  sqft_above_grade: { type: 'number', description: 'Above-grade finished square feet' },
  beds: { type: 'integer' },
  baths_full: { type: 'integer' },
  baths_half: { type: 'integer' },
  garage_spaces: { type: 'number' },
  basement_finished_sqft: { type: 'number' },
  year_built: { type: 'integer' },
  lat: { type: 'number' },
  lon: { type: 'number' },
};

export const TOOLS = [
  {
    name: 'run_cma',
    title: 'Run a CMA (3% Listing Co. Step 1 rules)',
    description: 'Picks 5–8 sold comps and 3–4 active competitors near a subject property from the MRED MLS feed, applies the 3% Listing Co. Step 1 adjustment rules, and returns a value, a $10k range, a recommended list price, a confidence score with concerns, and the top 3 competing listings. Comps never cross the Iowa/Illinois line. Give an address (or MLS number) plus any facts you know; missing facts are filled from the MLS record when the subject has been listed before.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, subjectProps, {
        condition_grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Subject condition grade. Default C (average) until a walkthrough.' },
        comp_grades: { type: 'object', additionalProperties: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'] }, description: 'Condition grades for specific comps, keyed by MLS number. Comps default to the subject grade.' },
        exclude_mls: { type: 'array', items: { type: 'string' }, description: 'MLS numbers to leave out' },
        include_mls: { type: 'array', items: { type: 'string' }, description: 'Sold MLS numbers to force in' },
        months: { type: 'integer', description: 'Sold look-back in months (default 6; widens to 12 if too few sales)' },
        max_radius_miles: { type: 'number', description: 'Largest search radius (default 5)' },
        property_kind: { type: 'string', enum: ['detached', 'attached', 'any'], description: 'Default detached' },
      }),
    },
  },
  {
    name: 'find_sold_comps',
    title: 'Find sold comparables',
    description: 'Lists closed sales near a subject (same state only) with facts, distance, $/sf and Step 1 adjustments, best matches first.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, subjectProps, {
        radius_miles: { type: 'number', description: 'Default 1' },
        months: { type: 'integer', description: 'Default 6' },
        limit: { type: 'integer', description: 'Default 15' },
        property_kind: { type: 'string', enum: ['detached', 'attached', 'any'] },
      }),
    },
  },
  {
    name: 'find_active_listings',
    title: 'Find active competition',
    description: 'Lists active, coming-soon or pending listings near a subject (same state only), best matches first.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, subjectProps, {
        statuses: { type: 'array', items: { type: 'string', enum: ['Active', 'Coming Soon', 'Pending', 'Active Under Contract'] }, description: 'Default Active and Coming Soon' },
        radius_miles: { type: 'number', description: 'Default 1' },
        limit: { type: 'integer', description: 'Default 15' },
        property_kind: { type: 'string', enum: ['detached', 'attached', 'any'] },
      }),
    },
  },
  {
    name: 'get_listing',
    title: 'Look up a listing by MLS number',
    description: 'Returns the stored MLS record for one MLS number, including remarks.',
    inputSchema: { type: 'object', properties: { mls_number: { type: 'string' } }, required: ['mls_number'] },
  },
  {
    name: 'search_listings_by_address',
    title: 'Search listings by address',
    description: 'Finds MLS records (any status, including past sales) whose address matches, e.g. "709 40th Ave".',
    inputSchema: { type: 'object', properties: { address: { type: 'string' }, limit: { type: 'integer' } }, required: ['address'] },
  },
  {
    name: 'find_agent',
    title: 'Look up an agent',
    description: 'Finds MLS agents by name, MLS ID or office and returns their contact info (email, phones), office, and their activity in the Quad Cities listings over the last 12 months (listings taken, closed sales on each side, current listings). For in-house use only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full or partial name, e.g. "Jane Smith" or "Smith"' },
        mls_id: { type: 'string', description: "Agent's MLS ID" },
        office: { type: 'string', description: 'Full or partial office name' },
        limit: { type: 'integer', description: 'Default 10' },
      },
    },
  },
  {
    name: 'find_listings_by_status',
    title: 'Find listings by status (expired, canceled, stale)',
    description: 'Prospecting search: listings in given cities or ZIP codes by status, e.g. expired or canceled in the last 90 days, or active listings sitting 90+ days. ' +
      'Filters by price, date the listing reached its status, days on market and price reductions. Expired/canceled/withdrawn listings whose address has since been relisted or sold are left out unless include_relisted is true. ' +
      'Results come in pages (limit + offset). In-house prospecting use only.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string', enum: ['Expired', 'Canceled', 'Withdrawn', 'Hold', 'Active', 'Coming Soon', 'Pending', 'Active Under Contract', 'Closed'] }, description: 'Statuses to include, e.g. ["Expired","Canceled"]' },
        cities: { type: 'array', items: { type: 'string' }, description: 'City names, e.g. ["Davenport","Bettendorf","LeClaire"]. Spacing and case are ignored (Le Claire = LeClaire).' },
        zips: { type: 'array', items: { type: 'string' }, description: 'ZIP codes (used together with cities: a listing matching either is included)' },
        state: { type: 'string', enum: ['IA', 'IL'] },
        min_price: { type: 'number', description: 'Lowest list price (last list price for expired/canceled)' },
        max_price: { type: 'number' },
        days_back: { type: 'integer', description: 'Only listings that reached their status in the last N days. Default 90 for expired/canceled/withdrawn/hold/closed; no limit for active statuses.' },
        status_since: { type: 'string', description: 'Alternative to days_back: earliest status date, YYYY-MM-DD' },
        status_until: { type: 'string', description: 'Latest status date, YYYY-MM-DD' },
        min_dom: { type: 'integer', description: 'Minimum cumulative days on market, e.g. 90 for stale actives' },
        price_reduced_only: { type: 'boolean', description: 'Only listings whose list price is below the original list price' },
        include_relisted: { type: 'boolean', description: 'Keep expired/canceled listings whose address has since been relisted or sold (default false)' },
        property_kind: { type: 'string', enum: ['detached', 'attached', 'any'], description: 'Default any' },
        sort: { type: 'string', enum: ['newest_status', 'dom', 'price'], description: 'Default newest_status (dom for active-only searches)' },
        limit: { type: 'integer', description: 'Results per page (default and max 25)' },
        offset: { type: 'integer', description: 'Skip this many results (for the next page, use next_offset)' },
      },
      required: ['statuses'],
    },
  },
  {
    name: 'sync_status',
    title: 'MLS data status',
    description: 'How current the MLS copy is: last sync, record counts by state and status, and recent usage.',
    inputSchema: { type: 'object', properties: {} },
  },
].map((t) => Object.assign(t, { annotations: { readOnlyHint: true, openWorldHint: false } }));

/** Build the subject from arguments, an MLS record and, as a last resort, the Census geocoder. */
export async function resolveSubject(db, a, fetchImpl, prefix) {
  let base = null, source = 'as entered';
  if (a.mls_number) a = Object.assign({}, a, { mls_number: stripPrefix(a.mls_number, prefix) });
  if (a.mls_number) { base = await listingByMls(db, a.mls_number); if (base) source = `MLS #${base.mls_number}`; }
  if (!base && a.address) {
    const hits = await searchByAddress(db, a.address, 5);
    base = hits.find((h) => !a.city || (h.city || '').toLowerCase() === String(a.city).toLowerCase()) || null;
    if (base) source = `MLS #${base.mls_number} (${base.status}${base.close_date ? ', closed ' + base.close_date : ''})`;
  }
  const b = base || {};
  const assumed = [];
  const val = (x, y, label, dflt) => {
    if (x !== undefined && x !== null && x !== '') return Number(x);
    if (y !== undefined && y !== null) return Number(y);
    if (dflt !== undefined) { assumed.push(label); return dflt; }
    return null;
  };
  const subj = {
    address: a.address || b.address || null, city: a.city || b.city || null, zip: a.zip || b.zip || null,
    state: (a.state || b.state || '').toUpperCase() || null, mls_number: a.mls_number || b.mls_number || null,
    sqft: val(a.sqft_above_grade, base ? compSqft(b).sqft : null, 'square footage'),
    beds: val(a.beds, b.beds, 'bedrooms (3)', 3),
    full: val(a.baths_full, b.baths_full, 'full baths (1)', 1),
    half: val(a.baths_half, b.baths_half, 'half baths (0)', 0),
    garage: val(a.garage_spaces, b.garage_spaces, 'garage (0)', 0),
    bsmt: val(a.basement_finished_sqft, b.below_grade_finished_sqft, 'finished basement (0 sf)', 0),
    year: val(a.year_built, b.year_built, 'year built', null),
    grade: (a.condition_grade || 'C').toUpperCase(),
    lat: a.lat != null ? Number(a.lat) : b.lat, lon: a.lon != null ? Number(a.lon) : b.lon,
    source, assumed,
  };
  if (!a.condition_grade) assumed.push('condition grade (C)');
  if (subj.year == null) assumed.splice(assumed.indexOf('year built'), 1);
  if ((subj.lat == null || subj.lon == null || !subj.state) && subj.address) {
    const g = await geocode([subj.address, subj.city, subj.state, subj.zip].filter(Boolean).join(', '), fetchImpl);
    if (g) { subj.lat = subj.lat ?? g.lat; subj.lon = subj.lon ?? g.lon; subj.state = subj.state || g.state; subj.zip = subj.zip || g.zip; subj.city = subj.city || g.city; }
  }
  const problems = [];
  if (!subj.sqft) problems.push('above-grade square footage (sqft_above_grade)');
  if (subj.lat == null || subj.lon == null) problems.push('a location: the address could not be found; add city/state/zip or lat/lon');
  if (!['IA', 'IL'].includes(subj.state)) problems.push('state (IA or IL)');
  return { subj, problems };
}

const brief = (x) => ({
  mls_number: x.mls_number, status: x.status, address: x.address, city: x.city, state: x.state, zip: x.zip,
  list_price: x.list_price, original_list_price: x.original_list_price, close_price: x.close_price, close_date: x.close_date,
  list_date: x.list_date, dom: x.dom, beds: x.beds, baths_full: x.baths_full, baths_half: x.baths_half,
  above_grade_sqft: x.above_grade_sqft, living_area: x.living_area, basement_finished_sqft: x.below_grade_finished_sqft,
  basement: x.basement, garage: x.garage_spaces, year_built: x.year_built, style: x.style, subtype: x.property_subtype, lot_acres: x.lot_acres,
  listing_office: x.list_office,
});

const INTEREST = /lat|lon|coord|geo|sq|area|footage|garage|park|bath|bed|basement|year|style|story|stories|condition|lot/i;
function inventorySummary(raw) {
  if (!raw) return null;
  try {
    const inv = JSON.parse(raw);
    const names = Object.keys(inv.fields);
    return {
      checked_at: inv.at, sample_records: inv.samples, total_fields: names.length,
      relevant_fields: names.filter((n) => INTEREST.test(n)).sort().map((n) => `${n} (${inv.fields[n]}/${inv.samples} filled)`),
    };
  } catch (e) { return null; }
}
async function coordStats(db, s) {
  const r = await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) AS with_coords,
    SUM(CASE WHEN geo_status = 'no_match' OR geo_status = 'tie' THEN 1 ELSE 0 END) AS not_found
    FROM listings WHERE status IN ('Active','Coming Soon','Pending','Active Under Contract') OR (status = 'Closed' AND close_date >= ?)`)
    .bind(new Date(Date.now() - 24 * 30.44 * 864e5).toISOString().slice(0, 10)).first();
  let last = null; try { last = s.geo_last_run ? JSON.parse(s.geo_last_run) : null; } catch (e) { /* ignore */ }
  return { comp_ready_listings: r.total || 0, with_coordinates: r.with_coords || 0, address_not_found: r.not_found || 0, last_geocode_run: last };
}

/** Short description of a call for the usage log. */
export function usageSummary(name, a) {
  a = a || {};
  if (name === 'find_listings_by_status') {
    return [(a.statuses || []).join('/'), [...(a.cities || []), ...(a.zips || [])].join(', '), a.min_price ? `>= $${a.min_price}` : '', a.min_dom ? `${a.min_dom}+ DOM` : '', a.offset ? `offset ${a.offset}` : ''].filter(Boolean).join(' | ');
  }
  return a.address || a.mls_number || a.name || a.mls_id || a.office || '';
}

export async function callTool(env, name, a, fetchImpl) {
  const out = await callToolInner(env, name, a || {}, fetchImpl);
  return out && typeof out === 'object' && !out.error ? Object.assign({ source: ATTRIBUTION }, out) : out;
}

async function callToolInner(env, name, a, fetchImpl) {
  const db = env.DB;
  const cfg = config(env);
  if (name === 'run_cma' || name === 'find_sold_comps' || name === 'find_active_listings') {
    const { subj, problems } = await resolveSubject(db, a, fetchImpl, cfg.keyPrefix);
    if (problems.length) return { error: 'Need more about the subject: ' + problems.join('; ') + '.', subject_so_far: subj };
    if (name === 'run_cma') {
      return runCma(db, subj, {
        overrides: a.comp_grades, exclude: (a.exclude_mls || []).map((m) => stripPrefix(m, cfg.keyPrefix)), include: (a.include_mls || []).map((m) => stripPrefix(m, cfg.keyPrefix)), months: a.months,
        maxRadius: a.max_radius_miles, kind: a.property_kind,
      });
    }
    const sold = name === 'find_sold_comps';
    const list = await candidates(db, subj, {
      statuses: sold ? ['Closed'] : a.statuses && a.statuses.length ? a.statuses : ['Active', 'Coming Soon'],
      radius: a.radius_miles || 1, months: sold ? a.months || 6 : null, kind: a.property_kind || 'detached',
    });
    return {
      subject: { address: subj.address, state: subj.state, sqft: subj.sqft, facts_source: subj.source, assumed: subj.assumed },
      count: list.length,
      results: list.slice(0, Math.min(a.limit || 15, cfg.maxResults)).map((x) => Object.assign(brief(x.row), {
        distance_mi: Math.round(x.d * 100) / 100, price_per_sqft: x.a.ppsf ? Math.round(x.a.ppsf) : null,
        adjustment_total: Math.round(x.a.total), indicated_value: x.a.indicated ? Math.round(x.a.indicated / 500) * 500 : null, flags: x.flags,
      })),
    };
  }
  if (name === 'get_listing') {
    const r = await listingByMls(db, stripPrefix(a.mls_number, cfg.keyPrefix));
    if (!r) return { error: `No listing with MLS #${a.mls_number} in the Quad Cities copy.` };
    const agent = async (key, mlsId, nameOnListing, officeName) => {
      if (!key && !nameOnListing) return undefined;
      const m = await agentByKey(db, key);
      return {
        name: (m && m.full_name) || nameOnListing, mls_id: (m && m.mls_id) || mlsId,
        email: m ? m.email : null, phone: m ? m.mobile_phone || m.direct_phone || m.preferred_phone || m.office_phone : null,
        office: (m && m.office_name) || officeName || null, office_phone: m ? m.office_main_phone : null,
      };
    };
    return Object.assign(brief(r), {
      listing_agent: await agent(r.list_agent_key, r.list_agent_mls_id, r.list_agent_name, r.list_office),
      co_listing_agent: await agent(r.co_list_agent_key, r.co_list_agent_mls_id, r.co_list_agent_name),
      buyer_agent: await agent(r.buyer_agent_key, r.buyer_agent_mls_id, r.buyer_agent_name, r.buyer_office_name),
      co_buyer_agent: await agent(r.co_buyer_agent_key, r.co_buyer_agent_mls_id, r.co_buyer_agent_name),
      remarks: r.remarks, county: r.county, modified: r.modified,
    });
  }
  if (name === 'find_agent') {
    if (!a.name && !a.mls_id && !a.office) return { error: 'Give a name, MLS ID or office to search for.' };
    const rows = await searchAgents(db, { mlsId: a.mls_id ? stripPrefix(a.mls_id, cfg.keyPrefix) : null, name: a.name, office: a.office, limit: Math.min(a.limit || 10, cfg.maxResults) });
    if (!rows.length) {
      const n = (await db.prepare('SELECT COUNT(*) AS n FROM agents').first()).n;
      return { count: 0, results: [], note: n ? 'No matching agent.' : 'The agent roster has not been downloaded yet; check sync_status.' };
    }
    const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const results = [];
    for (const r of rows) {
      const act = (await agentActivity(db, r.member_key, since)) || {};
      results.push({
        name: r.full_name, mls_id: r.mls_id, email: r.email,
        phones: { mobile: r.mobile_phone, direct: r.direct_phone, preferred: r.preferred_phone, office: r.office_phone },
        license: r.license, status: r.status, type: r.member_type,
        office: {
          name: r.office_full_name || r.office_name, mls_id: r.office_mls_id, phone: r.office_main_phone,
          address: [r.office_address, r.office_city, r.office_state, r.office_zip].filter(Boolean).join(', ') || null,
        },
        last_12_months: { listings_taken: act.listings_taken || 0, closed_list_side: act.closed_list_side || 0, closed_buyer_side: act.closed_buyer_side || 0, current_listings: act.current_listings || 0 },
      });
    }
    return { count: results.length, results, activity_note: 'Activity counts cover the stored service-area listings only (Scott County IA, Rock Island and Henry Counties IL).' };
  }
  if (name === 'search_listings_by_address') {
    const rows = await searchByAddress(db, a.address, Math.min(a.limit || 10, cfg.maxResults));
    return { count: rows.length, results: rows.map(brief) };
  }
  if (name === 'find_listings_by_status') {
    const statuses = [...new Set((a.statuses || []).map(String))];
    if (!statuses.length) return { error: 'Give at least one status, e.g. ["Expired","Canceled"].' };
    const cities = (a.cities || []).filter(Boolean), zips = (a.zips || []).filter(Boolean);
    if (!cities.length && !zips.length) return { error: 'Give at least one city or ZIP code to search.' };
    const offMarket = statuses.some((x) => OFF_MARKET_STATUSES.includes(x) || x === 'Closed');
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    if (a.status_since && !isDate(a.status_since)) return { error: 'status_since must be YYYY-MM-DD.' };
    if (a.status_until && !isDate(a.status_until)) return { error: 'status_until must be YYYY-MM-DD.' };
    const daysBack = a.days_back != null ? Number(a.days_back) : offMarket ? 90 : null;
    const since = a.status_since || (daysBack ? new Date(Date.now() - daysBack * 864e5).toISOString().slice(0, 10) : null);
    const limit = Math.max(1, Math.min(Number(a.limit) || cfg.maxResults, cfg.maxResults));
    const offset = Math.max(0, Number(a.offset) || 0);
    // No bulk copying (AI Use Addendum 3(e)): paging stops at STATUS_SEARCH_MAX_TOTAL results per search.
    if (offset >= cfg.statusSearchMaxTotal) return { error: `This search can page through at most ${cfg.statusSearchMaxTotal} results. Narrow it (fewer cities, a higher min_price or a shorter date range).` };
    const pageSize = Math.min(limit, cfg.statusSearchMaxTotal - offset);
    const { total, rows } = await searchByStatus(db, {
      statuses, cities, zips, state: a.state ? String(a.state).toUpperCase() : null,
      minPrice: a.min_price != null ? Number(a.min_price) : null, maxPrice: a.max_price != null ? Number(a.max_price) : null,
      since, until: a.status_until || null, minDom: a.min_dom != null ? Number(a.min_dom) : null,
      reducedOnly: !!a.price_reduced_only, kind: a.property_kind || 'any', excludeRelisted: !a.include_relisted,
      sort: a.sort || (offMarket ? 'newest_status' : 'dom'), limit: pageSize, offset,
    });
    const reachable = Math.min(total, cfg.statusSearchMaxTotal);
    const st = await getSyncState(db);
    const notes = [];
    if (statuses.includes('Canceled') || statuses.includes('Withdrawn') || statuses.includes('Hold')) notes.push('Canceled, withdrawn or held listings may still be under a listing agreement with the listing brokerage; confirm the agreement has ended before contacting the owner.');
    if ((st.listing_fields_version || 1) < 3) notes.push('Status dates are still being filled in from MLS Grid; until then the last-modified date stands in for the status date.');
    if (total > reachable) notes.push(`${total} listings match, but only the first ${reachable} can be paged through. Narrow the search to see the rest.`);
    return {
      search: { statuses, cities, zips, min_price: a.min_price ?? null, max_price: a.max_price ?? null, status_since: since, status_until: a.status_until || null, min_dom: a.min_dom ?? null, relisted_excluded: !a.include_relisted },
      total_matches: total, offset, count: rows.length,
      next_offset: offset + rows.length < reachable ? offset + rows.length : null,
      results: rows.map((x) => Object.assign(brief(x), {
        status_date: x.status_date,
        price_change: x.original_list_price && x.list_price ? Math.round(x.list_price - x.original_list_price) : null,
        listing_agent: x.list_agent_name || null,
      })),
      notes,
    };
  }
  if (name === 'sync_status') {
    const s = await getSyncState(db);
    return {
      version: VERSION,
      last_sync: s.last_run_at, last_sync_error: s.last_error, mode: s.mode, initial_import_completed: s.initial_completed_at,
      data_current_through: s.high_water, fields_not_provided_by_mls: s.dropped_fields ? s.dropped_fields.split(',') : [], last_run: { pages: s.last_run_pages, saved: s.last_run_upserts, removed: s.last_run_deletes },
      records: await stats(db),
      agent_roster: {
        members_error: s.member_error || null, offices_error: s.office_error || null,
        members_initial_import_done: s.member_mode === 'incremental', offices_initial_import_done: s.office_mode === 'incremental',
        listing_agent_ids: (s.listing_fields_version || 1) >= 2 ? 'complete' : s.mode === 'incremental' ? `backfilling (through ${s.backfill_high_water || 'start'})` : 'after first import',
        status_dates: (s.listing_fields_version || 1) >= LISTING_FIELDS_VERSION ? 'complete' : s.mode === 'incremental' ? `backfilling (through ${s.backfill_high_water || 'start'})` : 'after first import',
      },
      map_coordinates: await coordStats(db, s), mls_fields: inventorySummary(s.field_inventory),
      recent_usage: await recentUsage(db, 10),
    };
  }
  return { error: `Unknown tool: ${name}` };
}
