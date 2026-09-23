import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QuotaSnapshot } from "../src/quota-contract.ts";
import { clearProviderStatus, renderProviderStatus } from "../src/quota-footer.ts";
import { createQuotaHost } from "./mock-host.ts";

const NOW = 1_735_689_000;
const SOURCE = { kind: "first-party-private" as const, fetchedAtSeconds: NOW };

function availableSnapshot(
  windows: Extract<QuotaSnapshot, { status: "available" }>["windows"],
): Extract<QuotaSnapshot, { status: "available" }> {
  return { status: "available", provider: "openai-codex", windows, source: SOURCE };
}

const TWO_WINDOWS = availableSnapshot([
  { id: "codex-secondary", label: "7d", remainingPercent: 95, durationSeconds: 604800, resetAtSeconds: NOW + 432000 },
  { id: "codex-primary", label: "5h", remainingPercent: 58, durationSeconds: 18000, resetAtSeconds: NOW + 720 },
]);
const FULL_FOOTER = "[success:◷] [success:5h:][success: 58% ][success:↻][success: 12m]" +
  "[dim: · ][success:7d:][success: 95% ][success:↻][success: 5d0h]";

describe("quota footer host delivery", () => {
  it("delivers colored windows in ascending duration order under the quota status ID", () => {
    const { host, statusCalls } = createQuotaHost();
    renderProviderStatus(host, TWO_WINDOWS, { nowSeconds: () => NOW }, false);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: FULL_FOOTER }]);
  });

  it("renders at most two validated quota windows", () => {
    const { host, statusCalls } = createQuotaHost();
    const snapshot = availableSnapshot([
      { id: "a", label: "1h", remainingPercent: 10, durationSeconds: 3600 },
      { id: "b", label: "5h", remainingPercent: 20, durationSeconds: 18000 },
      { id: "c", label: "7d", remainingPercent: 30, durationSeconds: 604800 },
    ]);
    renderProviderStatus(host, snapshot, { nowSeconds: () => NOW }, false);

    assert.equal(statusCalls.at(-1)?.text,
      "[success:◷] [success:1h:][warning: 10%][dim: · ][success:5h:][success: 20%]");
  });

  it("omits unknown resets and durations", () => {
    const { host, statusCalls } = createQuotaHost();
    renderProviderStatus(host,
      availableSnapshot([{ id: "a", label: "window", remainingPercent: 80 }]),
      { nowSeconds: () => NOW }, false);

    assert.equal(statusCalls.at(-1)?.text, "[success:◷] [success:window:][success: 80%]");
  });

  for (const [remainingPercent, color] of [[0, "error"], [9, "error"], [10, "warning"], [19, "warning"], [20, "success"]] as const) {
    it(`colors ${remainingPercent}% and its reset countdown ${color}`, () => {
      const { host, statusCalls } = createQuotaHost();
      renderProviderStatus(host,
        availableSnapshot([{ id: "a", label: "5h", remainingPercent, resetAtSeconds: NOW + 720 }]),
        { nowSeconds: () => NOW }, false);

      assert.equal(statusCalls.at(-1)?.text,
        `[success:◷] [success:5h:][${color}: ${remainingPercent}% ][${color}:↻][${color}: 12m]`);
    });
  }

  for (const snapshot of [
    { status: "unavailable", provider: "openai-codex", reason: "transient", source: SOURCE } as const,
    availableSnapshot([]),
  ]) {
    it(`clears an existing status for ${snapshot.status === "unavailable" ? "unavailable data" : "empty windows"}`, () => {
      const { host, statusCalls } = createQuotaHost();
      renderProviderStatus(host, TWO_WINDOWS, { nowSeconds: () => NOW }, false);
      renderProviderStatus(host, snapshot, { nowSeconds: () => NOW }, false);

      assert.deepEqual(statusCalls, [
        { id: "pi-quota", text: FULL_FOOTER },
        { id: "pi-quota", text: undefined },
      ]);
    });
  }

  it("clears the quota status explicitly", () => {
    const { host, statusCalls } = createQuotaHost();
    renderProviderStatus(host, TWO_WINDOWS, { nowSeconds: () => NOW }, false);
    clearProviderStatus(host);
    assert.deepEqual(statusCalls.at(-1), { id: "pi-quota", text: undefined });
  });

  for (const mode of ["rpc", "print"] as const) {
    it(`does not paint or deliver status in ${mode} mode`, () => {
      const { host, statusCalls } = createQuotaHost(mode);
      host.theme.fg = () => { throw new Error("non-TUI footer must not paint"); };
      renderProviderStatus(host, TWO_WINDOWS, { nowSeconds: () => NOW }, false);
      clearProviderStatus(host);
      assert.deepEqual(statusCalls, []);
    });
  }
});

describe("quota footer width and freshness", () => {
  for (const { width, normal, stale } of [
    {
      width: 32,
      normal: FULL_FOOTER,
      stale: "5h: 58% ↻ 12m · 7d: 95% ↻ 5d0h",
    },
    {
      width: 20,
      normal: "[success:◷] [success:5h:][success: 58%][dim: · ][success:7d:][success: 95%]",
      stale: "5h: 58% · 7d: 95%",
    },
    {
      width: 10,
      normal: "[success:◷] [success:5h:][success: 58%]",
      stale: "5h: 58%",
    },
  ]) {
    it(`delivers the width fallback and both freshness colors at ${width} columns`, () => {
      const { host, statusCalls } = createQuotaHost();
      const deps = { nowSeconds: () => NOW, width };
      renderProviderStatus(host, TWO_WINDOWS, deps, false);
      renderProviderStatus(host, TWO_WINDOWS, deps, true);
      renderProviderStatus(host, TWO_WINDOWS, deps, false);

      assert.deepEqual(statusCalls, [
        { id: "pi-quota", text: normal },
        { id: "pi-quota", text: `[warning:◷] [muted:${stale}]` },
        { id: "pi-quota", text: normal },
      ]);
    });
  }
});
