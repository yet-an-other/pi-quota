import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { NOW, VALID_PAYLOAD, ZAI_BASE_URL, jsonResponse, stubFetch } from "./zai-fixtures.ts";

function extensionDeps(
  handler: () => Response | Promise<Response> = () => jsonResponse(200, VALID_PAYLOAD),
) {
  const { fetchFn, calls } = stubFetch(handler);
  return { fetchFn, calls, nowSeconds: () => NOW };
}

describe("Z.AI footer status", () => {
  it("renders only the degraded telemetry indicator after session start", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "zai",
      modelBaseUrl: ZAI_BASE_URL,
      auth: { apiKey: "zai-test-key" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: undefined },
      { id: "pi-quota", text: "◷ telemetry" },
    ]);
    assert.equal(deps.calls.length, 1);
  });

  it("renders nothing when monitor telemetry has drifted", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps(() => jsonResponse(200, { data: { limits: [] } }));
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "zai",
      modelBaseUrl: ZAI_BASE_URL,
      auth: { apiKey: "zai-test-key" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });

  it("renders nothing for ambiguous monitor authentication", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps(() => jsonResponse(403, {}));
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "zai",
      modelBaseUrl: ZAI_BASE_URL,
      auth: { apiKey: "zai-test-key" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
    assert.equal(deps.calls.length, 1);
  });

  it("renders nothing and does not fetch when the effective provider origin mismatches", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "zai",
      modelBaseUrl: "https://evil.example.com/zai",
      auth: { apiKey: "must-not-leak" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
    assert.equal(deps.calls.length, 0);
  });

  it("renders nothing when global Z.AI telemetry is unavailable", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps(async () => {
      throw new TypeError("fetch failed");
    });
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "zai",
      modelBaseUrl: ZAI_BASE_URL,
      auth: { apiKey: "zai-test-key" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });

  it("does not treat Z.AI Coding CN as the global Z.AI integration", async () => {
    const host = createExtensionHost();
    const deps = extensionDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "zai-coding-cn",
      modelBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      auth: { apiKey: "cn-key" },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
    assert.equal(deps.calls.length, 0);
  });
});
