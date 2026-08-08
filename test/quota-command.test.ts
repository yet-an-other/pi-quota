import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { VALID_PAYLOAD as CODEX_PAYLOAD, VALID_TOKEN, NOW } from "./codex-fixtures.ts";
import { VALID_PAYLOAD as KIMI_PAYLOAD } from "./kimi-fixtures.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { VALID_PAYLOAD as ZAI_PAYLOAD } from "./zai-fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function responseFor(url: string): Response {
  const body = url.includes("wham/usage")
    ? CODEX_PAYLOAD
    : url.includes("coding/v1/usages")
      ? KIMI_PAYLOAD
      : ZAI_PAYLOAD;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function captureConsole(run: () => Promise<void>): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const originals = Object.fromEntries(methods.map((method) => [method, console[method]])) as
    Record<(typeof methods)[number], typeof console.log>;

  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      calls.push(args);
    };
  }
  try {
    await run();
  } finally {
    for (const method of methods) console[method] = originals[method];
  }
  return calls;
}

describe("quota detail command", () => {
  it("shows all providers, marks the active provider, lazily fetches missing data, and reuses it", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, themeCalls, notifications, customViews } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    const consoleCalls = await captureConsole(async () => {
      await host.emit("session_start", { reason: "startup" }, ctx);
      const footerCallsAfterStartup = statusCalls.length;
      await host.runCommand("quota", "", ctx);

      assert.equal(urls.length, 3);
      assert.equal(statusCalls.length, footerCallsAfterStartup);
      const details = customViews.at(-1)?.join("\n") ?? "";
      assert.match(details, /OpenAI Codex \(active\)/u);
      assert.match(details, /Kimi For Coding/u);
      assert.match(details, /Z\.AI/u);
      assert.match(details, /5h: 58% remaining/u);
      assert.match(details, /7d: 88% remaining/u);

      await host.runCommand("quota", "", ctx);
      assert.equal(urls.length, 3);
    });

    const observableOutput = JSON.stringify({
      consoleCalls,
      statusCalls,
      themeCalls,
      notifications,
      customViews,
      persistedEntries: host.persistedEntries(),
    });
    assert.doesNotMatch(
      observableOutput,
      new RegExp(`${VALID_TOKEN}|kimi-test-token|zai-test-key|acct-123|Authorization`, "iu"),
    );
    assert.deepEqual(host.persistedEntries(), []);
  });

  it("starts missing provider lookups in parallel", async () => {
    const kimi = deferred<Response>();
    const zai = deferred<Response>();
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("wham/usage")) return responseFor(url);
      return url.includes("coding/v1/usages") ? kimi.promise : zai.promise;
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const details = host.runCommand("quota", "", ctx);
    await host.flush();

    assert.equal(urls.filter((url) => url.includes("coding/v1/usages")).length, 1);
    assert.equal(urls.filter((url) => url.includes("monitor/usage/quota/limit")).length, 1);

    kimi.resolve(responseFor("coding/v1/usages"));
    zai.resolve(responseFor("monitor/usage/quota/limit"));
    await details;
  });

  it("stays hidden in non-TUI modes", async () => {
    for (const mode of ["print", "json", "rpc"]) {
      let fetches = 0;
      const host = createExtensionHost();
      registerExtension(host.api, {
        fetchFn: (async () => {
          fetches += 1;
          return responseFor("wham/usage");
        }) as typeof fetch,
        nowSeconds: () => NOW,
      });
      const { ctx, customViews, notifications } = createContext({ mode });

      await host.runCommand("quota", "", ctx);
      await host.runCommand("quota", "refresh", ctx);
      await host.runCommand("quota", "refresh all", ctx);

      assert.equal(fetches, 0);
      assert.deepEqual(customViews, []);
      assert.deepEqual(notifications, []);
    }
  });
});

describe("quota refresh all command", () => {
  it("force-refreshes every registry provider concurrently and reports the available count", async () => {
    const kimi = deferred<Response>();
    const zai = deferred<Response>();
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("coding/v1/usages")) return kimi.promise;
      if (url.includes("monitor/usage/quota/limit")) return zai.promise;
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const refreshAll = host.runCommand("quota", "refresh all", ctx);
    await host.flush();

    assert.equal(urls.filter((url) => url.includes("coding/v1/usages")).length, 1);
    assert.equal(urls.filter((url) => url.includes("monitor/usage/quota/limit")).length, 1);

    kimi.resolve(responseFor("coding/v1/usages"));
    zai.resolve(responseFor("monitor/usage/quota/limit"));
    await refreshAll;

    assert.equal(urls.filter((url) => url.includes("wham/usage")).length, 2);
    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 3/3 providers available", type: "info" },
    ]);
    assert.deepEqual(host.persistedEntries(), []);
    assert.doesNotMatch(
      JSON.stringify(notifications),
      new RegExp(`${VALID_TOKEN}|kimi-test-token|zai-test-key`, "iu"),
    );
  });

  it("counts unauthenticated providers as refreshed but not available", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.runCommand("quota", "refresh all", ctx);

    assert.equal(urls.some((url) => url.includes("monitor/usage/quota/limit")), false);
    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 2/3 providers available", type: "info" },
    ]);
  });

  it("updates the footer only for the active provider", async () => {
    const fetchFn = (async (input: unknown) => responseFor(String(input))) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const footerCallsAfterStartup = statusCalls.length;
    await host.runCommand("quota", "refresh all", ctx);

    assert.equal(statusCalls.length, footerCallsAfterStartup + 1);
    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h: 58%/u);
    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 3/3 providers available", type: "info" },
    ]);
  });

  it("refreshes every registry provider when the active provider is unsupported", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, notifications } = createContext({
      provider: "anthropic",
      modelBaseUrl: "https://api.anthropic.com",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(urls.length, 0);
    const statusCallsAfterStartup = statusCalls.length;
    await host.runCommand("quota", "refresh all", ctx);

    assert.equal(urls.filter((url) => url.includes("wham/usage")).length, 1);
    assert.equal(urls.filter((url) => url.includes("coding/v1/usages")).length, 1);
    assert.equal(urls.filter((url) => url.includes("monitor/usage/quota/limit")).length, 1);
    assert.equal(statusCalls.length, statusCallsAfterStartup);
    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 3/3 providers available", type: "info" },
    ]);
  });

  it("bypasses failure backoff with a forced per-provider refresh", async () => {
    let codexFetches = 0;
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("wham/usage")) {
        codexFetches += 1;
        if (codexFetches === 1) return new Response("upstream secret body", { status: 503 });
      }
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(codexFetches, 1);
    await host.runCommand("quota", "refresh all", ctx);

    assert.equal(codexFetches, 2);
    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 3/3 providers available", type: "info" },
    ]);
  });

  it("coalesces a per-provider in-flight refresh instead of duplicating the fetch", async () => {
    const codex = deferred<Response>();
    let codexFetches = 0;
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("wham/usage")) {
        codexFetches += 1;
        return codex.promise;
      }
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const refreshAll = host.runCommand("quota", "refresh all", ctx);
    await host.flush();

    assert.equal(codexFetches, 1);
    assert.deepEqual(notifications, []);

    codex.resolve(responseFor("wham/usage"));
    await refreshAll;

    assert.equal(codexFetches, 1);
    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 3/3 providers available", type: "info" },
    ]);
  });

  it("counts a transient failure as refreshed but not available, without leaking details", async () => {
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("coding/v1/usages")) {
        return new Response("upstream secret body", { status: 503 });
      }
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, themeCalls, notifications, customViews } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      providerBaseUrls: {
        "openai-codex": "https://chatgpt.com/backend-api",
        "kimi-coding": "https://api.kimi.com/coding",
        zai: "https://api.z.ai/api/coding/paas/v4",
      },
      authByProvider: {
        "openai-codex": { apiKey: VALID_TOKEN },
        "kimi-coding": { headers: { Authorization: "Bearer kimi-test-token" } },
        zai: { apiKey: "zai-test-key" },
      },
    });

    const consoleCalls = await captureConsole(async () => {
      await host.emit("session_start", { reason: "startup" }, ctx);
      await host.runCommand("quota", "refresh all", ctx);
    });

    assert.deepEqual(notifications, [
      { message: "Quota refreshed · 2/3 providers available", type: "info" },
    ]);
    const observableOutput = JSON.stringify({
      consoleCalls,
      statusCalls,
      themeCalls,
      notifications,
      customViews,
      persistedEntries: host.persistedEntries(),
    });
    assert.doesNotMatch(
      observableOutput,
      /secret|upstream|kimi-test-token|zai-test-key|acct-123|api\.kimi\.com|api\.z\.ai|Authorization/iu,
    );
    assert.doesNotMatch(observableOutput, new RegExp(VALID_TOKEN, "iu"));
    assert.deepEqual(host.persistedEntries(), []);
  });

  it("warns on unknown arguments and refreshes nothing", async () => {
    let fetches = 0;
    const fetchFn = (async (input: unknown) => {
      fetches += 1;
      return responseFor(String(input));
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const fetchesAfterStartup = fetches;
    await host.runCommand("quota", "refresh everything", ctx);
    await host.runCommand("quota", "all", ctx);

    assert.equal(fetches, fetchesAfterStartup);
    assert.deepEqual(notifications, [
      { message: "Usage: /quota [refresh|refresh all]", type: "warning" },
      { message: "Usage: /quota [refresh|refresh all]", type: "warning" },
    ]);
  });
});

describe("quota manual refresh command", () => {
  it("forces a refresh without changing the footer while pending and reports success", async () => {
    const pending = deferred<Response>();
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      return fetches === 1 ? responseFor("wham/usage") : pending.promise;
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const footerCallsAfterStartup = statusCalls.length;
    const refresh = host.runCommand("quota", "refresh", ctx);
    await host.flush();

    assert.equal(fetches, 2);
    assert.equal(statusCalls.length, footerCallsAfterStartup);
    assert.deepEqual(notifications, []);

    pending.resolve(responseFor("wham/usage"));
    await refresh;

    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h: 58%/u);
    assert.deepEqual(notifications, [{ message: "Quota refreshed", type: "info" }]);
  });

  it("coalesces with an in-flight automatic refresh", async () => {
    const pending = deferred<Response>();
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      return pending.promise;
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    const refresh = host.runCommand("quota", "refresh", ctx);
    await host.flush();
    assert.equal(fetches, 1);

    pending.resolve(responseFor("wham/usage"));
    await refresh;
    assert.deepEqual(notifications, [{ message: "Quota refreshed", type: "info" }]);
  });

  it("degrades silently without fetching when the active provider is unsupported", async () => {
    let fetches = 0;
    const host = createExtensionHost();
    registerExtension(host.api, {
      fetchFn: (async () => {
        fetches += 1;
        return responseFor("wham/usage");
      }) as typeof fetch,
      nowSeconds: () => NOW,
    });
    const { ctx, notifications } = createContext({
      provider: "anthropic",
      modelBaseUrl: "https://api.anthropic.com",
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.runCommand("quota", "refresh", ctx);

    assert.equal(fetches, 0);
    assert.deepEqual(notifications, []);
  });

  it("reports a sanitized failure when the provider refresh is unavailable", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      return fetches === 1
        ? responseFor("wham/usage")
        : new Response("upstream secret body", { status: 503 });
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, notifications } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.runCommand("quota", "refresh", ctx);

    assert.deepEqual(notifications, [{ message: "Quota refresh failed", type: "warning" }]);
    assert.doesNotMatch(notifications[0]!.message, /secret|upstream/iu);
  });
});
