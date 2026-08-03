# OpenAI Codex subscription quota source and semantics

_Research snapshot: OpenAI Codex source commit [`136f75e`](https://github.com/openai/codex/tree/136f75e7b7fca7d327fe0f23368ed5482804ea5f); locally installed Pi / `@earendil-works/pi-ai` 0.83.0._

## Decision

Use a **best-effort, read-only** request to:

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <Pi openai-codex OAuth access token>
ChatGPT-Account-ID: <chatgpt_account_id claim from that token>
```

This is the endpoint the first-party Codex client uses for a ChatGPT backend URL: its backend client performs a GET and decodes JSON, and maps `.../backend-api` to `/wham/usage` ([request](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/backend-client/src/client/rate_limit_resets.rs#L23-L35), [path selection](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/backend-client/src/client/rate_limit_resets.rs#L80-L85)). A non-ChatGPT Codex service base URL instead maps to `/api/codex/usage`; that is not Pi's built-in route.

**Important:** this is first-party behavior, not a documented public API contract. OpenAI's public docs say that current limits are visible in the usage dashboard and Codex UI, and that limits vary with model and task complexity, but do not document this endpoint or its schema ([pricing/limits](https://developers.openai.com/codex/pricing#what-are-the-usage-limits-for-my-plan), [where to view usage](https://developers.openai.com/codex/pricing#where-can-i-see-my-current-usage-limits), [`/usage`](https://developers.openai.com/codex/cli/slash-commands#view-account-usage-with-usage)). Treat it as an unstable capability and degrade to “unavailable,” never to zero remaining.

No authenticated endpoint was called during this research, and no model request was made.

## Authentication from Pi

Pi 0.83.0's built-in provider uses `https://chatgpt.com/backend-api` and ChatGPT OAuth ([provider source](https://github.com/earendil-works/pi/blob/3d264e85b4f870a93c5b763b95dd988a4f225da4/packages/ai/src/providers/openai-codex.ts#L7-L16)). The OAuth resolver returns the access token as `auth.apiKey` ([OAuth source](https://github.com/earendil-works/pi/blob/3d264e85b4f870a93c5b763b95dd988a4f225da4/packages/ai/src/auth/oauth/openai-codex.ts#L533-L537)); Pi's Codex transport derives `chatgpt_account_id` from the JWT and sends both bearer and account headers ([claim extraction](https://github.com/earendil-works/pi/blob/3d264e85b4f870a93c5b763b95dd988a4f225da4/packages/ai/src/auth/oauth/openai-codex.ts#L395-L413), [request headers](https://github.com/earendil-works/pi/blob/3d264e85b4f870a93c5b763b95dd988a4f225da4/packages/ai/src/api/openai-codex-responses.ts#L1591-L1611)). The official Codex client sends the same two headers ([auth provider](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/model-provider/src/bearer_auth_provider.rs#L29-L49)); its endpoint test requires them ([test](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/app-server/tests/suite/v2/rate_limits.rs#L181-L188)).

An extension should:

1. Call `await ctx.modelRegistry.getProviderAuth("openai-codex")` for each refresh ([extension-facing resolver](https://github.com/earendil-works/pi/blob/3d264e85b4f870a93c5b763b95dd988a4f225da4/packages/coding-agent/src/core/model-registry.ts#L107-L118)). This uses Pi's normal stored-credential resolution and refresh path; do not read `auth.json` directly.
2. Require `result?.auth.apiKey`. Decode only the JWT payload locally and read `payload["https://api.openai.com/auth"].chatgpt_account_id`, as Pi does.
3. Send the token only to the built-in HTTPS origin. Never log, persist, render, or include it in an error. Do not retain it beyond the request.
4. If auth resolution, JWT decoding, or the account claim fails, report `auth-unavailable` and offer `/login`; do not try a Platform API key. OpenAI documents that ChatGPT login gives subscription access while API-key login is separately billed ([authentication](https://developers.openai.com/codex/auth)).

## Verifiable response shape

The current first-party generated model and tests establish this shape; most nested objects may be absent or null:

```jsonc
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 42,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 120,
      "reset_at": 1735689720
    },
    "secondary_window": {
      "used_percent": 5,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 43200,
      "reset_at": 1735693200
    }
  },
  "credits": {
    "has_credits": true,
    "unlimited": false,
    "balance": "123"
  },
  "additional_rate_limits": [
    {
      "limit_name": "...",
      "metered_feature": "...",
      "rate_limit": { "allowed": true, "limit_reached": false, "primary_window": { /* same shape */ } }
    }
  ],
  "rate_limit_reached_type": { "type": "rate_limit_reached" }
}
```

Sources: top-level model and known reached-type values ([model](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs#L15-L105)); window model ([window](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs#L12-L38)); rate-limit booleans ([details](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs#L15-L45)); credits ([credits](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-backend-openapi-models/src/models/credit_status_details.rs#L12-L52)); representative official test fixture ([fixture](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/app-server/tests/suite/v2/rate_limits.rs#L129-L179)).

Use a tolerant parser. Preserve unknown `plan_type`, reached types, `metered_feature`, and additional limit buckets rather than rejecting the whole response.

## Semantics an extension can use

| Value | Safe interpretation | Caveat |
|---|---|---|
| `used_percent` | Percentage of that window already consumed. Display remaining as a **derived estimate** `clamp(100 - used_percent, 0, 100)`. | It is not messages, tokens, or credits. OpenAI says per-message usage varies with model, task size/complexity, local/cloud execution, context, reasoning, and tools ([docs](https://developers.openai.com/codex/pricing#what-are-the-usage-limits-for-my-plan)). |
| `limit_window_seconds` | Duration of the returned rolling window. | Do not hard-code primary = five hours or secondary = weekly. Public docs say local/cloud usage shares a five-hour window and that additional weekly limits **may** apply, but the payload's returned duration is the only account-specific signal ([docs](https://developers.openai.com/codex/pricing#usage-limits)). |
| `reset_at` | Unix epoch seconds when that window resets. | Prefer this absolute value for display. `reset_after_seconds` is a relative snapshot and can age or disagree because of clock/network delay. Exact replenishment mechanics are not publicly specified. |
| `allowed` / `limit_reached` | Backend's current decision for that bucket. | Do not infer blocking solely from `used_percent >= 100`: credits or workspace controls may affect availability. Missing is unknown. |
| `primary_window` / `secondary_window` | Two independent windows, each with its own duration, usage, and reset. | Names do not document business meaning. Render by duration (for example, “5 h window”), not by assumed plan label. |
| `credits` | `has_credits`, `unlimited`, and an optional backend-formatted balance. | Keep `balance` as an opaque decimal/string; its units and precision are not defined by this private schema. Credits can extend usage after included limits ([public docs](https://developers.openai.com/codex/pricing#credits-overview)). |
| `additional_rate_limits` | Additional independently metered buckets keyed by opaque `metered_feature`; preserve `limit_name` for display. | Bucket IDs and model assignments can change. Do not collapse them into the default `codex` bucket. |
| `rate_limit_reached_type.type` | One of `rate_limit_reached`, owner/member credits depleted, or owner/member workspace usage limit reached. | Parse unknown values as `unknown`; current Codex source deliberately maps future values to unknown. |

The first-party protocol itself describes `used_percent` as consumed percentage, window duration as rolling, and `resets_at` as Unix seconds ([protocol](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/protocol/src/protocol.rs#L2198-L2208)). Those comments describe current source behavior, not a public API guarantee.

## Response-header alternative

Codex also parses quota metadata from model-response headers:

```text
x-codex-primary-used-percent
x-codex-primary-window-minutes
x-codex-primary-reset-at
x-codex-secondary-used-percent
x-codex-secondary-window-minutes
x-codex-secondary-reset-at
x-codex-credits-has-credits
x-codex-credits-unlimited
x-codex-credits-balance
x-codex-active-limit
x-codex-rate-limit-reached-type
```

For additional buckets, a limit ID such as `codex_other` becomes the `x-codex-other-*` family, with optional `x-codex-other-limit-name`. The parser and normalization are explicit in first-party source ([header parser](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-api/src/rate_limits.rs#L22-L100), [field parsing](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-api/src/rate_limits.rs#L193-L260)). WebSocket responses can instead carry a `codex.rate_limits` event with analogous `primary`, `secondary`, `credits`, and `plan_type` fields ([parser](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-api/src/rate_limits.rs#L103-L175)).

These signals are useful only as **passive updates** from an already-requested model turn. They are undocumented, may be absent, and making a model request merely to obtain them would consume quota. The standalone GET is the appropriate refresh source; passively observed headers/events may update the cache but must not be required.

## Errors and degradation

There is no documented error contract for `/wham/usage`. The current client accepts any 2xx response that decodes to its JSON model and turns every other status, network failure, or decode failure into a generic error ([client behavior](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/backend-client/src/client.rs#L244-L302)). The following is therefore recommended degradation policy, not server contract:

- `401`/`403`: mark auth/workspace access unavailable, re-resolve auth, and offer re-login; do not display zero.
- `404` or schema mismatch: mark the capability unsupported for this client/backend version.
- `429`, `5xx`, timeout, or network failure: transient unavailable; retain a timestamped last-known snapshot and label it stale.
- Partial/missing windows or credits: preserve the fields that parsed; missing means unknown.
- Do not invent a polling SLA. Refresh on explicit user action/startup and conservatively thereafter; back off on failures.

For model-call errors, not every HTTP 429 means subscription exhaustion. Codex recognizes 429 plus `error.type == "usage_limit_reached"` (with optional `plan_type` and Unix `resets_at`) as subscription exhaustion, recognizes `usage_not_included` separately, and treats other 429s as generic retry/rate-limit errors ([mapping](https://github.com/openai/codex/blob/136f75e7b7fca7d327fe0f23368ed5482804ea5f/codex-rs/codex-api/src/api_bridge.rs#L94-L128)). Preserve that distinction.

## Stability conclusion

Reliable best-effort retrieval is possible today, but **no exact endpoint, field, header, polling, or compatibility guarantee is publicly documented**. The extension can rely on only these defensive rules:

1. Subscription quota requires Pi's ChatGPT OAuth identity, not an OpenAI Platform API key.
2. Interpret values only when explicitly present; missing/invalid data is unknown.
3. Treat percentages as consumed capacity and reset timestamps as epoch seconds; never convert them to an exact message count.
4. Feature-detect and parse forward-compatibly, cache with freshness metadata, and fail open in the UI.
5. Keep the usage-dashboard link (`https://chatgpt.com/codex/settings/usage`) as the stable human fallback.
