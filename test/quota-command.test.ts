import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { VALID_PAYLOAD as CODEX_PAYLOAD, VALID_TOKEN, NOW } from "./codex-fixtures.ts";
import { VALID_PAYLOAD as KIMI_PAYLOAD } from "./kimi-fixtures.ts";
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

function contextOptions(provider = "openai-codex") {
  return {
    provider,
    modelBaseUrl: provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : provider === "anthropic"
        ? "https://api.anthropic.com"
        : undefined,
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
  } as const;
}

describe("/quota command", () => {
  it("refreshes every provider on every invocation before showing details", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, notifications, customViews } = createContext(contextOptions());

    const consoleCalls = await captureConsole(async () => {
      await host.emit("session_start", { reason: "startup" }, ctx);
      const statusCallsAfterStartup = statusCalls.length;

      await host.runCommand("quota", "", ctx);
      assert.equal(urls.length, 4);
      assert.equal(statusCalls.length, statusCallsAfterStartup + 1);
      assert.match(customViews.at(-1)?.join("\n") ?? "", /OpenAI Codex \(active\)/u);
      assert.match(customViews.at(-1)?.join("\n") ?? "", /5h: 58% remaining/u);
      assert.match(customViews.at(-1)?.join("\n") ?? "", /7d: 88% remaining/u);

      await host.runCommand("quota", "", ctx);
      assert.equal(urls.length, 7);
      assert.equal(customViews.length, 2);
      assert.deepEqual(notifications, []);
    });

    const observableOutput = JSON.stringify({
      consoleCalls,
      statusCalls,
      notifications,
      customViews,
    });
    assert.doesNotMatch(
      observableOutput,
      new RegExp(`${VALID_TOKEN}|kimi-test-token|zai-test-key|acct-123|Authorization`, "iu"),
    );
  });

  it("starts all provider requests in parallel", async () => {
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
    const { ctx, customViews } = createContext(contextOptions());

    await host.emit("session_start", { reason: "startup" }, ctx);
    const details = host.runCommand("quota", "", ctx);
    await host.flush();

    assert.equal(urls.filter((url) => url.includes("coding/v1/usages")).length, 1);
    assert.equal(urls.filter((url) => url.includes("monitor/usage/quota/limit")).length, 1);
    assert.equal(customViews.length, 0);

    kimi.resolve(responseFor("coding/v1/usages"));
    zai.resolve(responseFor("monitor/usage/quota/limit"));
    await details;
    assert.equal(customViews.length, 1);
  });

  it("keeps failures and stale data in the details view without notifying", async () => {
    let codexFetches = 0;
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("wham/usage")) {
        codexFetches += 1;
        if (codexFetches === 2) return new Response("upstream secret body", { status: 503 });
      }
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, notifications, customViews } = createContext(contextOptions());

    const consoleCalls = await captureConsole(async () => {
      await host.emit("session_start", { reason: "startup" }, ctx);
      await host.runCommand("quota", "", ctx);
    });

    const details = customViews.at(-1)?.join("\n") ?? "";
    assert.match(details, /OpenAI Codex \(active\)/u);
    assert.match(details, /Status: stale/u);
    assert.match(details, /Unavailable reason: temporarily unavailable/u);
    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h: 58%/u);
    assert.deepEqual(notifications, []);
    assert.doesNotMatch(
      JSON.stringify({ consoleCalls, details, notifications }),
      /secret|upstream|chatgpt\.com|Authorization|apiKey/iu,
    );
  });

  it("refreshes supported providers even when the active provider is unsupported", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return responseFor(url);
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls, notifications, customViews } = createContext(
      contextOptions("anthropic"),
    );

    await host.emit("session_start", { reason: "startup" }, ctx);
    const statusCallsAfterStartup = statusCalls.length;
    await host.runCommand("quota", "", ctx);

    assert.equal(urls.length, 3);
    assert.equal(statusCalls.length, statusCallsAfterStartup);
    assert.equal(customViews.length, 1);
    assert.doesNotMatch(customViews[0]!.join("\n"), /active\)/u);
    assert.deepEqual(notifications, []);
  });

  it("rejects removed refresh subcommands without fetching", async () => {
    let fetches = 0;
    const host = createExtensionHost();
    registerExtension(host.api, {
      fetchFn: (async (input: unknown) => {
        fetches += 1;
        return responseFor(String(input));
      }) as typeof fetch,
      nowSeconds: () => NOW,
    });
    const { ctx, notifications } = createContext(contextOptions());

    await host.emit("session_start", { reason: "startup" }, ctx);
    const fetchesAfterStartup = fetches;
    await host.runCommand("quota", "refresh", ctx);
    await host.runCommand("quota", "refresh all", ctx);

    assert.equal(fetches, fetchesAfterStartup);
    assert.deepEqual(notifications, [
      { message: "Usage: /quota", type: "warning" },
      { message: "Usage: /quota", type: "warning" },
    ]);
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
      const { ctx, customViews, notifications } = createContext({
        ...contextOptions(),
        mode,
      });

      await host.emit("session_start", { reason: "startup" }, ctx);
      await host.runCommand("quota", "", ctx);
      await host.runCommand("quota", "refresh", ctx);
      await host.runCommand("quota", "refresh all", ctx);

      assert.equal(fetches, 0);
      assert.deepEqual(customViews, []);
      assert.deepEqual(notifications, []);
    }
  });

  it("coalesces with an active provider request already in flight", async () => {
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
    const { ctx, notifications, customViews } = createContext(contextOptions());

    await host.emit("session_start", { reason: "startup" }, ctx);
    const command = host.runCommand("quota", "", ctx);
    await host.flush();

    assert.equal(codexFetches, 1);
    assert.equal(customViews.length, 0);
    assert.deepEqual(notifications, []);

    codex.resolve(responseFor("wham/usage"));
    await command;
    assert.equal(customViews.length, 1);
    assert.deepEqual(notifications, []);
  });
});
