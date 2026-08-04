import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchCodexQuotaSnapshot } from "../src/providers/codex.ts";
import {
  assertUnavailable,
  codexDeps,
  fakeJwt,
  jsonResponse,
  stubFetch,
  VALID_PAYLOAD,
  VALID_TOKEN,
  NOW,
  type FetchCall,
} from "./codex-fixtures.ts";

describe("codex adapter: valid payload", () => {
  it("returns an available snapshot with validated primary and secondary quota windows", async () => {
    const snapshot = await fetchCodexQuotaSnapshot(codexDeps());

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;

    assert.equal(snapshot.provider, "openai-codex");
    assert.deepEqual(snapshot.windows, [
      {
        id: "codex-primary",
        label: "5h",
        remainingPercent: 58,
        durationSeconds: 18000,
        resetAtSeconds: NOW + 720,
        blocked: false,
      },
      {
        id: "codex-secondary",
        label: "7d",
        remainingPercent: 95,
        durationSeconds: 604800,
        resetAtSeconds: NOW + 432000,
        blocked: false,
      },
    ]);
    assert.equal(snapshot.source.kind, "first-party-private");
  });
});

describe("codex adapter: partial and malformed payloads", () => {
  it("falls back to the relative reset duration when reset_at is missing", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.rate_limit.primary_window as Record<string, unknown>).reset_at;

    const snapshot = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0].resetAtSeconds, NOW + 120);
  });

  it("drops invalid windows and keeps missing values unknown", async () => {
    const payload = {
      rate_limit: {
        allowed: true,
        limit_reached: true,
        primary_window: {
          used_percent: 42,
          limit_window_seconds: "five hours",
          reset_at: -1,
          reset_after_seconds: "soon",
        },
        secondary_window: { used_percent: "5" },
      },
    };

    const snapshot = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.deepEqual(snapshot.windows, [
      {
        id: "codex-primary",
        label: "primary",
        remainingPercent: 58,
        blocked: true,
      },
    ]);
  });

  it("clamps out-of-range consumed percent instead of failing", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.rate_limit.primary_window.used_percent = 150;

    const snapshot = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assert.equal(snapshot.status, "available");
    if (snapshot.status !== "available") return;
    assert.equal(snapshot.windows[0].remainingPercent, 0);
  });

  it("returns schema-drift when no window validates", async () => {
    const payload = { rate_limit: { primary_window: { used_percent: "n/a" } } };

    const snapshot = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => jsonResponse(200, payload)).fetchFn }),
    );

    assertUnavailable(snapshot, "schema-drift");
  });

  it("returns schema-drift when rate_limit is missing or the body is not JSON", async () => {
    const noRateLimit = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => jsonResponse(200, { plan_type: "plus" })).fetchFn }),
    );
    assertUnavailable(noRateLimit, "schema-drift");

    const notJson = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => new Response("<html>", { status: 200 })).fetchFn }),
    );
    assertUnavailable(notJson, "schema-drift");
  });
});


function failingFetch(): { fetchFn: typeof fetch; calls: FetchCall[] } {
  return stubFetch(() => {
    throw new Error("fetch must not be called");
  });
}

describe("codex adapter: authentication and origin", () => {
  it("sends the bearer token and derived account id only to the ChatGPT backend origin", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));

    await fetchCodexQuotaSnapshot(codexDeps({ fetchFn }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(calls[0].headers.Authorization, `Bearer ${VALID_TOKEN}`);
    assert.equal(calls[0].headers["ChatGPT-Account-ID"], "acct-123");
  });

  it("resolves credentials at fetch time and never stores them", async () => {
    let resolutions = 0;
    const resolveAuth = async () => {
      resolutions += 1;
      return { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" };
    };

    await fetchCodexQuotaSnapshot(codexDeps({ resolveAuth }));
    await fetchCodexQuotaSnapshot(codexDeps({ resolveAuth }));

    assert.equal(resolutions, 2);
  });

  it("returns auth-unavailable when Pi cannot resolve a credential", async () => {
    const { fetchFn, calls } = failingFetch();

    const missing = await fetchCodexQuotaSnapshot(codexDeps({ resolveAuth: async () => undefined, fetchFn }));
    const noKey = await fetchCodexQuotaSnapshot(
      codexDeps({ resolveAuth: async () => ({ baseUrl: "https://chatgpt.com/backend-api" }), fetchFn }),
    );
    const rejected = await fetchCodexQuotaSnapshot(
      codexDeps({
        resolveAuth: async () => {
          throw new Error("storage failure");
        },
        fetchFn,
      }),
    );

    assertUnavailable(missing, "auth-unavailable");
    assertUnavailable(noKey, "auth-unavailable");
    assertUnavailable(rejected, "auth-unavailable");
    assert.equal(calls.length, 0);
  });

  it("returns auth-unavailable when the account id cannot be derived locally", async () => {
    const { fetchFn, calls } = failingFetch();
    const resolveAuth = async () => ({
      apiKey: fakeJwt({ sub: "user-1" }),
      baseUrl: "https://chatgpt.com/backend-api",
    });

    assertUnavailable(await fetchCodexQuotaSnapshot(codexDeps({ resolveAuth, fetchFn })), "auth-unavailable");

    const notJwt = async () => ({ apiKey: "sk-not-a-jwt", baseUrl: "https://chatgpt.com/backend-api" });
    assertUnavailable(await fetchCodexQuotaSnapshot(codexDeps({ resolveAuth: notJwt, fetchFn })), "auth-unavailable");
    assert.equal(calls.length, 0);
  });

  it("refuses to send credentials to a non-ChatGPT origin", async () => {
    const { fetchFn, calls } = failingFetch();
    const resolveAuth = async () => ({
      apiKey: VALID_TOKEN,
      baseUrl: "https://evil.example.com/backend-api",
    });

    assertUnavailable(await fetchCodexQuotaSnapshot(codexDeps({ resolveAuth, fetchFn })), "unsupported");
    assert.equal(calls.length, 0);
  });
});

describe("codex adapter: http and network failures", () => {
  it("maps 401 and 403 to auth-required", async () => {
    for (const status of [401, 403]) {
      const snapshot = await fetchCodexQuotaSnapshot(
        codexDeps({ fetchFn: stubFetch(() => jsonResponse(status, {})).fetchFn }),
      );
      assertUnavailable(snapshot, "auth-required");
    }
  });

  it("maps 404 to unsupported", async () => {
    const snapshot = await fetchCodexQuotaSnapshot(
      codexDeps({ fetchFn: stubFetch(() => jsonResponse(404, {})).fetchFn }),
    );
    assertUnavailable(snapshot, "unsupported");
  });

  it("maps 429 and 5xx to transient", async () => {
    for (const status of [429, 500, 503]) {
      const snapshot = await fetchCodexQuotaSnapshot(
        codexDeps({ fetchFn: stubFetch(() => jsonResponse(status, {})).fetchFn }),
      );
      assertUnavailable(snapshot, "transient");
    }
  });

  it("maps network failures to transient", async () => {
    const snapshot = await fetchCodexQuotaSnapshot(
      codexDeps({
        fetchFn: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      }),
    );
    assertUnavailable(snapshot, "transient");
  });
});
