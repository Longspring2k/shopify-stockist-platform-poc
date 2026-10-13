import { createStockistService } from '../src/stockist-service.mjs';

const records = [
  { id: 'harbor-books', tenant: 'demo-shop', name: 'Harbor Books', address: '12 Beacon Street', latitude: 42.36, longitude: -71.06, active: true, privateNotes: 'Synthetic demonstration record' },
  { id: 'garden-market', tenant: 'other-shop', name: 'Garden Market', address: '8 Willow Avenue', latitude: 39.95, longitude: -75.16, active: true, privateNotes: '' }
];
const trusted = (subject, tenant, role) => Object.freeze({ subject, tenant, role, trusted: true });
const admin = trusted('demo-admin', 'demo-shop', 'admin');
const otherAdmin = trusted('other-admin', 'other-shop', 'admin');
let clock = 1_000;
const service = createStockistService({ records, now: () => clock, confirmationTtlMs: 500 });

console.log('Public projection:', service.publicList('demo-shop'));
const updated = service.update(admin, 'harbor-books', 1, { name: 'Harbor Books & Paper' });
console.log('Updated staff record:', { id: updated.id, name: updated.name, version: updated.version });
const staleToken = service.prepareDeactivation(admin, 'harbor-books', 2);
service.update(admin, 'harbor-books', 2, { address: '14 Beacon Street' });
try { service.confirmDeactivation(admin, staleToken); } catch (error) { console.log('Caught stale confirmation:', error.code); }
const token = service.prepareDeactivation(admin, 'harbor-books', 3);
try { service.confirmDeactivation(otherAdmin, token); } catch (error) { console.log('Caught cross-tenant denial:', error.code); }
const inactive = service.confirmDeactivation(admin, token);
console.log('Deactivated:', { id: inactive.id, active: inactive.active, version: inactive.version });
console.log('Public after deactivation:', service.publicList('demo-shop'));
try { service.confirmDeactivation(admin, token); } catch (error) { console.log('Caught token replay:', error.code); }
console.log('Minimal audit:', service.auditLog());
