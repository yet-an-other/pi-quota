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
| Z.AI global (`zai`) | Validated remaining percentages and reset windows | First-party, undocumented monitor endpoint |

Z.AI's monitor endpoint is undocumented and internally owned, so its payload may change without notice; Pi Quota treats it as first-party-private and still never invents remaining-capacity or reset information. The separate Z.AI Coding Plan CN integration is not treated as the global `zai` provider.

Unsupported providers render no quota status and produce no notification. JSON, print, and RPC modes also remain silent; footer status and `/quota` are TUI-only.

## Display and commands

The footer begins with `◷` and shows at most two validated quota windows, shortest first. For example:

```text
◷ 5h: 58% ↻ 12m · 7d: 95% ↻ 5d0h
```

The glyph, window labels, and `↻` use the theme success color. Each window's values are colored by remaining quota: error under 10%, warning under 20%, success otherwise.

Narrow terminals drop reset countdowns and then the second window. Failed refreshes never display an invented zero. If the same provider has previously returned renderable data, the footer preserves it in stale colors; otherwise it stays empty.

### `/quota`

Refreshes every supported provider concurrently on every invocation, then opens the all-provider diagnostic view. It marks the active provider and shows only normalized status, source stability, freshness, validated windows, or sanitized failure reasons. Matching in-flight requests are reused, but completed quota snapshots are never reused as fresh data. The command emits no refresh notification and accepts no arguments.

Pi Quota also refreshes on session startup, active model changes, and transitions into and out of agent work. While the model is working, the active provider is requested every minute. After work settles, automatic requests use one-minute, two-minute, five-minute, and then fifteen-minute intervals, continuing at fifteen minutes while idle. A known quota-window reset triggers a request on the next heartbeat at or after that time. Repeated failures use minimum waits of two, five, and fifteen minutes.

The footer redraws every minute from the latest quota snapshot so reset countdowns stay current. A heartbeat redraw does not require a network request. When a request fails after renderable data exists, the footer keeps that data in stale colors and the quota icon changes to the warning color. Background failures do not notify the user.

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

A refresh failed after the same provider had produced renderable data. Pi Quota preserves that last value rather than clearing it or rendering zero, colors the quota icon as a warning, and stays silent. Run `/quota` to fetch every supported provider and inspect the sanitized failure reason.

### `/quota` does nothing

The command is intentionally silent outside the interactive TUI. Start Pi normally rather than in print, JSON, or RPC mode.

## Manual acceptance checklist (real accounts)

Automated tests do not contact live providers. Before a release, test with real accounts in a terminal wide enough to show the complete footer. Do not paste credentials into prompts, commands, screenshots, issue reports, or test notes.

### Package and startup

- [ ] In a clean user-scoped Pi configuration, run `pi install git:github.com/yet-an-other/pi-quota` without `-l`; `pi list` shows the Git package.
- [ ] Start Pi in an untrusted project with no project-local Pi Quota files or settings; the extension loads without a project trust requirement or setup prompt.
- [ ] Start a TUI session on each authenticated supported provider; Codex, Kimi, and Z.AI each show validated windows.
- [ ] Start without credentials for a supported provider; Pi starts normally and the quota footer remains empty.

### Refresh lifecycle

- [ ] Let startup finish; quota work does not delay interaction, and a live result appears when available.
- [ ] Start agent work; the active provider refreshes immediately and at each one-minute heartbeat while work continues.
- [ ] Settle agent work; the active provider refreshes immediately, then idle requests use one-minute, two-minute, five-minute, and fifteen-minute intervals.
- [ ] Leave the session idle; the footer redraws every minute, and idle refreshes continue at the fifteen-minute ceiling.
- [ ] Run `/quota`; every supported provider fetches concurrently, completed snapshots are not reused, the details view opens after all requests settle, and no refresh notification appears.
- [ ] Run `/quota refresh` or `/quota refresh all`; each is rejected with `Usage: /quota` and fetches nothing.
- [ ] Switch Codex → Kimi → Z.AI → Codex; old-provider status clears immediately, late responses do not overwrite the active provider, and each new provider renders only its own data.
- [ ] With a known reset earlier than the next idle request, confirm the next heartbeat requests the provider at the reset.

### Failure and degradation

- [ ] After obtaining renderable Codex or Kimi data, block that provider's quota endpoint and wait for an automatic refresh; Pi remains responsive, reports no notification, never renders `0%`, changes the quota icon to the warning color, and preserves the same-provider value as stale.
- [ ] Run `/quota` while the endpoint remains blocked; the details view shows a sanitized failure reason and the stale footer value remains visible.
- [ ] Restore the network and run `/quota`; current rendering replaces the stale state.
- [ ] Switch to an unsupported provider such as Anthropic; the quota footer clears with no Pi Quota error or notification.
- [ ] Run Pi in print, JSON, and RPC modes; Pi Quota emits no footer, dialog, notification, or provider request.
- [ ] With global Z.AI active, block its monitor endpoint and wait for an automatic refresh; Pi reports no notification, renders no invented zero, changes the quota icon to the warning color, and preserves any prior Z.AI value as stale.

### Diagnostics and credential hygiene

- [ ] Run `/quota`; it shows OpenAI Codex, Kimi For Coding, and Z.AI, marks the active provider, and includes freshness/source information plus validated windows or sanitized unavailable reasons.
- [ ] Confirm `/quota` and the footer contain no access token, API key, authorization header, account identifier, provider endpoint URL, or raw response body.
- [ ] Inspect Pi's terminal/log output and the current session JSONL entries after startup, `/quota`, refresh, switching, and a forced failure; Pi Quota has logged and persisted none of those sensitive values and has appended no quota-state entry.
- [ ] End the session and start another while the provider endpoint is blocked; no prior quota snapshot is restored from disk.
