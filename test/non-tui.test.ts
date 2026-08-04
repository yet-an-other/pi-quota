import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";

describe("non-TUI modes", () => {
  for (const mode of ["print", "json", "rpc"]) {
    it(`leaves the footer untouched in ${mode} mode`, async () => {
      const host = createExtensionHost();
      registerExtension(host.api);
      const { ctx, statusCalls } = createContext({ mode, provider: "openai-codex" });

      await host.emit("session_start", { reason: "startup" }, ctx);
      await host.emit(
        "model_select",
        { model: { provider: "openai-codex", id: "gpt-5.1-codex" }, previousModel: undefined, source: "restore" },
        ctx,
      );

      assert.deepEqual(statusCalls, []);
    });
  }
});
