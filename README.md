# Pi Quota

Pi Quota is a zero-configuration [Pi](https://github.com/earendil-works/pi-mono) extension that shows the active provider account's usage allowance in the TUI footer. It reports provider quota only—not conversation context usage, token counts, or estimated cost.

## Installation

Install the package in Pi's user scope directly from Git:

```bash
pi install git:github.com/yet-an-other/pi-quota
```

The user-scoped package loads in every project without project-local trust. It needs no Pi Quota configuration; it uses authentication already configured in Pi for the active provider. Missing authentication degrades silently.

Update or remove it with:

```bash
pi update --extensions
pi remove git:github.com/yet-an-other/pi-quota
```

Pi packages execute code with your user permissions. Review third-party package source before installing it.

## Supported providers

| Pi provider | Display behavior | Data source |
| --- | --- | --- |
| OpenAI Codex (`openai-codex`) | Validated remaining percentages and reset windows | First-party, undocumented ChatGPT usage endpoint |
| Kimi For Coding (`kimi-coding`) | Validated remaining percentages and reset windows | First-party, experimental Kimi usage endpoint |
| Z.AI global (`zai`) | Telemetry indicator only | First-party, undocumented monitor endpoint |

Z.AI's reported values do not have sufficiently verified semantics to call them remaining quota or reset windows. Pi Quota therefore labels them as **unknown-semantics quota telemetry** and never invents remaining-capacity or reset information. The separate Z.AI Coding Plan CN integration is not treated as the global `zai` provider.

Unsupported providers render no quota status and produce no notification. JSON, print, and RPC modes also remain silent; footer status and `/quota` are TUI-only.

## Display and commands

The footer begins with `◷` and shows at most two validated quota windows, shortest first. For example:

```text
◷ 5h 58% ↻12m · 7d 95% ↻5d0h
```

Narrow terminals drop reset countdowns and then the second window. Failed refreshes never display an invented zero. If the same provider has previously returned renderable data, the footer preserves it in stale colors; otherwise it stays empty.

### `/quota`

Fetches any supported providers not yet inspected in this session and opens an all-provider diagnostic view. It marks the active provider and shows only normalized status, source stability, freshness, validated windows, sanitized failure reasons, or unknown-semantics telemetry.

### `/quota refresh`

Forces a refresh of the active supported provider, bypassing automatic throttle and failure backoff. The request completes or times out within eight seconds and reports a sanitized success or failure notification. A matching in-flight refresh is reused.

Pi Quota also refreshes on session startup, provider changes, and settled agent work. Settled-work refreshes are throttled for 60 seconds after a successful completion; repeated failures use bounded backoff.

## Privacy and network behavior

- Provider authentication is resolved from Pi at fetch time and retained only for the request.
- Credentials and Codex account identifiers are sent only in request headers to a verified first-party provider origin.
- The extension makes read-only quota/usage requests. It never makes model calls or consumes quota by generating tokens.
- Credentials, authorization headers, account identifiers, provider response bodies, and endpoint URLs are never rendered or logged.
- Pi Quota does not append session entries or persist quota state or credentials. Quota state is held in memory and cleared on session shutdown.
- Diagnostics expose normalized fields and sanitized reason labels only.

The automated suite uses fixtures and mocked authentication. It requires no live provider, real credential, or quota-consuming request.

## Troubleshooting

### No footer status

Confirm that the active model uses one of the exact provider IDs above and that Pi already has authentication for it. An unsupported provider, missing authentication, rejected provider origin, schema change, or unavailable endpoint intentionally leaves the footer empty rather than showing misleading data.

Run `/quota` to compare all supported providers. Its failure labels distinguish authentication, unsupported behavior, schema drift, ambiguity, and transient unavailability without exposing upstream details.

### Stale colors

A refresh failed after the same provider had produced renderable data. Pi Quota preserves that last value rather than clearing it or rendering zero. Run `/quota refresh`; if the provider remains unavailable, the command fails within eight seconds and the stale value remains.

### Z.AI says `telemetry`

This is expected degraded behavior. `/quota` can show validated provider-reported values under **Unknown semantics**, but Pi Quota does not interpret them as remaining capacity or reset timing.

### `/quota` does nothing

The command is intentionally silent outside the interactive TUI. Start Pi normally rather than in print, JSON, or RPC mode.

## Manual acceptance checklist (real accounts)

Automated tests do not contact live providers. Before a release, test with real accounts in a terminal wide enough to show the complete footer. Do not paste credentials into prompts, commands, screenshots, issue reports, or test notes.

### Package and startup

- [ ] In a clean user-scoped Pi configuration, run `pi install git:github.com/yet-an-other/pi-quota` without `-l`; `pi list` shows the Git package.
- [ ] Start Pi in an untrusted project with no project-local Pi Quota files or settings; the extension loads without a project trust requirement or setup prompt.
- [ ] Start a TUI session on each authenticated supported provider; Codex and Kimi show validated windows, while global Z.AI shows only `◷ telemetry`.
- [ ] Start without credentials for a supported provider; Pi starts normally and the quota footer remains empty.

### Refresh lifecycle

- [ ] Let startup finish; quota work does not delay interaction, and a live result appears when available.
- [ ] Complete agent work less than 60 seconds after the previous successful refresh; no redundant refresh occurs.
- [ ] Complete settled agent work after at least 60 seconds; `/quota` shows a newer **Last update** age.
- [ ] Run `/quota refresh`; it reports success and updates the active provider without clearing the footer while pending.
- [ ] Switch Codex → Kimi → Z.AI → Codex; old-provider status clears immediately, late responses do not overwrite the active provider, and each new provider renders only its own data.

### Failure and degradation

- [ ] After obtaining renderable Codex or Kimi data, block that provider's quota endpoint and run `/quota refresh`; Pi remains responsive, reports failure within eight seconds, never renders `0%`, and preserves the same-provider value as stale.
- [ ] Restore the network and refresh again; current rendering replaces the stale state.
- [ ] Switch to an unsupported provider such as Anthropic; the quota footer clears with no Pi Quota error or notification.
- [ ] Run Pi in print, JSON, and RPC modes; Pi Quota emits no footer, dialog, notification, or provider request.
- [ ] With global Z.AI active, confirm the footer says only `telemetry`; `/quota` places values under **Unknown semantics** and shows no remaining-capacity wording or reset timestamp.

### Diagnostics and credential hygiene

- [ ] Run `/quota`; it shows OpenAI Codex, Kimi For Coding, and Z.AI, marks the active provider, and includes freshness/source information plus validated windows or sanitized unavailable reasons.
- [ ] Confirm `/quota` and the footer contain no access token, API key, authorization header, account identifier, provider endpoint URL, or raw response body.
- [ ] Inspect Pi's terminal/log output and the current session JSONL entries after startup, `/quota`, refresh, switching, and a forced failure; Pi Quota has logged and persisted none of those sensitive values and has appended no quota-state entry.
- [ ] End the session and start another while the provider endpoint is blocked; no prior quota snapshot is restored from disk.
