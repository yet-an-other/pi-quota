import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";

describe("model change", () => {
  it("updates the footer status to the newly selected provider", async () => {
    const host = createExtensionHost();
    registerExtension(host.api);
    const { ctx, statusCalls } = createContext({ provider: "openai-codex" });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit(
      "model_select",
      {
        model: { provider: "kimi-coding", id: "kimi-for-coding" },
        previousModel: { provider: "openai-codex", id: "gpt-5.1-codex" },
        source: "set",
      },
      ctx,
    );

    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: "openai-codex" },
      { id: "pi-quota", text: "kimi-coding" },
    ]);
  });
});
