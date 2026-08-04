import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createExtensionHost, createContext } from "./mock-host.ts";

describe("extension registration", () => {
  it("subscribes to session start and model selection", () => {
    const host = createExtensionHost();

    registerExtension(host.api);

    assert.deepEqual(host.registeredEvents().sort(), ["model_select", "session_start"]);
  });
});
