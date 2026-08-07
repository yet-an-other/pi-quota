import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchZaiQuotaSnapshot } from "../src/providers/zai.ts";
import {
  assertUnavailable,
  NOW,
  stubFetch,
  VALID_PAYLOAD,
  jsonResponse,
  zaiDeps,
} from "./zai-fixtures.ts";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const SOURCE = {
  kind: "first-party-private",
  detailUrl: "https://z.ai/manage-apikey/subscription",
  fetchedAtSeconds: NOW,
} as const;

describe("Z.AI adapter: validated windows", () => {
  it("normalizes the monitor payload into validated quota windows", async () => {
    const snapshot = await fetchZaiQuotaSnapshot(zaiDeps());

    assert.deepEqual(snapshot, {
      status: "available",
      provider: "zai",
      windows: [
        {
          id: `zai-CREDIT_LIMIT-3-5-${(NOW + 4 * HOUR) * 1000}`,
          label: "5h",
          remainingPercent: 86,
          durationSeconds: 5 * HOUR,
          resetAtSeconds: NOW + 4 * HOUR,
        },
        {
          id: `zai-CREDIT_LIMIT-6-1-${(NOW + 6 * DAY) * 1000}`,
          label: "7d",
          remainingPercent: 88,
          durationSeconds: 7 * DAY,
          resetAtSeconds: NOW + 6 * DAY,
        },
      ],
      source: SOURCE,
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

describe("Z.AI adapter: remaining-percent derivation", () => {
  it("derives remaining percent as 100 minus the used percentage", async () => {
    const payload = {
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 16 }] },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0]!.remainingPercent, 84);
  });

  it("falls back to currentValue / usage when percentage is absent", async () => {
    const payload = {
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            usage: 1000,
            currentValue: 250,
            nextResetTime: (NOW + HOUR) * 1000,
          },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.deepEqual(snapshot.windows[0]!.remainingPercent, 75);
  });
});

describe("Z.AI adapter: reset-time plausibility", () => {
  it("keeps a reset time that is a plausible future", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 50, nextResetTime: (NOW + 2 * HOUR) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0]!.resetAtSeconds, NOW + 2 * HOUR);
  });

  it("drops a reset time that is not a future timestamp", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 50, nextResetTime: (NOW - HOUR) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0]!.resetAtSeconds, undefined);
  });

  it("drops a reset time beyond the plausible horizon", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 50, nextResetTime: (NOW + 365 * DAY) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0]!.resetAtSeconds, undefined);
  });
});

describe("Z.AI adapter: window duration and labels", () => {
  it("derives duration and a formatter label for first-party-confirmed unit codes", async () => {
    const payload = {
      data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 45 }] },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.deepEqual(snapshot.windows[0], {
      id: "zai-TIME_LIMIT-5-1-?",
      label: "30d",
      remainingPercent: 55,
      durationSeconds: 30 * DAY,
    });
  });

  it("omits duration and uses a type-based label for unknown unit codes", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 9, number: 1, percentage: 20, nextResetTime: (NOW + 6 * DAY) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.deepEqual(snapshot.windows[0], {
      id: `zai-TOKENS_LIMIT-9-1-${(NOW + 6 * DAY) * 1000}`,
      label: "tokens",
      remainingPercent: 80,
      resetAtSeconds: NOW + 6 * DAY,
    });
  });
});

describe("Z.AI adapter: duplicate windows", () => {
  it("accepts two same-type windows keyed apart by unit and number", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 16, nextResetTime: (NOW + HOUR) * 1000 },
          { type: "TOKENS_LIMIT", unit: 6, number: 7, percentage: 20, nextResetTime: (NOW + DAY) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows.length, 2);
    assert.deepEqual(
      snapshot.windows.map((quotaWindow) => quotaWindow.id),
      [
        `zai-TOKENS_LIMIT-3-5-${(NOW + HOUR) * 1000}`,
        `zai-TOKENS_LIMIT-6-7-${(NOW + DAY) * 1000}`,
      ],
    );
  });

  it("dedupes windows that share an identical identifier", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 16 },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 18 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows.length, 1);
    assert.equal(snapshot.windows[0]!.remainingPercent, 84);
  });

  it("keeps same-type/unit/number windows apart when their reset times differ", async () => {
    const payload = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 16, nextResetTime: (NOW + HOUR) * 1000 },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20, nextResetTime: (NOW + 2 * HOUR) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows.length, 2);
    assert.deepEqual(
      snapshot.windows.map((quotaWindow) => quotaWindow.id),
      [
        `zai-TOKENS_LIMIT-3-5-${(NOW + HOUR) * 1000}`,
        `zai-TOKENS_LIMIT-3-5-${(NOW + 2 * HOUR) * 1000}`,
      ],
    );
  });
});

describe("Z.AI adapter: schema validation", () => {
  it("accepts any limit type with valid quota values and drops only unparseable entries", async () => {
    const payload = {
      data: {
        limits: [
          { type: "NEW_LIMIT", percentage: 91 },
          { type: "TOKENS_LIMIT", percentage: "61", usage: -1 },
          { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 25, usage: 4000, currentValue: 1000, nextResetTime: (NOW + DAY) * 1000 },
        ],
      },
    };
    const snapshot = await fetchZaiQuotaSnapshot(
      zaiDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.deepEqual(snapshot.windows, [
      { id: "zai-NEW_LIMIT-?-?-?", label: "new", remainingPercent: 9 },
      {
        id: `zai-TIME_LIMIT-5-1-${(NOW + DAY) * 1000}`,
        label: "30d",
        remainingPercent: 75,
        durationSeconds: 30 * DAY,
        resetAtSeconds: NOW + DAY,
      },
    ]);
  });

  it("returns schema-drift when no window validates", async () => {
    for (const payload of [
      {},
      { data: {} },
      { data: { limits: "not-an-array" } },
      { data: { limits: [{ type: "TOKENS_LIMIT", percentage: "unknown" }] } },
      { data: { limits: [{ type: "UNKNOWN", usage: -1 }] } },
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

  it("maps monitor authentication rejections to auth-required without retrying another format", async () => {
    for (const status of [401, 403]) {
      const { fetchFn, calls } = stubFetch(() => jsonResponse(status, {}));
      const snapshot = await fetchZaiQuotaSnapshot(zaiDeps({ fetchFn }));

      assertUnavailable(snapshot, "auth-required");
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
