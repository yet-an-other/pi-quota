import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { jsonResponse, stubFetch, VALID_PAYLOAD, VALID_TOKEN, NOW } from "./codex-fixtures.ts";

const CODEX_AUTH = { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("automatic quota refresh events", () => {
  it("refreshes on settled activity only after the 60-second throttle", async () => {
    let nowSeconds = NOW;
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => nowSeconds });
    const { ctx, statusCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    nowSeconds += 59;
    await host.emit("agent_settled", {}, ctx);
    assert.equal(calls.length, 1);

    nowSeconds += 1;
    await host.emit("agent_settled", {}, ctx);

    assert.equal(calls.length, 2);
    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h 58%/u);
  });

  it("coalesces settled triggers with an in-flight session refresh", async () => {
    const response = deferred<Response>();
    const { fetchFn, calls } = stubFetch(() => response.promise);
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit("agent_settled", {}, ctx);
    await host.emit("agent_settled", {}, ctx);

    assert.equal(calls.length, 1);
    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    await host.flush();
  });

  it("keeps last renderable footer data and applies stale colors after an unavailable refresh", async () => {
    let nowSeconds = NOW;
    let fetches = 0;
    const { fetchFn } = stubFetch(() => {
      fetches += 1;
      return fetches === 1 ? jsonResponse(200, VALID_PAYLOAD) : jsonResponse(503, {});
    });
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => nowSeconds });
    const { ctx, statusCalls, themeCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    nowSeconds += 60;
    await host.emit("agent_settled", {}, ctx);

    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h 58%/u);
    assert.deepEqual(
      themeCalls.slice(-2).map(({ color }) => color),
      ["warning", "muted"],
    );
  });

  it("aborts an in-flight request during session shutdown and ignores its late response", async () => {
    const response = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response.promise;
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit("session_shutdown", { reason: "quit" }, ctx);

    assert.equal(requestSignal?.aborted, true);
    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    await host.flush();
    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: undefined },
      { id: "pi-quota", text: undefined },
    ]);
  });
});
