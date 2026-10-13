import test from 'node:test';
import assert from 'node:assert/strict';
import { createStockistService } from '../src/stockist-service.mjs';

const seed = [
  { id: 'north-shop', tenant: 'tenant-a', name: 'North Shop', address: '10 Pine Street', latitude: 40.7, longitude: -74, active: true, privateNotes: 'rear delivery' },
  { id: 'south-shop', tenant: 'tenant-a', name: 'South Shop', address: '20 Lake Road', latitude: 41, longitude: -73.8, active: false, privateNotes: '' },
  { id: 'west-shop', tenant: 'tenant-b', name: 'West Shop', address: '30 Cedar Way', latitude: 34, longitude: -118.2, active: true, privateNotes: 'call first' }
];
const principal = (subject, tenant, role) => Object.freeze({ subject, tenant, role, trusted: true });
const adminA = principal('admin-a', 'tenant-a', 'admin');
const editorA = principal('editor-a', 'tenant-a', 'editor');
const viewerA = principal('viewer-a', 'tenant-a', 'viewer');
const adminB = principal('admin-b', 'tenant-b', 'admin');
function fixture(ttlMs = 1000) {
  let now = 10_000;
  const service = createStockistService({ records: seed, now: () => now, confirmationTtlMs: ttlMs });
  return { service, advance: (ms) => { now += ms; } };
}
function state(service) { return { records: service.snapshot(), audit: service.auditLog() }; }

// First vertical slice: public projection, tenant scoping, active-only filtering.
test('publicList returns only active tenant records through a minimal projection', () => {
  const { service } = fixture();
  assert.deepEqual(service.publicList('tenant-a'), [{
    id: 'north-shop', name: 'North Shop', address: '10 Pine Street', latitude: 40.7, longitude: -74
  }]);
  assert.equal('tenant' in service.publicList('tenant-a')[0], false);
  assert.equal('version' in service.publicList('tenant-a')[0], false);
  assert.equal('privateNotes' in service.publicList('tenant-a')[0], false);
});

test('staff reads require a trusted principal and stay inside its tenant', () => {
  const { service } = fixture();
  assert.equal(service.staffGet(viewerA, 'north-shop').privateNotes, 'rear delivery');
  assert.throws(() => service.staffGet({ subject: 'x', tenant: 'tenant-a', role: 'admin' }, 'north-shop'), /trusted principal/);
  assert.throws(() => service.staffGet(adminB, 'north-shop'), /not found/);
});

test('updates require editor role, exact version, valid fields and immutable identity', () => {
  const { service } = fixture();
  assert.throws(() => service.update(viewerA, 'north-shop', 1, { name: 'No' }), /permission/);
  const changed = service.update(editorA, 'north-shop', 1, { name: 'North Market', latitude: 40.8 });
  assert.equal(changed.version, 2);
  assert.equal(changed.name, 'North Market');
  assert.throws(() => service.update(editorA, 'north-shop', 1, { name: 'Stale' }), /version/);
  assert.throws(() => service.update(editorA, 'north-shop', 2, { tenant: 'tenant-b' }), /unsupported field/);
  assert.throws(() => service.update(editorA, 'north-shop', 2, { longitude: 181 }), /longitude/);
  const pollutedPatch = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => service.update(editorA, 'north-shop', 2, pollutedPatch), /plain object|unsupported/);
});

test('input mutation and returned-copy mutation cannot alter service state', () => {
  const mutable = { subject: 'editor-a', tenant: 'tenant-a', role: 'editor', trusted: true };
  const { service } = fixture();
  const patch = { name: 'Stable Name' };
  const result = service.update(mutable, 'north-shop', 1, patch);
  mutable.tenant = 'tenant-b'; patch.name = 'Mutated'; result.name = 'Mutated result';
  assert.equal(service.staffGet(editorA, 'north-shop').name, 'Stable Name');
  const snapshot = service.snapshot(); snapshot[0].name = 'Snapshot mutation';
  const audit = service.auditLog(); audit[0].changedFields.push('privateNotes');
  assert.equal(service.staffGet(editorA, 'north-shop').name, 'Stable Name');
  assert.deepEqual(service.auditLog()[0].changedFields, ['name']);
});

test('confirmation is action-bound, actor-bound, tenant-bound, short-lived and single-use', () => {
  const { service } = fixture();
  const token = service.prepareDeactivation(adminA, 'north-shop', 1);
  assert.throws(() => service.confirmDeactivation(principal('other-admin', 'tenant-a', 'admin'), token), /confirmation/);
  assert.throws(() => service.confirmDeactivation(adminB, token), /confirmation/);
  assert.equal(service.confirmDeactivation(adminA, token).active, false);
  assert.throws(() => service.confirmDeactivation(adminA, token), /confirmation/);
});

test('unauthorized confirmation does not consume a valid token', () => {
  const { service } = fixture();
  const token = service.prepareDeactivation(adminA, 'north-shop', 1);
  assert.throws(() => service.confirmDeactivation(editorA, token), /permission/);
  assert.equal(service.confirmDeactivation(adminA, token).active, false);
});

test('permission is rechecked when confirmation is applied', () => {
  const { service } = fixture();
  const mutableAdmin = { subject: 'admin-a', tenant: 'tenant-a', role: 'admin', trusted: true };
  const token = service.prepareDeactivation(mutableAdmin, 'north-shop', 1);
  mutableAdmin.role = 'viewer';
  assert.throws(() => service.confirmDeactivation(mutableAdmin, token), /permission/);
  assert.equal(service.confirmDeactivation(adminA, token).active, false);
});

test('exact expiry is invalid and failure preserves records and audit', () => {
  const { service, advance } = fixture(1000);
  const token = service.prepareDeactivation(adminA, 'north-shop', 1);
  const before = state(service);
  advance(1000);
  assert.throws(() => service.confirmDeactivation(adminA, token), /expired/);
  assert.deepEqual(state(service), before);
});

test('an intervening edit makes a confirmation stale without mutation', () => {
  const { service } = fixture();
  const token = service.prepareDeactivation(adminA, 'north-shop', 1);
  service.update(editorA, 'north-shop', 1, { address: '11 Pine Street' });
  const before = state(service);
  assert.throws(() => service.confirmDeactivation(adminA, token), /version/);
  assert.deepEqual(state(service), before);
});

test('unknown tokens and refused operations never change records or audit', () => {
  const { service } = fixture();
  const before = state(service);
  assert.throws(() => service.confirmDeactivation(adminA, 'not-a-token'), /confirmation/);
  assert.throws(() => service.prepareDeactivation(editorA, 'north-shop', 1), /permission/);
  assert.throws(() => service.update(editorA, 'north-shop', 1, { active: false }), /unsupported field/);
  assert.deepEqual(state(service), before);
});

test('constructor rejects malformed records, tuple collisions and prototype keys', () => {
  assert.throws(() => createStockistService({ records: [seed[0], { ...seed[0] }] }), /duplicate/);
  assert.throws(() => createStockistService({ records: [{ ...seed[0], latitude: NaN }] }), /latitude/);
  assert.throws(() => createStockistService({ records: [{ ...seed[0], version: 0 }] }), /version/);
  const record = JSON.parse('{"id":"safe","tenant":"tenant-a","name":"Safe","address":"A","latitude":1,"longitude":2,"active":true,"privateNotes":"","__proto__":{"polluted":true}}');
  assert.throws(() => createStockistService({ records: [record] }), /unsupported field/);
});

test('TTL is bounded and explicit null notes are not normalized into valid data', () => {
  assert.throws(() => createStockistService({ records: seed, confirmationTtlMs: 300_001 }), /TTL|ttl|confirmationTtlMs/);
  assert.throws(() => createStockistService({ records: [{ ...seed[0], privateNotes: null }] }), /privateNotes/);
});

test('clock rollback cannot revive a confirmation that was already observed expired', () => {
  const { service, advance } = fixture(1000);
  const token = service.prepareDeactivation(adminA, 'north-shop', 1);
  const before = state(service);
  advance(1000);
  assert.throws(() => service.confirmDeactivation(adminA, token), /expired/);
  advance(-500);
  assert.throws(() => service.confirmDeactivation(adminA, token), /clock/);
  assert.deepEqual(state(service), before);
});

test('audit attribution distinguishes identical record and actor IDs in different tenants', () => {
  const service = createStockistService({ records: [seed[0], { ...seed[0], tenant: 'tenant-b' }] });
  for (const tenant of ['tenant-a', 'tenant-b']) {
    service.update(principal('same-actor', tenant, 'editor'), 'north-shop', 1, { name: 'Updated' });
  }
  assert.deepEqual(service.auditLog().map((event) => event.tenant), ['tenant-a', 'tenant-b']);
});

test('audit is minimal and successful confirmation removes public visibility', () => {
  const { service } = fixture();
  service.update(editorA, 'north-shop', 1, { privateNotes: 'updated', name: 'North Market' });
  const token = service.prepareDeactivation(adminA, 'north-shop', 2);
  service.confirmDeactivation(adminA, token);
  assert.deepEqual(service.publicList('tenant-a'), []);
  assert.deepEqual(service.auditLog(), [
    { actor: 'editor-a', tenant: 'tenant-a', action: 'update', recordId: 'north-shop', version: 2, changedFields: ['name', 'privateNotes'] },
    { actor: 'admin-a', tenant: 'tenant-a', action: 'deactivate', recordId: 'north-shop', version: 3, changedFields: ['active'] }
  ]);
});
