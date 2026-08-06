import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QuotaSnapshot } from "../src/quota-contract.ts";
import { renderQuotaDetails } from "../src/quota-details.ts";
import { formatTimestamp } from "../src/quota-time.ts";
import type { QuotaState } from "../src/quota-lifecycle.ts";

const NOW = 1_735_689_000;

const SOURCE = { kind: "first-party-private" as const, fetchedAtSeconds: NOW };

function availableSnapshot(windows: { id: string; label: string; remainingPercent: number; durationSeconds?: number; resetAtSeconds?: number }[]): Extract<QuotaSnapshot, { status: "available" }> {
  return { status: "available", provider: "openai-codex", windows, source: SOURCE };
}

const TWO_WINDOWS = availableSnapshot([
  { id: "codex-secondary", label: "7d", remainingPercent: 95, durationSeconds: 604800, resetAtSeconds: NOW + 432000 },
  { id: "codex-primary", label: "5h", remainingPercent: 58, durationSeconds: 18000, resetAtSeconds: NOW + 720 },
]);

describe("quota detail rendering", () => {
  it("shows every supported provider section and marks the active provider", () => {
    const states: QuotaState[] = [
      {
        provider: "openai-codex",
        current: TWO_WINDOWS,
        lastRenderable: TWO_WINDOWS,
        stale: false,
        consecutiveFailures: 0,
        lastCompletedAt: NOW,
      },
      { provider: "kimi-coding", stale: false, consecutiveFailures: 0 },
      { provider: "zai", stale: false, consecutiveFailures: 0 },
    ];

    const rendered = renderQuotaDetails(states, "openai-codex", NOW);

    assert.match(rendered, /OpenAI Codex \(active\)/u);
    assert.match(rendered, /Kimi For Coding/u);
    assert.match(rendered, /Z\.AI/u);
  });

  it("shows every validated window, reset time, source stability, and update age", () => {
    const state: QuotaState = {
      provider: "openai-codex",
      current: TWO_WINDOWS,
      lastRenderable: TWO_WINDOWS,
      stale: false,
      consecutiveFailures: 0,
      lastCompletedAt: NOW - 30,
    };

    const rendered = renderQuotaDetails([state], "openai-codex", NOW);

    assert.match(rendered, /Source: first-party private/u);
    assert.match(rendered, /Last update: 30s ago/u);
    assert.match(rendered, new RegExp(`5h: 58% remaining · resets ${formatTimestamp(NOW + 720)!} \\(in 12m\\)`, "u"));
    assert.match(rendered, new RegExp(`7d: 95% remaining · resets ${formatTimestamp(NOW + 432000)!} \\(in 5d0h\\)`, "u"));
    assert.ok(rendered.indexOf("5h: 58%") < rendered.indexOf("7d: 95%"));
  });

  it("shows stale last-renderable data with stale age and a sanitized unavailable reason", () => {
    const lastRenderable: Extract<QuotaSnapshot, { status: "available" }> = {
      ...TWO_WINDOWS,
      source: { ...SOURCE, fetchedAtSeconds: NOW - 300 },
    };
    const state: QuotaState = {
      provider: "openai-codex",
      current: {
        status: "unavailable",
        provider: "openai-codex",
        reason: "auth-required",
        source: { ...SOURCE, fetchedAtSeconds: NOW - 30 },
      },
      lastRenderable,
      stale: true,
      consecutiveFailures: 1,
      lastCompletedAt: NOW - 30,
    };

    const rendered = renderQuotaDetails([state], "openai-codex", NOW);

    assert.match(rendered, /Status: stale/u);
    assert.match(rendered, /Unavailable reason: authentication required/u);
    assert.match(rendered, /Stale data age: 5m/u);
    assert.match(rendered, /5h: 58% remaining/u);
  });

  it("puts validated quota telemetry under an unknown-semantics heading", () => {
    const degraded: Extract<QuotaSnapshot, { status: "degraded" }> = {
      status: "degraded",
      provider: "zai",
      telemetry: [
        {
          id: "zai-token-limit",
          providerLabel: "Z.AI token telemetry",
          percent: 61,
          counters: { currentValue: 120, usage: 80 },
          semantics: "unknown",
        },
      ],
      source: { kind: "first-party-private", fetchedAtSeconds: NOW },
    };
    const state: QuotaState = {
      provider: "zai",
      current: degraded,
      lastRenderable: degraded,
      stale: false,
      consecutiveFailures: 0,
      lastCompletedAt: NOW,
    };

    const rendered = renderQuotaDetails([state], "zai", NOW);

    assert.match(rendered, /Unknown semantics:/u);
    assert.match(rendered, /Z\.AI token telemetry: percentage 61% · currentValue 120 · usage 80/u);
    assert.doesNotMatch(rendered, /remaining|reset/iu);
  });

  it("renders only normalized diagnostic fields and omits sensitive source metadata", () => {
    const snapshot: Extract<QuotaSnapshot, { status: "unavailable" }> = {
      status: "unavailable",
      provider: "kimi-coding",
      reason: "transient",
      source: {
        kind: "experimental",
        fetchedAtSeconds: NOW,
        detailUrl: "https://account-id:credential@example.test/?authorization=Bearer-secret-token",
      },
    };
    const state: QuotaState = {
      provider: "kimi-coding",
      current: snapshot,
      stale: false,
      consecutiveFailures: 1,
      lastCompletedAt: NOW,
    };

    const rendered = renderQuotaDetails([state], "kimi-coding", NOW);

    assert.match(rendered, /Unavailable reason: temporarily unavailable/u);
    assert.doesNotMatch(rendered, /account-id|credential|authorization|Bearer|secret-token|example\.test/iu);
  });
});

