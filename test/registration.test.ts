import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost } from "./mock-host.ts";

describe("extension registration", () => {
  it("subscribes to quota lifecycle events", () => {
    const host = createExtensionHost();

    registerExtension(host.api);

    assert.deepEqual(host.registeredEvents().sort(), [
      "agent_settled",
      "model_select",
      "session_shutdown",
      "session_start",
    ]);
    assert.deepEqual(host.registeredCommands(), ["quota"]);
  });
});
