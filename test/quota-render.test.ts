import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QuotaSnapshot } from "../src/quota-contract.ts";
import { QUOTA_GLYPH, renderQuotaDetails, renderQuotaStatus } from "../src/quota-render.ts";
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

describe("quota footer rendering", () => {
  it("renders the quota glyph followed by windows ordered by ascending duration", () => {
    const rendered = renderQuotaStatus(TWO_WINDOWS, { nowSeconds: NOW });

    assert.ok(rendered);
    assert.equal(rendered.glyph, QUOTA_GLYPH);
    // 12 minutes and 5 days countdowns
    assert.equal(rendered.text, "5h 58% ↻12m · 7d 95% ↻5d0h");
    assert.equal(rendered.tone, "normal");
  });

  it("renders at most two validated quota windows", () => {
    const snapshot = availableSnapshot([
      { id: "a", label: "1h", remainingPercent: 10, durationSeconds: 3600 },
      { id: "b", label: "5h", remainingPercent: 20, durationSeconds: 18000 },
      { id: "c", label: "7d", remainingPercent: 30, durationSeconds: 604800 },
    ]);

    const rendered = renderQuotaStatus(snapshot, { nowSeconds: NOW });

    assert.equal(rendered?.text, "1h 10% · 5h 20%");
  });

  it("omits unknown resets and durations without failing", () => {
    const snapshot = availableSnapshot([{ id: "a", label: "window", remainingPercent: 80 }]);

    const rendered = renderQuotaStatus(snapshot, { nowSeconds: NOW });

    assert.equal(rendered?.text, "window 80%");
  });

  it("renders unavailable snapshots as nothing", () => {
    const snapshot: QuotaSnapshot = { status: "unavailable", provider: "openai-codex", reason: "transient", source: SOURCE };

    assert.equal(renderQuotaStatus(snapshot, { nowSeconds: NOW }), undefined);
  });

  it("marks preserved last renderable snapshots as stale without changing their quota values", () => {
    const rendered = renderQuotaStatus(TWO_WINDOWS, { nowSeconds: NOW, stale: true });

    assert.ok(rendered);
    assert.equal(rendered.text, "5h 58% ↻12m · 7d 95% ↻5d0h");
    assert.equal(rendered.tone, "stale");
  });

  it("renders degraded snapshots as a muted telemetry indicator", () => {
    const snapshot: QuotaSnapshot = {
      status: "degraded",
      provider: "zai",
      telemetry: [{ id: "zai-usage", providerLabel: "Z.AI", percent: 61, semantics: "unknown" }],
      source: SOURCE,
    };

    const rendered = renderQuotaStatus(snapshot, { nowSeconds: NOW });

    assert.deepEqual(rendered, {
      glyph: QUOTA_GLYPH,
      text: "telemetry",
      segments: [{ role: "value", text: "telemetry" }],
      tone: "muted",
    });
  });
});

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

describe("quota footer width fallbacks", () => {
  // Full text: "◷ 5h 58% ↻12m · 7d 95% ↻5d0h" = 29 columns
  it("omits reset segments before window data", () => {
    const rendered = renderQuotaStatus(TWO_WINDOWS, { nowSeconds: NOW, width: 20 });

    assert.equal(rendered?.text, "5h 58% · 7d 95%");
  });

  it("omits secondary windows when resets alone are not enough", () => {
    const rendered = renderQuotaStatus(TWO_WINDOWS, { nowSeconds: NOW, width: 10 });

    assert.equal(rendered?.text, "5h 58%");
  });

  it("keeps the full rendering when it fits", () => {
    const rendered = renderQuotaStatus(TWO_WINDOWS, { nowSeconds: NOW, width: 30 });

    assert.equal(rendered?.text, "5h 58% ↻12m · 7d 95% ↻5d0h");
  });
});
