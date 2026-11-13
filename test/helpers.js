// Test helpers: a D1-compatible wrapper around Node's built-in SQLite, and fake MLS Grid data.
import { DatabaseSync } from 'node:sqlite';
import { _resetSchemaFlag } from '../src/db.js';

class Stmt {
  constructor(db, sql, params) { this.db = db; this.sql = sql; this.params = params || []; }
  bind(...p) { return new Stmt(this.db, this.sql, p.map((v) => (v === undefined ? null : v))); }
  all() { return Promise.resolve({ results: this.db.prepare(this.sql).all(...this.params) }); }
  first() { return Promise.resolve(this.db.prepare(this.sql).get(...this.params) || null); }
  run() { const r = this.db.prepare(this.sql).run(...this.params); return Promise.resolve({ meta: { changes: r.changes } }); }
  _runSync() { return this.db.prepare(this.sql).run(...this.params); }
}
export class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { this.db.exec('BEGIN'); try { const r = stmts.map((s) => s._runSync()); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
}

export function makeEnv(extra) {
  _resetSchemaFlag();
  return Object.assign({
    DB: new D1(),
    MLSGRID_TOKEN: 'test-token',
    CONNECTOR_KEYS: 'pete:pete-key-0123456789abcdef,chris:chris-key-0123456789abcd',
    SYNC_REQUEST_GAP_MS: '0',
    ALLOW_LARGER_REQUESTS: 'true',
  }, extra || {});
}

const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
let seq = 0;
export function rec(o) {
  seq++;
  return Object.assign({
    ListingKey: 'MRDK' + seq, ListingId: 'MRD' + String(12000000 + seq), ListOfficeName: 'Example Realty ' + (seq % 3), OriginatingSystemName: 'mred', MlgCanView: true,
    ModificationTimestamp: new Date(Date.now() - (100 - seq) * 60000).toISOString(), PropertyType: 'Residential',
    PropertySubType: 'Single Family Residence', StateOrProvince: 'IL', CountyOrParish: 'Rock Island', City: 'East Moline',
    PostalCode: '61244', BedroomsTotal: 3, BathroomsFull: 1, BathroomsHalf: 0, GarageSpaces: 1, YearBuilt: 1958,
    BelowGradeFinishedArea: 0,
  }, o);
}

// East Moline neighborhood around 709 40th Ave (lat 41.5005, lon -90.4329), using the public-data comps found earlier.
export function fixtureRecords() {
  seq = 0;
  const base = [41.5005, -90.4329];
  const at = (dLat, dLon) => ({ Latitude: base[0] + dLat, Longitude: base[1] + dLon });
  return [
    // subject's own past sale
    rec(Object.assign({ StreetNumber: '709', StreetName: '40th', StreetSuffix: 'Ave', StandardStatus: 'Closed', ClosePrice: 116000, CloseDate: daysAgo(1400), ListPrice: 119900, AboveGradeFinishedArea: 1110, YearBuilt: 1961 }, at(0, 0))),
    rec(Object.assign({ StreetNumber: '3916', StreetName: '8th', StreetSuffix: 'St', StandardStatus: 'Closed', ClosePrice: 150000, CloseDate: daysAgo(38), AboveGradeFinishedArea: 1141, BelowGradeFinishedArea: 336, YearBuilt: 1962 }, at(-0.002, -0.002))),
    rec(Object.assign({ StreetNumber: '3906', StreetName: 'Morton', StreetSuffix: 'Dr', StandardStatus: 'Closed', ClosePrice: 128000, CloseDate: daysAgo(72), AboveGradeFinishedArea: 1255, GarageSpaces: 2, YearBuilt: 1955 }, at(-0.006, 0.008))),
    rec(Object.assign({ StreetNumber: '764', StreetName: '41st', StreetSuffix: 'Ave', StandardStatus: 'Closed', ClosePrice: 125000, CloseDate: daysAgo(50), LivingArea: 1320, YearBuilt: 1961 }, at(0.0015, 0.001))),
    rec(Object.assign({ StreetNumber: '307', StreetName: '33rd', StreetSuffix: 'Ave', StandardStatus: 'Closed', ClosePrice: 139900, CloseDate: daysAgo(87), AboveGradeFinishedArea: 1017, YearBuilt: 1955 }, at(-0.01, -0.006))),
    rec(Object.assign({ StreetNumber: '1009', StreetName: '38th', StreetSuffix: 'Ave', StandardStatus: 'Closed', ClosePrice: 124400, CloseDate: daysAgo(100), AboveGradeFinishedArea: 1210, GarageSpaces: 0, YearBuilt: 1952 }, at(-0.003, 0.004))),
    rec(Object.assign({ StreetNumber: '3707', StreetName: '9th', StreetSuffix: 'St', StandardStatus: 'Closed', ClosePrice: 144900, CloseDate: daysAgo(440), AboveGradeFinishedArea: 1074, YearBuilt: 1957 }, at(-0.004, 0.002))),
    rec(Object.assign({ StreetNumber: '1132', StreetName: '37th', StreetSuffix: 'Ave', StandardStatus: 'Closed', ClosePrice: 135000, CloseDate: daysAgo(120), AboveGradeFinishedArea: 1150, YearBuilt: 1960 }, at(-0.005, 0.006))),
    // actives / pending
    rec(Object.assign({ StreetNumber: '740', StreetName: '41st', StreetSuffix: 'Ave', StandardStatus: 'Active', ListPrice: 153000, LivingArea: 1197, YearBuilt: 1959, CumulativeDaysOnMarket: 35 }, at(0.0012, 0.0008))),
    rec(Object.assign({ StreetNumber: '806', StreetName: '22nd', StreetSuffix: 'Ave', StandardStatus: 'Active', ListPrice: 150000, OriginalListPrice: 165000, AboveGradeFinishedArea: 1188, BathroomsHalf: 1, GarageSpaces: 2, YearBuilt: 1955, CumulativeDaysOnMarket: 34 }, at(-0.025, -0.01))),
    rec(Object.assign({ StreetNumber: '220', StreetName: '30th', StreetSuffix: 'Ave', StandardStatus: 'Active', ListPrice: 134999, AboveGradeFinishedArea: 1180, BathroomsHalf: 1, GarageSpaces: 0, YearBuilt: 1930, CumulativeDaysOnMarket: 115 }, at(-0.015, -0.012))),
    rec(Object.assign({ StreetNumber: '947', StreetName: '36th', StreetSuffix: 'Ave', StandardStatus: 'Pending', ListPrice: 150000, AboveGradeFinishedArea: 1050, YearBuilt: 1956 }, at(-0.006, 0.003))),
    // Iowa sale just across the river — must never be used for an Illinois subject
    rec(Object.assign({ StreetNumber: '100', StreetName: 'River', StreetSuffix: 'Dr', StandardStatus: 'Closed', ClosePrice: 140000, CloseDate: daysAgo(20), AboveGradeFinishedArea: 1100, StateOrProvince: 'IA', CountyOrParish: 'Scott', City: 'Bettendorf', PostalCode: '52722' }, at(0.004, -0.004))),
    // condo nearby — excluded from detached comps
    rec(Object.assign({ StreetNumber: '500', StreetName: '42nd', StreetSuffix: 'Ave', UnitNumber: '3', PropertySubType: 'Condominium', StandardStatus: 'Closed', ClosePrice: 99000, CloseDate: daysAgo(30), AboveGradeFinishedArea: 1050 }, at(0.002, 0.001))),
    // nearby sale the MLS allows for IDX only (not Back Office) — must be ignored
    rec(Object.assign({ StreetNumber: '777', StreetName: '39th', StreetSuffix: 'Ave', StandardStatus: 'Closed', ClosePrice: 999000, CloseDate: daysAgo(15), AboveGradeFinishedArea: 1100, MlgCanUse: ['IDX'] }, at(0.0005, 0.0005))),
    // Chicago record — outside the service area, never stored
    rec({ StreetNumber: '1', StreetName: 'Lake Shore', StreetSuffix: 'Dr', StandardStatus: 'Closed', ClosePrice: 900000, CloseDate: daysAgo(10), AboveGradeFinishedArea: 2000, CountyOrParish: 'Cook', City: 'Chicago', PostalCode: '60601', Latitude: 41.88, Longitude: -87.62 }),
  ];
}

/** Fake MLS Grid: serves records in pages and records every URL requested. */
export function fakeMlsGrid(records, pageSize, opts) {
  opts = opts || {};
  const calls = [];
  const fetch = async (url, init) => {
    if (opts.failAfter != null && calls.length >= opts.failAfter) { calls.push({ url }); return new Response('boom', { status: 500 }); }
    calls.push({ url, auth: init && init.headers && init.headers.Authorization });
    if (opts.rejectSelect && url.includes('$select=')) return new Response('bad select', { status: 400 });
    const u = new URL(url);
    const skip = Number(u.searchParams.get('$skip') || 0);
    const filter = decodeURIComponent(u.searchParams.get('$filter') || '');
    let pool = records;
    const gt = filter.match(/ModificationTimestamp gt (\S+)/);
    if (gt) pool = pool.filter((r) => r.ModificationTimestamp > gt[1]);
    if (filter.includes('MlgCanView eq true')) pool = pool.filter((r) => r.MlgCanView !== false);
    if (opts.rejectTypeFilter && filter.includes('PropertyType')) return new Response('bad filter', { status: 400 });
    if (filter.includes("PropertyType eq 'Residential'")) pool = pool.filter((r) => r.PropertyType === 'Residential');
    const page = pool.slice(skip, skip + pageSize);
    const body = { value: page };
    if (skip + pageSize < pool.length) {
      u.searchParams.set('$skip', String(skip + pageSize));
      body['@odata.nextLink'] = u.toString();
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}
