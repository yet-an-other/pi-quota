import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchZaiQuotaSnapshot } from "../src/providers/zai.ts";
import { assertUnavailable, NOW, stubFetch, VALID_PAYLOAD, jsonResponse, zaiDeps } from "./zai-fixtures.ts";

describe("Z.AI adapter: validated telemetry", () => {
  it("normalizes known monitor metrics only as unknown-semantics quota telemetry", async () => {
    const snapshot = await fetchZaiQuotaSnapshot(zaiDeps());

    assert.equal(snapshot.status, "degraded");
    if (snapshot.status !== "degraded") return;

    assert.equal(snapshot.provider, "zai");
    assert.deepEqual(snapshot.telemetry, [
      {
        id: "zai-tokens-limit",
        providerLabel: "Z.AI token telemetry",
        percent: 61,
        semantics: "unknown",
      },
      {
        id: "zai-time-limit",
        providerLabel: "Z.AI time telemetry",
        percent: 25,
        counters: { currentValue: 7, usage: 3 },
        semantics: "unknown",
      },
    ]);
    assert.deepEqual(snapshot.source, {
      kind: "first-party-private",
      detailUrl: "https://z.ai/manage-apikey/subscription",
      fetchedAtSeconds: NOW,
    });
  });

  it("makes one read-only no-redirect monitor request with the resolved key verbatim", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));

    await fetchZaiQuotaSnapshot(zaiDeps({ fetchFn }));

    assert.deepEqual(calls, [
      {
        url: "https://api.z.ai/api/monitor/usage/quota/limit",
        method: "GET",
        headers: {
          Authorization: "zai-test-key",
          "Accept-Language": "en-US,en",
          "Content-Type": "application/json",
        },
        redirect: "error",
      },
    ]);
  });
});

describe("Z.AI adapter: schema validation", () => {
  it("ignores unknown types and invalid fields while preserving validated opaque telemetry", async () => {
    const payload = {
      data: {
        limits: [
          { type: "NEW_LIMIT", percentage: 91 },
          { type: "TOKENS_LIMIT", percentage: "61", usage: -1 },
          { type: "TIME_LIMIT", percentage: 25, currentValue: Number.NaN, usage: 3 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "degraded");
    if (snapshot.status !== "degraded") return;
    assert.deepEqual(snapshot.telemetry, [
      {
        id: "zai-time-limit",
        providerLabel: "Z.AI time telemetry",
        percent: 25,
        counters: { usage: 3 },
        semantics: "unknown",
      },
    ]);
  });

  it("returns schema-drift when no telemetry validates", async () => {
    for (const payload of [
      {},
      { data: {} },
      { data: { limits: "not-an-array" } },
      { data: { limits: [{ type: "TOKENS_LIMIT", percentage: "unknown" }] } },
      { data: { limits: [{ type: "UNKNOWN", percentage: 42 }] } },
    ]) {
      const snapshot = await fetchZaiQuotaSnapshot(
        zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
      );
      assertUnavailable(snapshot, "schema-drift");
    }

    const nonJson = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => new Response("<html>", { status: 200 })).fetchFn }),
    );
    assertUnavailable(nonJson, "schema-drift");
  });

  it("fails closed when duplicate known types have indistinguishable semantics", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 61 },
          { type: "TOKENS_LIMIT", percentage: 18 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assertUnavailable(snapshot, "ambiguous");
  });
});

describe("Z.AI adapter: provider origin", () => {
  it("verifies the global provider origin before resolving or sending credentials", async () => {
    let resolutions = 0;
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const resolveAuth = async () => {
      resolutions += 1;
      return { apiKey: "must-not-leak" };
    };

    for (const providerBaseUrl of [
      "https://open.bigmodel.cn/api/coding/paas/v4",
      "https://evil.example.com/zai",
      "not a URL",
      undefined,
    ]) {
      const snapshot = await fetchZaiQuotaSnapshot(
        zaiDeps({ providerBaseUrl, resolveAuth, fetchFn }),
      );
      assertUnavailable(snapshot, "unsupported");
    }

    assert.equal(resolutions, 0);
    assert.equal(calls.length, 0);
  });

  it("rejects a mismatched auth-specific origin before sending credentials", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({
        resolveAuth: async () => ({
          apiKey: "must-not-leak",
          baseUrl: "https://evil.example.com/zai",
        }),
        fetchFn,
      }),
    );

    assertUnavailable(snapshot, "unsupported");
    assert.equal(calls.length, 0);
  });
});

describe("Z.AI adapter: authentication", () => {
  it("resolves the global credential for every fetch and never stores it", async () => {
    let resolutions = 0;
    const resolveAuth = async () => {
      resolutions += 1;
      return { apiKey: `fresh-key-${resolutions}` };
    };

    await fetchZaiQuotaSnapshot(zaiDeps({ resolveAuth }));
    await fetchZaiQuotaSnapshot(zaiDeps({ resolveAuth }));

    assert.equal(resolutions, 2);
  });

  it("returns auth-unavailable when Pi cannot resolve a raw global API key", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const resolvers = [
      async () => undefined,
      async () => ({}),
      async () => ({ apiKey: "   " }),
      async () => {
        throw new Error("credential storage unavailable");
      },
    ];

    for (const resolveAuth of resolvers) {
      const snapshot = await fetchZaiQuotaSnapshot(zaiDeps({ resolveAuth, fetchFn }));
      assertUnavailable(snapshot, "auth-unavailable");
    }
    assert.equal(calls.length, 0);
  });

  it("fails closed when resolved auth has an ambiguous authorization shape", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({
        resolveAuth: async () => ({
          apiKey: "zai-test-key",
          headers: { Authorization: "Bearer another-token" },
        }),
        fetchFn,
      }),
    );

    assertUnavailable(snapshot, "ambiguous");
    assert.equal(calls.length, 0);
  });

  it("rejects a resolved authorization header because the monitor credential format is ambiguous", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({
        resolveAuth: async () => ({ headers: { authorization: "Bearer zai-test-key" } }),
        fetchFn,
      }),
    );

    assertUnavailable(snapshot, "ambiguous");
    assert.equal(calls.length, 0);
  });

  it("treats monitor authentication responses as ambiguous without retrying another format", async () => {
    for (const status of [401, 403]) {
      const { fetchFn, calls } = stubFetch(() => jsonResponse(status, {}));
      const snapshot = await fetchZaiQuotaSnapshot(zaiDeps({ fetchFn }));

      assertUnavailable(snapshot, "ambiguous");
      assert.equal(calls.length, 1);
    }
  });
});

describe("Z.AI adapter: unavailable monitor behavior", () => {
  it("maps unsupported, transient HTTP, and network behavior to sanitized snapshots", async () => {
    const unsupported = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(404, {})).fetchFn }),
    );
    assertUnavailable(unsupported, "unsupported");

    for (const status of [429, 500, 503]) {
      const snapshot = await fetchZaiQuotaSnapshot(
        zaiDeps({ fetchFn: stubFetch(() => jsonResponse(status, {})).fetchFn }),
      );
      assertUnavailable(snapshot, "transient");
    }

    const network = await fetchZaiQuotaSnapshot(
      zaiDeps({
        fetchFn: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    );
    assertUnavailable(network, "transient");
  });
});
