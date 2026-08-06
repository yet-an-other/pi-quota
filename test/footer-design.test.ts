import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { jsonResponse, NOW, stubFetch, VALID_PAYLOAD } from "./kimi-fixtures.ts";

const KIMI_AUTH = { headers: { Authorization: "Bearer kimi-oauth-token" } };
const KIMI_BASE_URL = "https://api.kimi.com/coding";
const FOOTER = "◷ 5h: 60% ↻ 3h12m · 7d: 75% ↻ 5d0h";

function startedHost(payload: unknown = VALID_PAYLOAD) {
  const host = createExtensionHost();
  const { fetchFn, calls } = stubFetch(() => jsonResponse(200, payload));
  registerExtension(host.api, { fetchFn, nowSeconds: () => NOW });
  const mock = createContext({
    provider: "kimi-coding",
    modelBaseUrl: KIMI_BASE_URL,
    auth: KIMI_AUTH,
  });
  return { host, calls, ...mock };
}

describe("quota footer design", () => {
  it("renders the final design from session start", async () => {
    const { host, ctx, statusCalls, themeCalls } = startedHost();

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.equal(statusCalls.at(-1)?.text, FOOTER);
    const painted = themeCalls.map(({ color, text }) => [color, text]);
    assert.deepEqual(painted, [
      ["success", "◷"],
      ["success", "5h:"],
      ["success", " 60% "], ["success", "↻"], ["success", " 3h12m"],
      ["success", " · "],
      ["success", "7d:"],
      ["success", " 75% "], ["success", "↻"], ["success", " 5d0h"],
    ]);
  });

  it("colors values by remaining quota severity", async () => {
    const payload = structuredClone(VALID_PAYLOAD);
    payload.usage.remaining = "150"; // 7d: 15% → warning
    payload.limits[0].detail.remaining = "5"; // 5h: 5% → error
    const { host, ctx, statusCalls, themeCalls } = startedHost(payload);

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.equal(statusCalls.at(-1)?.text, "◷ 5h: 5% ↻ 3h12m · 7d: 15% ↻ 5d0h");
    const painted = themeCalls.map(({ color, text }) => [color, text]);
    assert.deepEqual(painted, [
      ["success", "◷"],
      ["success", "5h:"],
      ["error", " 5% "], ["success", "↻"], ["error", " 3h12m"],
      ["error", " · "], // separator takes the worse of the joined windows
      ["success", "7d:"],
      ["warning", " 15% "], ["success", "↻"], ["warning", " 5d0h"],
    ]);
  });
});

