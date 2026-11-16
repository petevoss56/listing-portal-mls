import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishedBasement, mapRecord } from '../src/db.js';

test('finished basement: reported value wins, otherwise estimated from MRED size and description', () => {
  assert.deepEqual(finishedBasement({ BelowGradeFinishedArea: 400, MRD_BSMNT_SQFT: 900, Basement: ['Finished'] }), { sqft: 400, estimated: 0 });
  assert.deepEqual(finishedBasement({ MRD_BSMNT_SQFT: 900, Basement: ['Full', 'Finished'] }), { sqft: 900, estimated: 1 });
  assert.deepEqual(finishedBasement({ MRD_BSMNT_SQFT: 900, Basement: ['Partially Finished'] }), { sqft: 450, estimated: 1 });
  assert.deepEqual(finishedBasement({ MRD_BSMNT_SQFT: 900, Basement: ['Unfinished'] }), { sqft: 0, estimated: 1 });
  assert.deepEqual(finishedBasement({ MRD_BSMNT_SQFT: 0, Basement: ['None'] }), { sqft: null, estimated: 0 });
  assert.deepEqual(finishedBasement({ Basement: ['Slab'] }), { sqft: null, estimated: 0 });
});

test('MRED living area stands in for above-grade square footage when enabled', () => {
  const r = { ListingKey: 'MRDK1', ListingId: 'MRD1', LivingArea: 1110, StateOrProvince: 'IL' };
  assert.equal(mapRecord(r, 'now', 'MRD', { livingIsAboveGrade: true }).above_grade_sqft, 1110);
  assert.equal(mapRecord(r, 'now', 'MRD', { livingIsAboveGrade: false }).above_grade_sqft, null);
  assert.equal(mapRecord(Object.assign({ AboveGradeFinishedArea: 1000 }, r), 'now', 'MRD', { livingIsAboveGrade: true }).above_grade_sqft, 1000);
});
