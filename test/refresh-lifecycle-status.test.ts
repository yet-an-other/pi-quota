import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerExtension from "../src/index.ts";
import { createContext, createExtensionHost } from "./mock-host.ts";
import { jsonResponse, stubFetch, VALID_PAYLOAD, VALID_TOKEN, NOW } from "./codex-fixtures.ts";

const CODEX_AUTH = { apiKey: VALID_TOKEN, baseUrl: "https://chatgpt.com/backend-api" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeClock {
  nowSeconds = NOW;
  private nextId = 0;
  private readonly timers = new Map<number, { dueMilliseconds: number; callback: () => void }>();

  readonly scheduleTimeout = (callback: () => void, delayMilliseconds: number) => {
    const id = ++this.nextId;
    this.timers.set(id, {
      dueMilliseconds: this.nowSeconds * 1000 + delayMilliseconds,
      callback,
    });
    return () => this.timers.delete(id);
  };

  get pendingTimers(): number {
    return this.timers.size;
  }

  advance(seconds: number): void {
    this.nowSeconds += seconds;
    const nowMilliseconds = this.nowSeconds * 1000;
    for (const [id, timer] of [...this.timers]) {
      if (timer.dueMilliseconds <= nowMilliseconds) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

describe("automatic quota refresh events", () => {
  it("refreshes at activity transitions, polls working activity every minute, and ignores repeats", async () => {
    const clock = new FakeClock();
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const host = createExtensionHost();
    registerExtension(host.api, {
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const { ctx } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(calls.length, 1);

    await host.emit("agent_start", {}, ctx);
    await host.emit("agent_start", {}, ctx);
    assert.equal(calls.length, 2);

    clock.advance(59);
    await host.flush();
    assert.equal(calls.length, 2);

    clock.advance(1);
    await host.flush();
    assert.equal(calls.length, 3);

    await host.emit("agent_settled", {}, ctx);
    await host.emit("agent_settled", {}, ctx);
    assert.equal(calls.length, 4);

    clock.advance(59);
    await host.flush();
    assert.equal(calls.length, 4);
    clock.advance(1);
    await host.flush();
    assert.equal(calls.length, 5);

    await host.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it("redraws the footer on the heartbeat even when no provider request is due", async () => {
    const clock = new FakeClock();
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const host = createExtensionHost();
    registerExtension(host.api, {
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const { ctx, statusCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    clock.advance(10);
    await host.emit("agent_start", {}, ctx);
    assert.equal(calls.length, 2);
    const statusCallsBeforeHeartbeat = statusCalls.length;

    clock.advance(50);
    await host.flush();

    assert.equal(calls.length, 2);
    assert.equal(statusCalls.length, statusCallsBeforeHeartbeat + 1);
    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h: 58% ↻ 11m/u);

    await host.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it("keeps last renderable footer data and applies stale colors after an unavailable refresh", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const { fetchFn } = stubFetch(() => {
      fetches += 1;
      return fetches === 1 ? jsonResponse(200, VALID_PAYLOAD) : jsonResponse(503, {});
    });
    const host = createExtensionHost();
    registerExtension(host.api, {
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const { ctx, statusCalls, themeCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit("agent_start", {}, ctx);

    assert.match(statusCalls.at(-1)?.text ?? "", /^◷ 5h: 58%/u);
    assert.deepEqual(
      themeCalls.slice(-2).map(({ color }) => color),
      ["warning", "muted"],
    );

    await host.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it("aborts an in-flight request and heartbeat during session shutdown", async () => {
    const clock = new FakeClock();
    const response = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response.promise;
    }) as typeof fetch;
    const host = createExtensionHost();
    registerExtension(host.api, {
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const { ctx, statusCalls } = createContext({
      provider: "openai-codex",
      modelBaseUrl: "https://chatgpt.com/backend-api",
      auth: CODEX_AUTH,
    });

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit("session_shutdown", { reason: "quit" }, ctx);

    assert.equal(requestSignal?.aborted, true);
    assert.equal(clock.pendingTimers, 0);
    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    await host.flush();
    assert.deepEqual(statusCalls, [
      { id: "pi-quota", text: undefined },
      { id: "pi-quota", text: undefined },
    ]);
  });
});
