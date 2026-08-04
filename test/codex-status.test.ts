import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";
import { jsonResponse, stubFetch, VALID_PAYLOAD, VALID_TOKEN, NOW } from "./codex-fixtures.ts";

const CODEX_AUTH = { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" };

function codexDeps() {
  const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
  return { fetchFn, calls, nowSeconds: () => NOW };
}

describe("codex footer status", () => {
  it("renders validated codex quota windows after session start", async () => {
    const host = createExtensionHost();
    const deps = codexDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({ provider: "openai-codex", auth: CODEX_AUTH });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: "◷ 5h 58% ↻12m · 7d 95% ↻5d0h" }]);
    assert.equal(deps.calls.length, 1);
  });

  it("uses the active model origin when resolved OAuth auth has no base URL", async () => {
    const host = createExtensionHost();
    const deps = codexDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: { apiKey: VALID_TOKEN },
    });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: "◷ 5h 58% ↻12m · 7d 95% ↻5d0h" }]);
    assert.equal(deps.calls.length, 1);
  });

  it("renders nothing when codex quota is unavailable", async () => {
    const host = createExtensionHost();
    const deps = codexDeps();
    registerExtension(host.api, deps);
    // No stored credential: auth resolution returns undefined
    const { ctx, statusCalls } = createContext({ provider: "openai-codex" });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
    assert.equal(deps.calls.length, 0);
  });

  it("follows the active provider across model changes", async () => {
    const host = createExtensionHost();
    const deps = codexDeps();
    registerExtension(host.api, deps);
    const { ctx, statusCalls } = createContext({ provider: "openai-codex", auth: CODEX_AUTH });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit(
      "model_select",
      { model: { provider: "anthropic", id: "claude-opus-4-5" }, previousModel: { provider: "openai-codex", id: "gpt-5.1-codex" }, source: "set" },
      ctx,
    );
    await host.emit(
      "model_select",
      { model: { provider: "openai-codex", id: "gpt-5.1-codex" }, previousModel: { provider: "anthropic", id: "claude-opus-4-5" }, source: "set" },
      ctx,
    );

    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: "◷ 5h 58% ↻12m · 7d 95% ↻5d0h" },
      { id: "pi-quota", text: "anthropic" },
      { id: "pi-quota", text: "◷ 5h 58% ↻12m · 7d 95% ↻5d0h" },
    ]);
    assert.equal(deps.calls.length, 2);
  });

  it("clears the footer when a refresh fails unexpectedly", async () => {
    const host = createExtensionHost();
    const defective = stubFetch(() => ({
      status: 200,
      ok: true,
      json: async () => ({
        get rate_limit() {
          throw new Error("programmer defect");
        },
      }),
    } as unknown as Response));
    registerExtension(host.api, { fetchFn: defective.fetchFn, nowSeconds: () => NOW });
    const { ctx, statusCalls } = createContext({ provider: "openai-codex", auth: CODEX_AUTH });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });
});
