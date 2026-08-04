import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";

describe("session start", () => {
  it("shows the active provider name in the footer status", async () => {
    const host = createExtensionHost();
    registerExtension(host.api);
    const { ctx, statusCalls } = createContext({ provider: "anthropic" });

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: "anthropic" }]);
  });

  it("clears the provider status when no active provider exists", async () => {
    const host = createExtensionHost();
    registerExtension(host.api);
    const { ctx, statusCalls } = createContext();

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(statusCalls, [{ id: "pi-quota", text: undefined }]);
  });
});
