import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QuotaSnapshot } from "../src/quota-contract.ts";
import { QUOTA_GLYPH, renderQuotaStatus } from "../src/quota-render.ts";

const NOW = 1_735_689_000;

const SOURCE = { kind: "first-party-private" as const, fetchedAtSeconds: NOW };

function availableSnapshot(windows: { id: string; label: string; remainingPercent: number; durationSeconds?: number; resetAtSeconds?: number }[]): QuotaSnapshot {
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

  it("renders degraded snapshots as a muted telemetry indicator", () => {
    const snapshot: QuotaSnapshot = {
      status: "degraded",
      provider: "zai",
      telemetry: [{ id: "zai-usage", providerLabel: "Z.AI", percent: 61, semantics: "unknown" }],
      source: SOURCE,
    };

    const rendered = renderQuotaStatus(snapshot, { nowSeconds: NOW });

    assert.deepEqual(rendered, { glyph: QUOTA_GLYPH, text: "telemetry", tone: "muted" });
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
