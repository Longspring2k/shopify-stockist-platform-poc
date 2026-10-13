import { randomBytes } from 'node:crypto';

const ROLES = new Set(['viewer', 'editor', 'admin']);
const RECORD_FIELDS = new Set(['id', 'tenant', 'name', 'address', 'latitude', 'longitude', 'active', 'privateNotes', 'version']);
const PATCH_FIELDS = new Set(['name', 'address', 'latitude', 'longitude', 'privateNotes']);
const PRINCIPAL_FIELDS = new Set(['subject', 'tenant', 'role', 'trusted']);
const MAX_TEXT = 200;
const MAX_NOTES = 1000;

export class StockistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StockistError';
    this.code = code;
  }
}

function fail(code, message) { throw new StockistError(code, message); }
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail('INVALID_INPUT', `${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('INVALID_INPUT', `${label} has unsupported field: ${key}`);
  }
}
function boundedString(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) {
    fail('INVALID_INPUT', `${label} must be a trimmed string between 1 and ${max} characters`);
  }
  return value;
}
function notesString(value) {
  if (typeof value !== 'string' || value.length > MAX_NOTES) fail('INVALID_INPUT', 'privateNotes must be a string of at most 1000 characters');
  return value;
}
function coordinate(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) fail('INVALID_INPUT', `${label} must be finite and between ${min} and ${max}`);
  return value;
}
function safeVersion(value, label = 'version') {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT', `${label} must be a positive safe integer`);
  return value;
}
function clone(value) { return structuredClone(value); }
function tupleKey(tenant, id) { return `${tenant.length}:${tenant}|${id.length}:${id}`; }

function validateRecord(input) {
  assertExactKeys(input, RECORD_FIELDS, 'record');
  const record = {
    id: boundedString(input.id, 'id'),
    tenant: boundedString(input.tenant, 'tenant'),
    name: boundedString(input.name, 'name'),
    address: boundedString(input.address, 'address'),
    latitude: coordinate(input.latitude, 'latitude', -90, 90),
    longitude: coordinate(input.longitude, 'longitude', -180, 180),
    active: input.active,
    privateNotes: notesString(input.privateNotes === undefined ? '' : input.privateNotes),
    version: input.version === undefined ? 1 : safeVersion(input.version)
  };
  if (typeof record.active !== 'boolean') fail('INVALID_INPUT', 'active must be boolean');
  return record;
}

function validatePrincipal(input) {
  assertExactKeys(input, PRINCIPAL_FIELDS, 'principal');
  if (input.trusted !== true) fail('UNTRUSTED_PRINCIPAL', 'caller must be a trusted principal from a transport/auth adapter');
  const result = {
    subject: boundedString(input.subject, 'principal.subject'),
    tenant: boundedString(input.tenant, 'principal.tenant'),
    role: input.role,
    trusted: true
  };
  if (!ROLES.has(result.role)) fail('INVALID_PRINCIPAL', 'principal role is invalid');
  return result;
}
function requireRole(principal, roles) {
  if (!roles.includes(principal.role)) fail('FORBIDDEN', 'caller does not have permission for this operation');
}
function publicProjection(record) {
  return { id: record.id, name: record.name, address: record.address, latitude: record.latitude, longitude: record.longitude };
}

export function createStockistService({ records, now = Date.now, confirmationTtlMs = 30_000 } = {}) {
  if (!Array.isArray(records)) fail('INVALID_INPUT', 'records must be an array');
  if (typeof now !== 'function') fail('INVALID_INPUT', 'now must be a function');
  if (!Number.isSafeInteger(confirmationTtlMs) || confirmationTtlMs < 1 || confirmationTtlMs > 300_000) fail('INVALID_INPUT', 'confirmationTtlMs must be an integer from 1 to 300000');
  const initialNow = now();
  if (!Number.isSafeInteger(initialNow) || initialNow < 0) fail('INVALID_CLOCK', 'clock must return a nonnegative safe integer');
  let lastObservedTime = initialNow;

  const store = new Map();
  for (const input of records) {
    const record = validateRecord(input);
    const key = tupleKey(record.tenant, record.id);
    if (store.has(key)) fail('DUPLICATE_RECORD', 'duplicate tenant and record id tuple');
    store.set(key, record);
  }
  const confirmations = new Map();
  const audit = [];

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK', 'clock must return a nonnegative safe integer');
    if (value < lastObservedTime) fail('INVALID_CLOCK', 'clock moved backwards');
    lastObservedTime = value;
    return value;
  }
  function getTenantRecord(tenant, id) {
    const record = store.get(tupleKey(tenant, boundedString(id, 'id')));
    if (!record) fail('NOT_FOUND', 'stockist not found');
    return record;
  }
  function staffContext(input, roles) {
    const principal = validatePrincipal(input);
    requireRole(principal, roles);
    return principal;
  }
  function checkVersion(record, expectedVersion) {
    safeVersion(expectedVersion, 'expectedVersion');
    if (record.version !== expectedVersion) fail('VERSION_CONFLICT', 'record version does not match expected version');
  }
  function appendAudit(principal, action, record, changedFields) {
    audit.push({ actor: principal.subject, tenant: principal.tenant, action, recordId: record.id, version: record.version, changedFields: [...changedFields].sort() });
  }

  return Object.freeze({
    publicList(tenant) {
      const tenantId = boundedString(tenant, 'tenant');
      return [...store.values()].filter((record) => record.tenant === tenantId && record.active).map(publicProjection);
    },

    staffGet(inputPrincipal, id) {
      const principal = staffContext(inputPrincipal, ['viewer', 'editor', 'admin']);
      return clone(getTenantRecord(principal.tenant, id));
    },

    update(inputPrincipal, id, expectedVersion, patch) {
      const principal = staffContext(inputPrincipal, ['editor', 'admin']);
      const record = getTenantRecord(principal.tenant, id);
      checkVersion(record, expectedVersion);
      assertExactKeys(patch, PATCH_FIELDS, 'patch');
      const keys = Object.keys(patch);
      if (keys.length === 0) fail('INVALID_INPUT', 'patch must contain at least one supported field');
      const next = { ...record };
      for (const key of keys) {
        if (key === 'name' || key === 'address') next[key] = boundedString(patch[key], key);
        else if (key === 'privateNotes') next[key] = notesString(patch[key]);
        else if (key === 'latitude') next[key] = coordinate(patch[key], key, -90, 90);
        else next[key] = coordinate(patch[key], key, -180, 180);
      }
      next.version = safeVersion(record.version + 1);
      store.set(tupleKey(record.tenant, record.id), next);
      appendAudit(principal, 'update', next, keys);
      return clone(next);
    },

    prepareDeactivation(inputPrincipal, id, expectedVersion) {
      const principal = staffContext(inputPrincipal, ['admin']);
      const record = getTenantRecord(principal.tenant, id);
      checkVersion(record, expectedVersion);
      if (!record.active) fail('INVALID_STATE', 'stockist is already inactive');
      const expiresAt = currentTime() + confirmationTtlMs;
      if (!Number.isSafeInteger(expiresAt)) fail('INVALID_CLOCK', 'clock plus TTL exceeds safe integer range');
      const token = randomBytes(32).toString('base64url');
      confirmations.set(token, Object.freeze({
        tenant: principal.tenant,
        subject: principal.subject,
        action: 'deactivate',
        recordId: record.id,
        version: record.version,
        expiresAt
      }));
      return token;
    },

    confirmDeactivation(inputPrincipal, token) {
      const principal = staffContext(inputPrincipal, ['admin']);
      if (typeof token !== 'string' || token.length === 0) fail('INVALID_CONFIRMATION', 'confirmation token is unknown or invalid');
      const intent = confirmations.get(token);
      if (!intent || intent.action !== 'deactivate' || intent.subject !== principal.subject || intent.tenant !== principal.tenant) {
        fail('INVALID_CONFIRMATION', 'confirmation token is unknown or not bound to this caller');
      }
      if (currentTime() >= intent.expiresAt) fail('EXPIRED_CONFIRMATION', 'confirmation token has expired');
      const record = getTenantRecord(principal.tenant, intent.recordId);
      checkVersion(record, intent.version);
      if (!record.active) fail('INVALID_STATE', 'stockist is already inactive');
      const next = { ...record, active: false, version: safeVersion(record.version + 1) };
      store.set(tupleKey(record.tenant, record.id), next);
      confirmations.delete(token);
      appendAudit(principal, 'deactivate', next, ['active']);
      return clone(next);
    },

    snapshot() { return clone([...store.values()]); },
    auditLog() { return clone(audit); }
  });
}
