# Pi Quota

Pi Quota describes provider-account usage allowances surfaced inside the pi interface.

## Language

**Provider quota**:
An active provider account's externally imposed usage allowance, expressed through provider-reported remaining capacity and reset windows. It excludes conversation context usage and estimated monetary cost.
_Avoid_: Context usage, token count, session cost

**Quota window**:
A provider-reported allowance period whose remaining percentage can be calculated with verified semantics and whose reset metadata may be available.
_Avoid_: Quota bucket, usage period

**Quota snapshot**:
A point-in-time adapter result describing validated quota windows, or why none are available.
_Avoid_: Quota response, provider payload

**Provider adapter**:
The provider-specific boundary that resolves Pi authentication, fetches provider data, validates it, and returns a quota snapshot.
_Avoid_: Provider client, quota fetcher

**Provider registry**:
The canonical, ordered set of provider integrations pi-quota supports. Every enumeration of providers — the supported check, provider routing, and the details view — derives from it, so a provider is supported exactly when it appears in the registry.
_Avoid_: Supported-providers list, provider list

**Quota state**:
The extension’s current provider-specific freshness state, combining the latest quota snapshot, the last renderable quota snapshot, stale status, and refresh failure metadata.
_Avoid_: Quota cache, cached quota

**Quota host**:
The Pi-side context the quota subsystem reads from at a seam: the active mode, provider, and base URL, the status UI and theme, and provider-auth resolution.
_Avoid_: Pi context, extension host, host context
