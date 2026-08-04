import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";

describe("model change", () => {
  it("updates the footer status to the newly selected provider", async () => {
    const host = createExtensionHost();
    registerExtension(host.api);
    const { ctx, statusCalls } = createContext({ provider: "anthropic" });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit(
      "model_select",
      {
        model: { provider: "kimi-coding", id: "kimi-for-coding" },
        previousModel: { provider: "anthropic", id: "claude-opus-4-5" },
        source: "set",
      },
      ctx,
    );

    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: "anthropic" },
      { id: "pi-quota", text: "kimi-coding" },
    ]);
  });
});
