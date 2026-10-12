# Engineering decisions

Shopify Stockist Platform POC

## One service, separate trust boundaries

Share business validation below the transport layer while authenticating storefront, staff and automation requests independently.

## Bound destructive intent

Tie deactivation confirmation to the intended operation and prevent token reuse.

## Recoverable records

Use deactivation rather than hard deletion so visibility can change without discarding history.

## Defer the map

Keep searchable results useful without requiring immediate map initialization.

## Reading the architecture

Storefront / Admin / MCP → Transport-specific authorization → Shared validation and version checks → D1 records and audit → Locator results

The diagram reduces the implementation to its relevant responsibilities. It does not expose private endpoints, exact deployment layout, resource identifiers or operational configuration.
