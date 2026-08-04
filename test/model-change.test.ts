import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";

describe("model change", () => {
  it("keeps quota status hidden across unsupported providers", async () => {
    const host = createExtensionHost();
    registerExtension(host.api);
    const { ctx, statusCalls } = createContext({ provider: "anthropic" });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit(
      "model_select",
      {
        model: { provider: "google", id: "gemini-2.5-pro", baseUrl: "https://generativelanguage.googleapis.com" },
        previousModel: { provider: "anthropic", id: "claude-opus-4-5" },
        source: "set",
      },
      ctx,
    );

    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: undefined },
      { id: "pi-quota", text: undefined },
    ]);
  });
});
