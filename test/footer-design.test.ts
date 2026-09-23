import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { jsonResponse, NOW, stubFetch, VALID_PAYLOAD } from "./kimi-fixtures.ts";

const KIMI_AUTH = { headers: { Authorization: "Bearer kimi-oauth-token" } };
const KIMI_BASE_URL = "https://api.kimi.com/coding";
const FOOTER = "◷ 5h: 60% ↻ 3h12m · 7d: 75% ↻ 5d0h";

function startedHost() {
  const host = createExtensionHost();
  const { fetchFn } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
  registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
  const mock = createContext({
    provider: "kimi-coding",
    modelBaseUrl: KIMI_BASE_URL,
    auth: KIMI_AUTH,
  });
  return { host, ...mock };
}

describe("quota footer design", () => {
  it("renders the final design from session start", async () => {
    const { host, ctx, statusCalls } = startedHost();

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.equal(statusCalls.at(-1)?.text, FOOTER);
    await host.emit("session_shutdown", {}, ctx);
  });
});

