// The tools Claude (and the Listing Portal) can call.
import { runCma, candidates, compSqft } from './cma.js';
import { geocode } from './geo.js';
import { listingByMls, searchByAddress, stats, getSyncState, recentUsage } from './db.js';
import { VERSION } from './config.js';

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
    name: 'sync_status',
    title: 'MLS data status',
    description: 'How current the MLS copy is: last sync, record counts by state and status, and recent usage.',
    inputSchema: { type: 'object', properties: {} },
  },
].map((t) => Object.assign(t, { annotations: { readOnlyHint: true, openWorldHint: false } }));

/** Build the subject from arguments, an MLS record and, as a last resort, the Census geocoder. */
export async function resolveSubject(db, a, fetchImpl) {
  let base = null, source = 'as entered';
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
});

export async function callTool(env, name, a, fetchImpl) {
  const db = env.DB;
  a = a || {};
  if (name === 'run_cma' || name === 'find_sold_comps' || name === 'find_active_listings') {
    const { subj, problems } = await resolveSubject(db, a, fetchImpl);
    if (problems.length) return { error: 'Need more about the subject: ' + problems.join('; ') + '.', subject_so_far: subj };
    if (name === 'run_cma') {
      return runCma(db, subj, {
        overrides: a.comp_grades, exclude: a.exclude_mls, include: a.include_mls, months: a.months,
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
      results: list.slice(0, a.limit || 15).map((x) => Object.assign(brief(x.row), {
        distance_mi: Math.round(x.d * 100) / 100, price_per_sqft: x.a.ppsf ? Math.round(x.a.ppsf) : null,
        adjustment_total: Math.round(x.a.total), indicated_value: x.a.indicated ? Math.round(x.a.indicated / 500) * 500 : null, flags: x.flags,
      })),
    };
  }
  if (name === 'get_listing') {
    const r = await listingByMls(db, a.mls_number);
    return r ? Object.assign(brief(r), { remarks: r.remarks, county: r.county, modified: r.modified }) : { error: `No listing with MLS #${a.mls_number} in the Quad Cities copy.` };
  }
  if (name === 'search_listings_by_address') {
    const rows = await searchByAddress(db, a.address, a.limit || 10);
    return { count: rows.length, results: rows.map(brief) };
  }
  if (name === 'sync_status') {
    const s = await getSyncState(db);
    return {
      version: VERSION,
      last_sync: s.last_run_at, last_sync_error: s.last_error, mode: s.mode, initial_import_completed: s.initial_completed_at,
      data_current_through: s.high_water, last_run: { pages: s.last_run_pages, saved: s.last_run_upserts, removed: s.last_run_deletes },
      records: await stats(db), recent_usage: await recentUsage(db, 10),
    };
  }
  return { error: `Unknown tool: ${name}` };
}
