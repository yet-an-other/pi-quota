# Z.AI Coding Plan quota source and semantics

## Decision

There is **no documented, stable API or response-header contract** that gives an extension complete global Z.AI Coding Plan quota state.

Z.AI's own open-source `glm-plan-usage` plugin is first-party evidence for this best-effort endpoint:

```http
GET https://api.z.ai/api/monitor/usage/quota/limit
Authorization: <ANTHROPIC_AUTH_TOKEN, copied verbatim>
Accept-Language: en-US,en
Content-Type: application/json
```

The request has no body or query parameters and is not a model call. The plugin requires HTTP 200 and parses JSON. See its pinned [host/URL selection](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs#L40-L56), [request construction](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs#L109-L137), and [quota invocation](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs#L165-L170). Z.AI documents the plugin as querying current quota/usage for the **Personal plan only** ([plugin documentation](https://docs.z.ai/devpack/extension/usage-query-plugin)).

This monitor endpoint and its schema are absent from Z.AI's public API reference. Treat them as **undocumented first-party implementation behavior**, not a compatibility promise. No reliable quota response headers were found: the public reference documents none, and the official plugin never reads response headers.

## Global provider and Pi authentication

Pi 0.83.0 keeps the two regions separate:

| Pi provider | Credential | Coding base URL |
|---|---|---|
| `zai` | stored API key or `ZAI_API_KEY` | `https://api.z.ai/api/coding/paas/v4` |
| `zai-coding-cn` | stored API key or `ZAI_CODING_CN_API_KEY` | `https://open.bigmodel.cn/api/coding/paas/v4` |

Sources: Pi's pinned [`zai` provider](https://github.com/earendil-works/pi/blob/v0.83.0/packages/ai/src/providers/zai.ts#L6-L14), [`zai-coding-cn` provider](https://github.com/earendil-works/pi/blob/v0.83.0/packages/ai/src/providers/zai-coding-cn.ts#L6-L14), and [API-key resolution](https://github.com/earendil-works/pi/blob/v0.83.0/packages/ai/src/auth/helpers.ts#L3-L27). Z.AI independently documents the global Coding Plan OpenAI-compatible URL ([quick start](https://docs.z.ai/devpack/quick-start)). A global `zai` key must not be sent to `open.bigmodel.cn`, and global and CN quota must not be combined.

An extension can resolve the existing credential without reading `auth.json` or the process environment directly, but it must first prevent credential exfiltration through a provider override:

```ts
const provider = ctx.modelRegistry.getProvider("zai");
if (!provider || new URL(provider.baseUrl).origin !== "https://api.z.ai") {
  return quotaUnavailable();
}

let resolved;
try {
  resolved = await ctx.modelRegistry.getProviderAuth("zai");
} catch {
  return quotaUnavailable();
}
const apiKey = resolved?.auth.apiKey;
if (!apiKey) return quotaUnavailable();
```

Pi documents `getProviderAuth(id)` as resolving current API key, headers, base URL, and provider-scoped environment ([extension API](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/extensions.md#L985-L989)); the implementation exposes it through [`ModelRegistry`](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/core/model-registry.ts#L91-L113). Pi permits provider base-URL/auth overrides, so the origin check is mandatory before resolving or sending the secret. For the monitor request, reject redirects and do not forward arbitrary configured provider headers. Never persist, display, or log the resolved credential.

### Authentication caveat

Z.AI's documented public API authentication is:

```http
Authorization: Bearer ZAI_API_KEY
```

([API introduction](https://docs.z.ai/api-reference/introduction)). However, the quota plugin copies `ANTHROPIC_AUTH_TOKEN` into `Authorization` **without adding `Bearer `**. The monitor endpoint has no documented authentication contract, so neither convention can be promised for it. Byte-for-byte emulation of the only monitor-specific first-party client means sending Pi's resolved key verbatim; standard documented Z.AI behavior favors `Bearer <key>`. Any probe must be feature-gated and allowed to fail closed rather than cycling through credential formats.

## What the response establishes

The official parser provides only this minimum, permissive shape; it is not a published schema:

```ts
type MonitorQuotaResponse = {
  data?: {
    limits?: Array<{
      type?: string;
      percentage?: unknown;
      currentValue?: unknown;
      usage?: unknown;
      usageDetails?: unknown;
      [unknownField: string]: unknown;
    }>;
  };
  [unknownField: string]: unknown;
};
```

It takes `json.data || json`, but post-processes limits only when `json.data` exists. For `type === "TOKENS_LIMIT"`, it retains only `percentage` and labels the item `Token usage(5 Hour)`. For `type === "TIME_LIMIT"`, it retains `percentage`, `currentValue`, `usage`, and `usageDetails` and labels the item `MCP usage(1 Month)`. See the pinned [parser](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs#L87-L108) and [envelope handling](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs#L139-L150).

An extension **cannot infer** from that source:

- whether `percentage` means consumed or remaining, its range, or rounding;
- total or remaining credits/tokens;
- plan tier or accounting version;
- which item is the weekly model window (the parser labels every `TOKENS_LIMIT` as 5-hour);
- a reset timestamp or time zone;
- field requiredness, ordering, uniqueness, or unknown-type behavior;
- Team Plan compatibility.

Accordingly, unknown fields/types must be preserved or ignored, not rejected globally; known-looking entries must be shown only when their meaning is unambiguous. Do not turn missing fields into zero.

## Documented plan semantics (not live telemetry)

The current global Personal plan documentation states that both limits apply and gives these capacities for the **new credits-based plans sold from July 30, 2026** ([Coding Plan overview](https://docs.z.ai/devpack/overview), [plan revision notice](https://docs.z.ai/devpack/notice/usage-revision)):

| Tier | 5-hour credits | Weekly credits |
|---|---:|---:|
| Lite | 2,000 | 10,000 |
| Pro | 12,000 | 60,000 |
| Max | 28,000 | 140,000 |

The same page says 5-hour credits are “dynamically refreshed” and reset five hours after consumption; weekly credits activate on subscription and reset every seven days. Thus the documented 5-hour behavior is consumption-relative, not a stated fixed wall-clock bucket, while the seven-day window is subscription-anchored. Legacy V1/V2 and Team plans can still have different accounting under the revision notice, and the monitor payload does not identify the accounting generation. These tables may be displayed as dated static plan information, but must not be used to calculate live remaining capacity unless a future authoritative response also identifies the subscriber's plan and accounting rules.

## Errors and reset information

Z.AI documents JSON errors as:

```json
{ "error": { "code": "<business code>", "message": "<message>" } }
```

The [error-code reference](https://docs.z.ai/api-reference/api-code) distinguishes:

- `1308`: a `{number} {unit}` usage limit, with `{next_flush_time}` in the message;
- `1310`: weekly/monthly exhaustion, with `{next_flush_time}`;
- `1316`/`1318`/`1320`: past-five-hour exhaustion variants;
- `1317`/`1319`/`1321`: past-seven-day exhaustion variants;
- `1302`: request-rate limit, **not quota exhaustion**;
- `1305`: temporary overload, **not quota exhaustion**;
- `1309`: expired Coding Plan.

Those are documented API error semantics, not a guarantee that the undocumented monitor GET uses the same envelope. They expose reset text only after rejection; reset time is embedded in a potentially localized message rather than a documented structured field. The same reference warns that abnormal termination after an SSE model response begins does not return this envelope and reports only `finish_reason`, so even reactive business codes are not always observable. A quota UI may classify known business codes from model-response bodies, but must not promise a machine-readable proactive reset time or confuse every HTTP 429 with exhausted plan quota.

## Stability and implementation guidance

| Fact | Reliability |
|---|---|
| Global/CN hosts and credentials are separate | Documented by Pi/official Z.AI configuration |
| Both 5-hour and weekly limits; current tier capacities and reset wording | Documented product semantics, subject to plan revisions |
| JSON API error envelope and business-code meanings | Documented API contract |
| `GET /api/monitor/usage/quota/limit` and verbatim auth header | First-party source, undocumented/unstable |
| `data.limits`, `TOKENS_LIMIT`, `TIME_LIMIT`, and all payload fields | First-party source, undocumented/unstable |
| Quota/rate response headers | No contract found; do not rely on them |
| Exact healthy-state remaining capacity and reset time | Not available from a reliable source |

Recommended degradation:

1. Make monitor access optional/best-effort, use a short timeout and bounded response size, coalesce concurrent refreshes, and refresh sparingly (the official plugin itself says to run the query once per invocation in its [README](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/README.md)).
2. Never make a model call to discover quota. Keep only a bounded last validated result with its observation time.
3. Do not automatically retry a monitor request: its error contract is unknown, and 429 can mean exhaustion, expiry, fair-use controls, request rate, or overload. Let a later user/scheduled refresh try again; never block Pi startup or model use on telemetry.
4. Use `redirect: "error"`, validate defensively, and display only server values whose window and polarity are established. Never synthesize remaining credits or reset timestamps.
5. On authentication ambiguity, schema drift, multiple indistinguishable token windows, or endpoint failure, show **“Quota unavailable — view Usage Statistics”** and link to <https://z.ai/manage-apikey/subscription>.

## Explicit unknowns

- Whether Z.AI will retain, version, or deprecate the monitor endpoint.
- Whether it accepts raw and/or Bearer authorization consistently for every global Personal and Team key type.
- Whether monitor GETs consume any non-model rate allowance.
- Complete raw response shape for the current credits-based plan, including two distinguishable model windows.
- Exact remaining capacity, reset instant/time zone, percentage polarity/rounding, and header behavior.
- Team Plan support; the official usage plugin is explicitly Personal-only.

Until Z.AI publishes a quota API/schema, the extension can offer only best-effort telemetry with graceful unavailability—not an exact global quota meter.
