import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { NOW, stubFetch, VALID_PAYLOAD, jsonResponse } from "./kimi-fixtures.ts";

const KIMI_AUTH = { headers: { Authorization: "Bearer kimi-oauth-token" } };
const KIMI_BASE_URL = "https://api.kimi.com/coding";
const FOOTER = "◷ 5h 60% ↻3h12m · 7d 75% ↻5d0h";

function extensionDeps(
  handler: () => Response | Promise<Response> = () => jsonResponse(200, VALID_PAYLOAD),
) {
  const { fetchFn, calls } = stubFetch(handler);
  return { fetchFn, calls, nowSeconds: () => NOW };
}

describe("kimi footer status", () => {
  it("renders validated Kimi quota windows after session start", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "kimi-coding",
      modelBaseUrl: KIMI_BASE_URL,
      auth: KIMI_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: FOOTER }]);
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].url, "https://api.kimi.com/coding/v1/usages");
  });

  it("renders a validated partial Kimi snapshot", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.usage.limit = "invalid";
    const host = createExtensionHost();
    const deps = extensionDeps(() => jsonResponse(200, payload));
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "kimi-coding",
      modelBaseUrl: KIMI_BASE_URL,
      auth: KIMI_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: "◷ 5h 60% ↻3h12m" }]);
  });

  it("renders nothing for a malformed Kimi response", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps(() => jsonResponse(200, { usage: { limit: "?" } }));
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "kimi-coding",
      modelBaseUrl: KIMI_BASE_URL,
      auth: KIMI_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });

  it("renders nothing for an HTTP authentication failure", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps(() => jsonResponse(401, {}));
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "kimi-coding",
      modelBaseUrl: KIMI_BASE_URL,
      auth: KIMI_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });

  it("renders nothing for a network-unavailable Kimi endpoint", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps(async () => {
      throw new TypeError("fetch failed");
    });
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "kimi-coding",
      modelBaseUrl: KIMI_BASE_URL,
      auth: KIMI_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });

  it("renders nothing when Kimi quota is unavailable", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "kimi-coding",
      modelBaseUrl: KIMI_BASE_URL,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
    assert.equal(deps.calls.length, 0);
  });

  it("renders Kimi quota when the active model changes to Kimi", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "anthropic",
      modelBaseUrl: "https://api.anthropic.com",
      auth: KIMI_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit(
      "model_select",
      {
        model: { provider: "kimi-coding", id: "kimi-for-coding", baseUrl: KIMI_BASE_URL },
        previousModel: { provider: "anthropic", id: "claude-opus", baseUrl: "https://api.anthropic.com" },
        source: "set",
      },
      ctx,
    );

    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: "anthropic" },
      { id: "pi-quota", text: FOOTER },
    ]);
    assert.equal(deps.calls.length, 1);
  });
});
