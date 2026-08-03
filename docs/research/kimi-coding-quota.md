# Kimi For Coding quota source and semantics

_Researched 2026-08-03. No model/completion request was made._

## Decision

Use a best-effort, read-only request:

```http
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <resolved Pi kimi-coding credential>
Accept: application/json
```

Quota is in the JSON body, not response headers. This endpoint is implemented by Moonshot's first-party Kimi Code client, but it is not documented as a public API contract; Moonshot forum staff call it a “legacy/experimental API” ([staff response](https://forum.moonshot.ai/t/error-code-429-were-receiving-too-many-requests-at-the-moment/191/7)). Parse defensively, retain the last good sample, and show “quota unavailable” rather than zero on failure.

## Evidence and response shape

Moonshot's current Kimi Code source defines the managed base URL as `https://api.kimi.com/coding/v1`, appends `/usages`, and sends only Bearer authorization plus JSON accept headers ([endpoint and URL construction](https://github.com/MoonshotAI/kimi-code/blob/c27a9f93a653a8d17a4db001d7a29232fd3926ae/packages/oauth/src/managed-usage.ts#L27-L47), [fetch implementation](https://github.com/MoonshotAI/kimi-code/blob/c27a9f93a653a8d17a4db001d7a29232fd3926ae/packages/oauth/src/managed-usage.ts#L273-L322)). Its source records the platform payload as decimal strings with proto-style time units ([shape](https://github.com/MoonshotAI/kimi-code/blob/c27a9f93a653a8d17a4db001d7a29232fd3926ae/packages/oauth/src/managed-usage.ts#L1-L21)) and parses `usage`, nested `limits[].window/detail`, and optional `boosterWallet` ([parser](https://github.com/MoonshotAI/kimi-code/blob/c27a9f93a653a8d17a4db001d7a29232fd3926ae/packages/oauth/src/managed-usage.ts#L67-L247)).

A non-consuming live GET with this machine's Pi-managed Kimi Code API key returned HTTP 200 with this redacted structural shape:

```json
{
  "usage": {
    "limit": "<decimal integer string>",
    "used": "<decimal integer string>",
    "remaining": "<decimal integer string>",
    "resetTime": "<ISO-8601 timestamp>"
  },
  "limits": [
    {
      "window": {
        "duration": 300,
        "timeUnit": "TIME_UNIT_MINUTE"
      },
      "detail": {
        "limit": "<decimal integer string>",
        "used": "<decimal integer string>",
        "remaining": "<decimal integer string>",
        "resetTime": "<ISO-8601 timestamp>"
      }
    }
  ],
  "parallel": { "limit": "<decimal integer string>", "details": ["..."] },
  "totalQuota": {},
  "authentication": { "method": "...", "scope": "..." },
  "subType": "...",
  "domain": "..."
}
```

The sampled weekly and five-hour rows satisfied `remaining = limit - used`; both reset timestamps were valid and in the future within their stated windows. This is an observation, not a documented invariant. The first-party parser deliberately ignores `remaining` and displays `used / limit`, which is a safer fallback if `remaining` is absent or invalid ([parser and row model](https://github.com/MoonshotAI/kimi-code/blob/c27a9f93a653a8d17a4db001d7a29232fd3926ae/packages/oauth/src/managed-usage.ts#L67-L82), [first-party display](https://github.com/MoonshotAI/kimi-code/blob/c27a9f93a653a8d17a4db001d7a29232fd3926ae/apps/kimi-code/src/tui/components/messages/usage-panel.ts#L139-L175)).

The sampled 200 response had no `rate*`, `limit*`, `usage*`, `quota*`, `reset*`, or `retry-after` response headers. Do not depend on quota headers. Kimi does document `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` for the separate pay-as-you-go **Kimi Open Platform** ([rate-limit docs](https://www.kimi.com/help/kimi-api/api-rate-limits)); those headers are not a Kimi Code membership-quota source.

## Window and capacity semantics

### Documented contract

Official Kimi documentation states that:

- Kimi Code shares one membership quota across CLI, VS Code, and third-party tools.
- Its quota refreshes every seven days from the subscription date; unused quota does not roll over.
- A separate rolling five-hour rate window can block requests even while weekly quota remains.
- A Kimi-wide monthly membership limit can freeze Kimi Code even when Kimi Code quota remains.
- The console and `/usage` are the supported user-facing ways to inspect remaining quota and rate-limit status.
- If Extra Usage is enabled, it is deducted after time-limited quota and can keep calls working after weekly, five-hour, or monthly subscription limits are reached.

See [Membership Benefits — Quota and Limits](https://www.kimi.com/code/docs/en/kimi-code/membership.html#quota-and-limits). Moonshot staff describe the plans as token-based but say this endpoint does not expose granular token burn ([staff response](https://forum.moonshot.ai/t/error-code-429-were-receiving-too-many-requests-at-the-moment/191/7)); Kimi also documents that HighSpeed consumes about three times the credits of Standard ([third-party agent guide](https://www.kimi.com/help/kimi-code/third-party-agents)). Treat `used`, `limit`, and `remaining` as normalized quota counters: render ratios/percentages, not requests, raw tokens, or currency credits.

### First-party but undocumented behavior

- Top-level `usage` is treated by the official client as the **weekly** row. The backend omits its window, so the client synthesizes `{duration: 1, unit: "week"}`.
- `limits[].window` describes shorter controls. The currently observed five-hour control arrives as `300 × TIME_UNIT_MINUTE`; the official client normalizes that to five hours.
- Each `resetTime` is passed through as an absolute ISO timestamp and rendered by the official client as “resets in …”. The server-side definition is not published; use it as the provider's display/reset hint, not as a promise about a fixed bucket algorithm.
- `boosterWallet`, when present, describes optional Extra Usage money balance and monthly spending-cap state. It is not the weekly/five-hour quota. Its shape has already evolved in first-party source ([Extra Usage change](https://github.com/MoonshotAI/kimi-code/pull/1501)).
- `parallel`, `totalQuota`, `authentication`, `user`, `subType`, and `domain` are not part of the official client's quota row model. Ignore them unless separately researched. In particular, an empty/missing `totalQuota` must not be interpreted as “monthly quota available.”

## Pi authentication integration

The locally installed `@earendil-works/pi-ai` is version **0.83.0**, npm git head [`845d6ff`](https://github.com/earendil-works/pi/tree/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai). Its `kimi-coding` provider supports both `KIMI_API_KEY`/stored API-key auth and Kimi subscription OAuth ([provider definition](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/providers/kimi-coding.ts)). The OAuth flow authenticates `api.kimi.com/coding` with `Authorization: Bearer <access token>` ([OAuth implementation](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/auth/oauth/kimi-coding.ts#L1-L8), [Bearer conversion](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/auth/oauth/kimi-coding.ts#L240-L248)).

An extension should resolve auth through Pi, never read or log `auth.json`:

```ts
const resolved = await ctx.modelRegistry.getProviderAuth("kimi-coding");
const authorization =
  resolved?.auth.headers?.Authorization ??
  (resolved?.auth.apiKey ? `Bearer ${resolved.auth.apiKey}` : undefined);
```

`getProviderAuth()` is exposed to extensions and refreshes OAuth through Pi's auth runtime; `getApiKeyForProvider()` alone is insufficient because OAuth resolves to headers rather than `auth.apiKey` ([registry API](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/model-registry.ts)). A Kimi Code API key worked as Bearer auth in the live non-consuming check. OAuth is also the mechanism used by Moonshot's own usage fetch. Kimi Open Platform keys (`api.moonshot.cn`) are a different product and must not be used here ([official platform distinction](https://www.kimi.com/help/kimi-code/faq#installation-authentication)).

Policy risk: Kimi's current third-party guide lists only Kimi Code CLI, Claude Code, and Roo Code as supported and warns that API-key use with unauthorized tools may lead to restricted access ([guide](https://www.kimi.com/help/kimi-code/third-party-agents#important-notes)). Pi/this extension is not named. Product owners should obtain Kimi approval before shipping API-key polling broadly; OAuth availability in Pi does not by itself establish authorization.

Note the URL mismatch: Pi's Anthropic-compatible model base is `https://api.kimi.com/coding`, while quota is on the OpenAI-style versioned path `https://api.kimi.com/coding/v1/usages`. Do not append `/usages` directly to the model base URL.

## Errors and degradation

The public error reference documents **model-call** outcomes, not a `/usages` endpoint contract:

- 401: invalid/expired credentials; do not retry without fixing auth.
- 403 with “usage limit for this billing cycle”: weekly quota exhausted.
- 429 can mean engine overload, too many concurrent requests, five-hour quota, or monthly Kimi quota. Status alone cannot distinguish them.
- 5xx is transient infrastructure failure.

See [Kimi Code Error Reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html). The quota endpoint itself returned 401 JSON when called without auth; Moonshot's client preserves status and API error text for any non-2xx response, with local hints for 401 and 404. No retry or error-body schema for `/usages` is publicly specified.

Recommended extension behavior:

1. Timeout after roughly 8–10 seconds; never make a model call to discover quota.
2. On 200, validate object/array shape, non-negative decimal-integer strings, and parseable timestamps. Parse exactly (for example with `BigInt`) before computing `remaining = clamp(validServerRemaining ?? limit - used, 0, limit)`.
3. On 401, report authentication required/expired and let Pi's normal login or refresh path recover it.
4. On 404, malformed 200, or schema drift, disable Kimi quota for the session/version and report unavailable.
5. On 429, 5xx, timeout, or network error, keep a timestamped last-good value and retry later with backoff; never replace it with zero.
6. Treat the rows as plan-quota indicators, not an availability oracle: Extra Usage may permit calls after exhaustion, while monthly quota, concurrency, or overload may block calls despite positive weekly/five-hour remaining values.

## Stability and explicit unknowns

This is reliable enough for an **experimental best-effort adapter**, not a stable contract:

- `/usages` is absent from the public API documentation found; the documented interfaces are the console and CLI `/usage`, and Moonshot staff explicitly call the endpoint legacy/experimental.
- It is nevertheless strong evidence of current first-party behavior: Moonshot's current CLI calls and tests this endpoint directly.
- The first-party integration is recent and changing: managed usage entered the current repository in May 2026; Extra Usage parsing changed in July; and the structured-row refactor explicitly changed client wire DTOs in lockstep ([PR #2300](https://github.com/MoonshotAI/kimi-code/pull/2300)). Pin tests to captured redacted fixtures and tolerate additive fields.

Unknowns that must not be invented:

- the normalization and accounting formula behind the quota counters;
- whether `remaining = limit - used` is guaranteed in all plans;
- the exact rolling-window algorithm and precise meaning of `resetTime` during partial recovery;
- `/usages` rate limits, cache/freshness guarantees, SLA, and versioning policy;
- complete error schema and whether `Retry-After` may appear;
- whether every subscription tier, region, OAuth scope, and Kimi Code API key can access the endpoint;
- whether monthly Kimi membership exhaustion is always represented in `totalQuota`;
- long-term stability of `boosterWallet` and other ancillary fields.
