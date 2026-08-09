import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQuotaSourceMeta,
  clampRemainingPercent,
  isRecord,
  asFiniteNumber,
  orderQuotaWindows,
  unavailableSnapshot,
  type QuotaSourceClassification,
  type QuotaWindow,
} from "../src/quota-contract.ts";

describe("quota contract validation", () => {
  it("derives remaining percent from a validated consumed percent", () => {
    assert.equal(clampRemainingPercent(42), 58);
    assert.equal(clampRemainingPercent(0), 100);
  });

  it("clamps remaining percent instead of inventing values out of range", () => {
    assert.equal(clampRemainingPercent(150), 0);
    assert.equal(clampRemainingPercent(-5), 100);
  });

  it("accepts only finite numbers", () => {
    assert.equal(asFiniteNumber(42), 42);
    assert.equal(asFiniteNumber("42"), undefined);
    assert.equal(asFiniteNumber(Number.NaN), undefined);
    assert.equal(asFiniteNumber(Number.POSITIVE_INFINITY), undefined);
    assert.equal(asFiniteNumber(undefined), undefined);
    assert.equal(asFiniteNumber(null), undefined);
  });

  it("accepts only plain objects as records", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord("x"), false);
  });

  it("orders windows by ascending duration, keeping snapshot order for ties and unknown durations", () => {
    const window = (id: string, durationSeconds?: number): QuotaWindow => ({
      id,
      label: id,
      remainingPercent: 50,
      durationSeconds,
    });

    const ordered = orderQuotaWindows([
      window("weekly", 604800),
      window("unknown-a"),
      window("five-hour", 18000),
      window("unknown-b"),
      window("weekly-tie", 604800),
    ]);

    assert.deepEqual(
      ordered.map((w) => w.id),
      ["five-hour", "weekly", "weekly-tie", "unknown-a", "unknown-b"],
    );
  });

  it("stamps a fetch timestamp onto a static source classification", () => {
    const classification: QuotaSourceClassification = {
      kind: "first-party-private",
      detailUrl: "https://example.test/usage",
    };
    assert.deepEqual(buildQuotaSourceMeta(classification, 1_700_000_000), {
      kind: "first-party-private",
      detailUrl: "https://example.test/usage",
      fetchedAtSeconds: 1_700_000_000,
    });
  });

  it("omits detailUrl from built source meta when the classification has none", () => {
    const meta = buildQuotaSourceMeta({ kind: "experimental" }, 100);
    assert.equal(meta.kind, "experimental");
    assert.equal(meta.detailUrl, undefined);
    assert.equal(meta.fetchedAtSeconds, 100);
  });

  it("builds an unavailable snapshot from a provider's static source identity", () => {
    const snapshot = unavailableSnapshot(
      "zai",
      { kind: "first-party-private", detailUrl: "https://example.test" },
      "transient",
      1_700_000_000,
    );
    assert.equal(snapshot.status, "unavailable");
    if (snapshot.status !== "unavailable") return;
    assert.equal(snapshot.provider, "zai");
    assert.equal(snapshot.reason, "transient");
    assert.equal(snapshot.source.kind, "first-party-private");
    assert.equal(snapshot.source.fetchedAtSeconds, 1_700_000_000);
  });
});
