# Scope and evidence boundaries

## Public executable boundary

This repository now includes newly written, synthetic Node.js code that demonstrates one narrow backend service boundary. Its records, people-like subjects, tenants and addresses are invented for the demo. It contains no client source, location dataset, merchant identity, domain, credential, platform key, deployment binding or private configuration.

The executable is a dependency-free in-memory model. It does not connect to Shopify, Cloudflare, D1, an MCP host, a map provider or any network service. There is no browser interface or server because the review target is authorization and state behavior.

## Relationship to the private proof of concept

A separate private staging proof of concept informed the choice of engineering problem. This public demo was authored independently and is not a source release, port or sanitized copy of that implementation. No production launch, app-marketplace approval or current deployment is claimed.

## Demonstrated here

- Tenant-scoped record authority and exact input contracts.
- Trusted-principal and role checks at a service boundary.
- Versioned updates and stale-write refusal.
- Bound, expiring, single-use soft-deactivation confirmation.
- Public active-only projections and minimal audit entries.
- Deterministic behavioral tests, including failure-state invariants.

## Explicitly not implemented or claimed

- Authentication, OAuth, session validation or Shopify signature verification.
- Shopify app proxy, Admin API, theme extension or uninstall handlers.
- MCP protocol, tool registration or automation transport authentication.
- SQL/D1 schemas, transactions, durable storage, distributed locks or compare-and-swap execution.
- Map UI, geocoding, search ranking, stockist creation, reactivation or hard deletion.
- Production security review, penetration testing, operational monitoring or compliance suitability.

The documentation maps the service contract to possible adapters only to make the boundary reviewable. It does not imply those adapters exist in this repository.
