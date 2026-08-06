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

describe("quota footer default style", () => {
  it("renders the final design from session start without any command", async () => {
    const { host, ctx, statusCalls, themeCalls } = startedHost();

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.equal(statusCalls.at(-1)?.text, FOOTER);
    const painted = themeCalls.map(({ color, text }) => [color, text]);
    assert.deepEqual(painted, [
      ["success", "◷"],
      ["success", "5h:"],
      ["success", " "], ["success", "60"], ["success", "%"],
      ["success", " "], ["success", "↻"],
      ["success", " "], ["success", "3"], ["success", "h"], ["success", "12"], ["success", "m"],
      ["success", " · "],
      ["success", "7d:"],
      ["success", " "], ["success", "75"], ["success", "%"],
      ["success", " "], ["success", "↻"],
      ["success", " "], ["success", "5"], ["success", "d"], ["success", "0"], ["success", "h"],
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
      ["error", " "], ["error", "5"], ["error", "%"],
      ["error", " "], ["success", "↻"],
      ["error", " "], ["error", "3"], ["error", "h"], ["error", "12"], ["error", "m"],
      ["error", " · "], // separator takes the worse of the joined windows
      ["success", "7d:"],
      ["warning", " "], ["warning", "15"], ["warning", "%"],
      ["warning", " "], ["success", "↻"],
      ["warning", " "], ["warning", "5"], ["warning", "d"], ["warning", "0"], ["warning", "h"],
    ]);
  });
});

describe("quota-style cycling", () => {
  it("cycles away from and back to the final design", async () => {
    const { host, ctx, statusCalls, notifications } = startedHost();
    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(statusCalls.at(-1)?.text, FOOTER);

    // green-success → plain: flat dim, compact layout
    await host.runCommand("quota-style", "", ctx);
    assert.deepEqual(notifications.at(-1), {
      message: "Quota status style: plain",
      type: "info",
    });
    assert.equal(statusCalls.at(-1)?.text, "◷ 5h 60% ↻3h12m · 7d 75% ↻5d0h");

    // Full cycle returns to the final design.
    for (let i = 0; i < 4; i += 1) await host.runCommand("quota-style", "", ctx);
    assert.deepEqual(notifications.at(-1), {
      message: "Quota status style: green-success",
      type: "info",
    });
    assert.equal(statusCalls.at(-1)?.text, FOOTER);
  });

  it("keeps preview styles reachable without refetching", async () => {
    const { host, ctx, statusCalls, themeCalls, notifications, calls } = startedHost();
    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(calls.length, 1);

    await host.runCommand("quota-style", "", ctx); // plain
    await host.runCommand("quota-style", "", ctx); // units-bright
    assert.deepEqual(notifications.at(-1), {
      message: "Quota status style: units-bright",
      type: "info",
    });
    const units = themeCalls.filter(({ color }) => color === "text");
    assert.equal(units.map(({ text }) => text).join(""), "h%hmd%dh");
    assert.equal(statusCalls.at(-1)?.text, "◷ 5h 60% ↻3h12m · 7d 75% ↻5d0h");
    assert.equal(calls.length, 1);
  });
});
