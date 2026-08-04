import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchKimiQuotaSnapshot } from "../src/providers/kimi.ts";
import {
  assertUnavailable,
  FIVE_HOUR_RESET,
  kimiDeps,
  NOW,
  stubFetch,
  VALID_PAYLOAD,
  WEEKLY_RESET,
  jsonResponse,
} from "./kimi-fixtures.ts";

describe("kimi adapter: valid payload", () => {
  it("normalizes weekly usage and a shorter five-hour quota window", async () => {
    const snapshot = await fetchKimiQuotaSnapshot(kimiDeps());

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;

    assert.equal(snapshot.provider, "kimi-coding");
    assert.deepEqual(snapshot.windows, [
      {
        id: "kimi-weekly",
        label: "7d",
        remainingPercent: 75,
        durationSeconds: 604800,
        resetAtSeconds: Date.parse(WEEKLY_RESET) / 1000,
      },
      {
        id: "kimi-limit-18000",
        label: "5h",
        remainingPercent: 60,
        durationSeconds: 18000,
        resetAtSeconds: Date.parse(FIVE_HOUR_RESET) / 1000,
      },
    ]);
    assert.equal(snapshot.source.kind, "experimental");
    assert.equal(snapshot.windows.some((window) => "blocked" in window), false);
  });

  it("makes one read-only usages request with resolved bearer auth", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));

    await fetchKimiQuotaSnapshot(kimiDeps({ fetchFn }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.Authorization, "Bearer kimi-test-token");
    assert.equal(calls[0].headers.Accept, "application/json");
  });
});

describe("kimi adapter: remaining values and partial payloads", () => {
  it("prefers validated provider remaining data over limit-minus-used", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.usage.used = "50";
    payload.usage.remaining = "800";

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0].remainingPercent, 80);
  });

  it("derives and clamps remaining from validated limit and used values", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.usage as Record<string, unknown>).remaining;
    payload.usage.limit = "100";
    payload.usage.used = "30";
    delete (payload.limits[0].detail as Record<string, unknown>).remaining;
    payload.limits[0].detail.limit = "100";
    payload.limits[0].detail.used = "150";

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0].remainingPercent, 70);
    assert.equal(snapshot.windows[1].remainingPercent, 0);
  });

  it("clamps provider remaining safely to the validated limit", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.usage.limit = "100";
    payload.usage.remaining = "250";

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0].remainingPercent, 100);
  });

  it("drops invalid rows while preserving validated shorter windows", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.usage.limit = "not-a-counter";
    payload.limits[0].detail.resetTime = "not-a-timestamp";

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.deepEqual(snapshot.windows, [
      {
        id: "kimi-limit-18000",
        label: "5h",
        remainingPercent: 60,
        durationSeconds: 18000,
      },
    ]);
  });

  it("accepts only ISO-shaped reset timestamps, including the Unix epoch", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.usage.resetTime = "1";
    payload.limits[0].detail.resetTime = "1970-01-01T00:00:00.000Z";

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal("resetAtSeconds" in snapshot.windows[0], false);
    assert.equal(snapshot.windows[1].resetAtSeconds, 0);
  });

  it("keeps shorter-window identifiers stable when unrelated rows are inserted", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.limits.unshift({
      window: { duration: -1, timeUnit: "TIME_UNIT_HOUR" },
      detail: { limit: "100", used: "20", remaining: "80", resetTime: FIVE_HOUR_RESET },
    });

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[1].id, "kimi-limit-18000");
  });

  it("drops malformed or non-shorter limit windows", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.limits.push(
      {
        window: { duration: -1, timeUnit: "TIME_UNIT_HOUR" },
        detail: { limit: "100", used: "20", remaining: "80", resetTime: FIVE_HOUR_RESET },
      },
      {
        window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
        detail: { limit: "100", used: "20", remaining: "80", resetTime: WEEKLY_RESET },
      },
    );

    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows.length, 2);
  });
});

function failingFetch() {
  return stubFetch(() => {
    throw new Error("fetch must not be called");
  });
}

describe("kimi adapter: authentication and origin", () => {
  it("resolves credentials at fetch time and never stores them", async () => {
    let resolutions = 0;
    const resolveAuth = async () => {
      resolutions += 1;
      return {
        headers: { authorization: "Bearer fresh-token" },
        baseUrl: "https://api.kimi.com/coding",
      };
    };

    await fetchKimiQuotaSnapshot(kimiDeps({ resolveAuth }));
    await fetchKimiQuotaSnapshot(kimiDeps({ resolveAuth }));

    assert.equal(resolutions, 2);
  });

  it("accepts case-insensitive resolved authorization headers", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const resolveAuth = async () => ({
      headers: { authorization: "Bearer oauth-token" },
      baseUrl: "https://api.kimi.com/coding",
    });

    await fetchKimiQuotaSnapshot(kimiDeps({ resolveAuth, fetchFn }));

    assert.equal(calls[0].headers.Authorization, "Bearer oauth-token");
  });

  it("falls back to a resolved Kimi API key as bearer auth", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const resolveAuth = async () => ({
      apiKey: "kimi-api-key",
      baseUrl: "https://api.kimi.com/coding",
    });

    await fetchKimiQuotaSnapshot(kimiDeps({ resolveAuth, fetchFn }));

    assert.equal(calls[0].headers.Authorization, "Bearer kimi-api-key");
  });

  it("returns auth-unavailable without calling the endpoint when auth cannot resolve", async () => {
    const { fetchFn, calls } = failingFetch();
    const missing = await fetchKimiQuotaSnapshot(kimiDeps({ resolveAuth: async () => undefined, fetchFn }));
    const noCredential = await fetchKimiQuotaSnapshot(
      kimiDeps({ resolveAuth: async () => ({ baseUrl: "https://api.kimi.com/coding" }), fetchFn }),
    );
    const rejected = await fetchKimiQuotaSnapshot(
      kimiDeps({
        resolveAuth: async () => {
          throw new Error("credential storage unavailable");
        },
        fetchFn,
      }),
    );

    assertUnavailable(missing, "auth-unavailable");
    assertUnavailable(noCredential, "auth-unavailable");
    assertUnavailable(rejected, "auth-unavailable");
    assert.equal(calls.length, 0);
  });

  it("refuses to send credentials to a non-Kimi origin", async () => {
    const { fetchFn, calls } = failingFetch();
    const resolveAuth = async () => ({
      headers: { Authorization: "Bearer kimi-token" },
      baseUrl: "https://api.moonshot.cn/v1",
    });

    const snapshot = await fetchKimiQuotaSnapshot(kimiDeps({ resolveAuth, fetchFn }));

    assertUnavailable(snapshot, "unsupported");
    assert.equal(calls.length, 0);
  });
});

describe("kimi adapter: malformed and unavailable responses", () => {
  it("returns schema-drift when no quota window validates", async () => {
    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({
        fetchFn: stubFetch(() =>
          jsonResponse(200, {
            usage: { limit: "?", used: "?" },
            limits: [{ window: null, detail: null }],
          }),
        ).fetchFn,
      }),
    );

    assertUnavailable(snapshot, "schema-drift");
  });

  it("returns schema-drift for a non-object or non-JSON response", async () => {
    const nonObject = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(200, [])).fetchFn }),
    );
    const nonJson = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => new Response("<html>", { status: 200 })).fetchFn }),
    );

    assertUnavailable(nonObject, "schema-drift");
    assertUnavailable(nonJson, "schema-drift");
  });

  it("maps 401 to auth-required and ambiguous 403 to ambiguous", async () => {
    const unauthorized = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(401, {})).fetchFn }),
    );
    const forbidden = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(403, {})).fetchFn }),
    );

    assertUnavailable(unauthorized, "auth-required");
    assertUnavailable(forbidden, "ambiguous");
  });

  it("maps 404 to unsupported", async () => {
    const snapshot = await fetchKimiQuotaSnapshot(
      kimiDeps({ fetchFn: stubFetch(() => jsonResponse(404, {})).fetchFn }),
    );
    assertUnavailable(snapshot, "unsupported");
  });

  it("maps 429, 5xx, and network failures to transient", async () => {
    for (const status of [429, 500, 503]) {
      const snapshot = await fetchKimiQuotaSnapshot(
        kimiDeps({ fetchFn: stubFetch(() => jsonResponse(status, {})).fetchFn }),
      );
      assertUnavailable(snapshot, "transient");
    }

    const network = await fetchKimiQuotaSnapshot(
      kimiDeps({
        fetchFn: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    );
    assertUnavailable(network, "transient");
  });
});
