import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResetCountdown, formatWindowDuration } from "../src/quota-time.ts";

describe("reset countdown formatting", () => {
  it("shows minutes for resets under one hour, rounding up to the next minute", () => {
    assert.equal(formatResetCountdown(1000 + 42 * 60, 1000), "42m");
    // 89.5 seconds remaining rounds up to 2 minutes, seconds omitted
    assert.equal(formatResetCountdown(1000 + 90, 1000), "2m");
    assert.equal(formatResetCountdown(1000 + 61, 1000), "2m");
  });

  it("shows hours and minutes for resets under one day", () => {
    assert.equal(formatResetCountdown(1000 + 5 * 3600 + 12 * 60, 1000), "5h12m");
    assert.equal(formatResetCountdown(1000 + 1439 * 60, 1000), "23h59m");
  });

  it("shows days and hours for resets of one day or more", () => {
    assert.equal(formatResetCountdown(1000 + 2 * 86400 + 3 * 3600, 1000), "2d3h");
    assert.equal(formatResetCountdown(1000 + 86400, 1000), "1d0h");
  });

  it("shows an expired reset as resetting now", () => {
    assert.equal(formatResetCountdown(1000, 1000), "now");
    assert.equal(formatResetCountdown(999, 1000), "now");
  });
});

describe("window duration formatting", () => {
  it("formats durations compactly", () => {
    assert.equal(formatWindowDuration(300), "5m");
    assert.equal(formatWindowDuration(18000), "5h");
    assert.equal(formatWindowDuration(604800), "7d");
  });
});
