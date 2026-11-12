// 3% Listing Co. Step 1 valuation rules, applied to real MLS comps.
// Rules (from the Listing Portal build brief):
//  - typical Quad Cities $/sf 165–185; condition grades A–F
//  - condition step by size tier: <1,000 $5k; 1,000–1,500 $10k; 1,500–2,500 $15k; 2,500–4,000 $20k; >4,000 $25k
//  - half bath $5k; full bath $10k; garage $10k per car; finished basement ~$70/sf (65–75)
//  - 2BR subjects compare to 1–2BR; 3BR+ subjects compare to 3–5BR; bedroom value absorbed by sq ft
//  - age: <=5 yrs old -> comps <=10 yrs old; aim within 15 yrs; age matters little past 30; never new vs 30+
//  - never cross state lines; expand radius before loosening other criteria
//  - 3–4 active and 5–8 sold comps; output a $10k range + recommended list price; confidence + concerns; top 3 competitors
import { miles, boxAround } from './geo.js';
import { listingsInBox } from './db.js';

export const RULES = {
  ppsfTypical: [165, 185],
  tiers: [[999, 5000], [1500, 10000], [2500, 15000], [4000, 20000], [Infinity, 25000]],
  halfBath: 5000, fullBath: 10000, garageCar: 10000, basementPsf: 70,
  sold: [5, 8], active: [3, 4],
};
const GRADES = 'ABCDEF';
const SOLD = ['Closed'];
const ACTIVE = ['Active', 'Coming Soon'];
const PENDING = ['Pending', 'Active Under Contract'];

export const gradeStep = (sf) => RULES.tiers.find((t) => sf <= t[0])[1];
const round = (n, to) => Math.round(n / to) * to;
const monthsAgo = (d) => (d ? (Date.now() - Date.parse(d)) / (30.44 * 864e5) : 0);
const isoMonthsBack = (m) => new Date(Date.now() - m * 30.44 * 864e5).toISOString().slice(0, 10);

/** Square footage used for a listing: above-grade if reported, otherwise total living area (flagged). */
export function compSqft(c) {
  if (c.above_grade_sqft > 0) return { sqft: c.above_grade_sqft, source: 'above grade' };
  if (c.living_area > 0) return { sqft: c.living_area, source: 'living area (above grade not reported)' };
  return { sqft: null, source: 'missing' };
}

export function ruleFlags(subj, c) {
  const f = [];
  if (c.state && subj.state && c.state !== subj.state) f.push('Crosses state line');
  const yr = new Date().getFullYear();
  if (subj.beds != null && c.beds != null) {
    if (subj.beds <= 2 ? c.beds > 2 : c.beds < 3 || c.beds > 5) f.push('Bedroom count outside range');
  }
  if (subj.year && c.year_built) {
    const aS = yr - subj.year, aC = yr - c.year_built;
    if (aS <= 5 && aC > 10) f.push('Subject is new; comp is older');
    else if ((aS <= 5 && aC >= 30) || (aC <= 5 && aS >= 30)) f.push('New vs. 30+ years');
    else if (!(aS >= 30 && aC >= 30) && Math.abs(aS - aC) > 15) f.push('Age gap over 15 years');
  }
  return f;
}

/** Adjust one comp to the subject. price = close price (sold) or list price (active). */
export function adjust(subj, c, price, compGrade) {
  const { sqft, source } = compSqft(c);
  const step = gradeStep(subj.sqft);
  const g = compGrade || subj.grade;
  const cond = (GRADES.indexOf(g) - GRADES.indexOf(subj.grade)) * step;
  const full = (subj.full - (c.baths_full || 0)) * RULES.fullBath;
  const half = (subj.half - (c.baths_half || 0)) * RULES.halfBath;
  const garage = (subj.garage - Math.round(c.garage_spaces || 0)) * RULES.garageCar;
  const bsmt = (subj.bsmt - (c.below_grade_finished_sqft || 0)) * RULES.basementPsf;
  const total = cond + full + half + garage + bsmt;
  const indicated = sqft ? ((price + total) / sqft) * subj.sqft : null;
  const gross = Math.abs(cond) + Math.abs(full) + Math.abs(half) + Math.abs(garage) + Math.abs(bsmt) + (sqft ? Math.abs(subj.sqft - sqft) * 60 : 0);
  return { grade: g, cond, full, half, garage, bsmt, total, indicated, ppsf: sqft ? price / sqft : null, grossPct: gross / price, sqft, sqftSource: source };
}

function kindOk(c, kind) {
  if (c.property_type && !/residential/i.test(c.property_type)) return false;
  if (!kind || kind === 'any') return true;
  const attached = /condo|town|attached|duplex|co-?op/i.test(c.property_subtype || '');
  return kind === 'attached' ? attached : !attached;
}

function describe(c, d, a, price) {
  return {
    mls_number: c.mls_number, address: c.address, city: c.city, state: c.state, status: c.status,
    price, close_date: c.close_date, list_price: c.list_price, original_list_price: c.original_list_price, dom: c.dom,
    distance_mi: Math.round(d * 100) / 100,
    sqft: a.sqft, sqft_source: a.sqftSource, beds: c.beds, baths_full: c.baths_full, baths_half: c.baths_half,
    garage: c.garage_spaces, basement_finished_sqft: c.below_grade_finished_sqft, year_built: c.year_built,
    style: c.style, price_per_sqft: a.ppsf ? Math.round(a.ppsf) : null,
    grade_used: a.grade,
    adjustments: { condition: a.cond, full_bath: a.full, half_bath: a.half, garage: a.garage, basement: Math.round(a.bsmt), total: Math.round(a.total) },
    indicated_value: a.indicated ? round(a.indicated, 500) : null,
  };
}

/** Candidate comps around the subject, scored by similarity. */
export async function candidates(db, subj, opts) {
  const { statuses, radius, months, kind, overrides, exclude } = opts;
  const rows = await listingsInBox(db, { state: subj.state, statuses, box: boxAround(subj.lat, subj.lon, radius), closedSince: months ? isoMonthsBack(months) : null });
  const out = [];
  for (const c of rows) {
    if (c.lat == null || c.lon == null) continue;
    if (subj.mls_number && c.mls_number === subj.mls_number) continue;
    if (exclude && exclude.has(String(c.mls_number))) continue;
    if (subj.address && c.address && norm(c.address) === norm(subj.address)) continue;
    if (!kindOk(c, kind)) continue;
    const d = miles(subj.lat, subj.lon, c.lat, c.lon);
    if (d > radius) continue;
    const price = SOLD.includes(c.status) ? c.close_price : c.list_price;
    if (!price) continue;
    const a = adjust(subj, c, price, overrides && overrides[c.mls_number]);
    if (!a.sqft) continue;
    if (Math.abs(a.sqft - subj.sqft) / subj.sqft > 0.3) continue;
    const flags = ruleFlags(subj, c);
    const score = a.grossPct * 100 + d * 6 + monthsAgo(c.close_date) * 1.5 + flags.length * 15;
    const weight = (SOLD.includes(c.status) ? 1 : 0.5) / (1 + a.grossPct * 8 + d * 0.4 + flags.length * 0.75 + monthsAgo(c.close_date) * 0.05);
    out.push({ row: c, d, a, price, flags, score, weight });
  }
  return out.sort((x, y) => x.score - y.score);
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const RADII = [0.5, 1, 1.5, 2, 3, 5];

/** Full CMA: select comps (expanding radius first), adjust, value, range, confidence, competitors. */
export async function runCma(db, subj, opts) {
  opts = opts || {};
  const overrides = opts.overrides || {};
  const exclude = new Set((opts.exclude || []).map(String));
  const include = new Set((opts.include || []).map(String));
  const kind = opts.kind || 'detached';
  const maxR = opts.maxRadius || 5;
  const radii = RADII.filter((r) => r <= maxR);
  const baseMonths = opts.months || 6;

  // Sold comps: widen the radius first, then the time window.
  let sold = [], soldRadius = null, soldMonths = baseMonths;
  for (const m of [baseMonths, Math.max(baseMonths, 12)]) {
    for (const r of radii) {
      sold = (await candidates(db, subj, { statuses: SOLD, radius: r, months: m, kind, overrides, exclude })).filter((x) => !x.flags.includes('Crosses state line'));
      soldRadius = r; soldMonths = m;
      if (sold.length >= RULES.sold[0]) break;
    }
    if (sold.length >= RULES.sold[0]) break;
  }
  const forced = include.size ? (await candidates(db, subj, { statuses: SOLD, radius: maxR, months: 24, kind: 'any', overrides, exclude })).filter((x) => include.has(String(x.row.mls_number))) : [];
  const soldPick = dedupe([...forced, ...sold]).slice(0, Math.max(RULES.sold[1], forced.length));

  let actives = [], activeRadius = null;
  for (const r of radii) {
    actives = await candidates(db, subj, { statuses: ACTIVE, radius: r, months: null, kind, overrides, exclude });
    activeRadius = r;
    if (actives.length >= RULES.active[0]) break;
  }
  const activePick = actives.slice(0, RULES.active[1]);
  const pending = (await candidates(db, subj, { statuses: PENDING, radius: activeRadius || 1, months: null, kind, overrides, exclude })).slice(0, 3);

  // Value from sold comps, weighted toward the best matches.
  const usable = soldPick.filter((x) => x.a.indicated);
  const wSum = usable.reduce((s, x) => s + x.weight, 0);
  const value = wSum ? usable.reduce((s, x) => s + x.a.indicated * x.weight, 0) / wSum : null;
  const point = value ? round(value, 2500) : null;
  const low = point ? Math.floor((point - 5000) / 5000) * 5000 : null;
  const range = point ? [low, low + 10000] : null;
  const recommended = point ? point - 100 : null;

  // Lean, from active competition.
  let lean = 'middle of the range';
  if (point && activePick.length) {
    const ind = activePick.map((x) => x.a.indicated).filter(Boolean).sort((a, b) => a - b);
    const med = ind[Math.floor(ind.length / 2)];
    const slow = activePick.filter((x) => (x.row.dom || 0) > 60).length;
    if (actives.length >= 6 || slow >= 2) lean = 'lower half of the range (plenty of competition or slow-moving actives)';
    else if (med && med > point * 1.03 && actives.length <= 3) lean = 'upper half of the range (limited, higher-priced competition)';
  }

  // Confidence score and concerns.
  let conf = 95; const concerns = [];
  if (usable.length < RULES.sold[0]) { conf -= 6 * (RULES.sold[0] - usable.length); concerns.push(`Only ${usable.length} usable sold comps (target 5–8).`); }
  if (soldRadius > 1) { conf -= soldRadius > 2 ? 15 : 8; concerns.push(`Search radius expanded to ${soldRadius} mi to find enough sales.`); }
  if (soldMonths > baseMonths) { conf -= 8; concerns.push(`Had to look back ${soldMonths} months for sales.`); }
  const avgGross = usable.length ? usable.reduce((s, x) => s + x.a.grossPct, 0) / usable.length : 0;
  if (avgGross > 0.1) { conf -= Math.min(20, Math.round(avgGross * 60)); concerns.push(`Comps need sizable adjustments (average ${Math.round(avgGross * 100)}% of price).`); }
  if (usable.some((x) => x.a.sqftSource !== 'above grade')) { conf -= 5; concerns.push('Some comps report only total living area, not above-grade sq ft. Verify in the MLS.'); }
  if (usable.length >= 3 && value) {
    const vals = usable.map((x) => x.a.indicated);
    const spread = (Math.max(...vals) - Math.min(...vals)) / value;
    if (spread > 0.25) { conf -= 6; concerns.push(`Indicated values spread widely (${Math.round(spread * 100)}% of value).`); }
  }
  if (subj.assumed.length) { conf -= 5; concerns.push('Subject facts assumed: ' + subj.assumed.join(', ') + '. Confirm at the walkthrough.'); }
  if (!Object.keys(overrides).length) concerns.push('MLS does not record condition. Comps are graded the same as the subject until you set grades after reviewing photos.');
  if (activePick.length < RULES.active[0]) concerns.push(`Only ${activePick.length} active competitors found within ${activeRadius} mi.`);
  conf = Math.max(35, Math.min(95, conf));

  const ppsf = recommended ? recommended / subj.sqft : null;
  if (ppsf && (ppsf < RULES.ppsfTypical[0] || ppsf > RULES.ppsfTypical[1]))
    concerns.push(`Recommended price is $${Math.round(ppsf)}/sf, outside the typical $${RULES.ppsfTypical[0]}–$${RULES.ppsfTypical[1]}. That can be normal for condition or location extremes.`);

  const competitors = recommended
    ? [...activePick].sort((a, b) => Math.abs(a.price - recommended) / 1000 + a.a.grossPct * 100 - (Math.abs(b.price - recommended) / 1000 + b.a.grossPct * 100)).slice(0, 3)
    : activePick.slice(0, 3);

  const share = (x) => (wSum ? Math.round((x.weight / wSum) * 100) : 0);
  return {
    subject: {
      address: subj.address, city: subj.city, state: subj.state, mls_number: subj.mls_number || null,
      sqft_above_grade: subj.sqft, beds: subj.beds, baths_full: subj.full, baths_half: subj.half, garage: subj.garage,
      basement_finished_sqft: subj.bsmt, year_built: subj.year, condition_grade: subj.grade,
      condition_step: gradeStep(subj.sqft), facts_source: subj.source, assumed: subj.assumed,
    },
    valuation: value ? {
      model_value: round(value, 500), range_low: range[0], range_high: range[1], recommended_list_price: recommended,
      lean, recommended_price_per_sqft: Math.round(ppsf), confidence: conf,
    } : null,
    concerns,
    search: { sold_radius_mi: soldRadius, sold_months: soldMonths, active_radius_mi: activeRadius, property_kind: kind, same_state_only: subj.state },
    sold_comps: soldPick.map((x) => Object.assign(describe(x.row, x.d, x.a, x.price), { weight_pct: x.a.indicated ? share(x) : 0, flags: x.flags })),
    active_competition: activePick.map((x) => Object.assign(describe(x.row, x.d, x.a, x.price), { flags: x.flags })),
    pending: pending.map((x) => describe(x.row, x.d, x.a, x.price)),
    top_competitors: competitors.map((x) => ({ mls_number: x.row.mls_number, address: x.row.address, list_price: x.price, dom: x.row.dom, sqft: x.a.sqft })),
    method: 'Indicated value = (price + feature adjustments) ÷ comp sq ft × subject sq ft, weighted toward closer, more similar, more recent sales.',
  };
}
const dedupe = (arr) => { const s = new Set(); return arr.filter((x) => (s.has(x.row.listing_key) ? false : s.add(x.row.listing_key))); };
