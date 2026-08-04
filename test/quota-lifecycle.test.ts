import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuotaLifecycle, type QuotaLifecycleHost } from "../src/quota-lifecycle.ts";
import type { QuotaSnapshot } from "../src/quota-contract.ts";
import { jsonResponse, stubFetch, VALID_PAYLOAD, VALID_TOKEN } from "./codex-fixtures.ts";
import { VALID_PAYLOAD as KIMI_PAYLOAD } from "./kimi-fixtures.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const NOW = 1_735_689_000;

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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

function createHost(): QuotaLifecycleHost {
  return {
    mode: "tui",
    provider: "openai-codex",
    providerBaseUrl: CODEX_BASE_URL,
    ui: { setStatus() {} },
    theme: { fg: (_color, text) => text },
    resolveAuth: async () => ({ apiKey: VALID_TOKEN, baseUrl: CODEX_BASE_URL }),
  };
}

function createKimiHost(): QuotaLifecycleHost {
  return {
    mode: "tui",
    provider: "kimi-coding",
    providerBaseUrl: "https://api.kimi.com/coding",
    ui: { setStatus() {} },
    theme: { fg: (_color, text) => text },
    resolveAuth: async () => ({
      headers: { Authorization: "Bearer kimi-test-token" },
      baseUrl: "https://api.kimi.com/coding",
    }),
  };
}

describe("quota lifecycle: settled activity throttle", () => {
  it("refreshes on session start and only after 60 seconds since completion", async () => {
    const clock = new FakeClock();
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const lifecycle = new QuotaLifecycle({
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.equal(calls.length, 1);
    assert.equal(clock.pendingTimers, 0);

    clock.advance(59);
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(calls.length, 1);

    clock.advance(1);
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(calls.length, 2);
  });
});

describe("quota lifecycle: failure backoff", () => {
  it("uses 2-minute, 5-minute, then capped 15-minute automatic retry delays", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const { fetchFn } = stubFetch(() => {
      fetches += 1;
      return fetches === 5
        ? jsonResponse(200, VALID_PAYLOAD)
        : jsonResponse(500, {});
    });
    const lifecycle = new QuotaLifecycle({
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, NOW + 120);

    clock.nowSeconds = NOW + 119;
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(fetches, 1);

    clock.nowSeconds = NOW + 120;
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, NOW + 120 + 300);

    clock.nowSeconds = NOW + 120 + 300;
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, NOW + 120 + 300 + 900);

    clock.nowSeconds = NOW + 120 + 300 + 900;
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, NOW + 120 + 300 + 1_800);

    clock.nowSeconds = NOW + 120 + 300 + 1_800;
    lifecycle.agentSettled(host);
    await flushAsync();
    assert.equal(fetches, 5);
    assert.equal(lifecycle.getState("openai-codex")?.consecutiveFailures, 0);
    assert.equal(
      lifecycle.getState("openai-codex")?.nextAutomaticAt,
      clock.nowSeconds + 60,
    );
    assert.equal(clock.pendingTimers, 0);
  });
});

describe("quota lifecycle: stale last renderable state", () => {
  it("preserves same-provider renderable data and marks it stale after failure", async () => {
    let nowSeconds = NOW;
    let fetches = 0;
    const { fetchFn } = stubFetch(() => {
      fetches += 1;
      if (fetches === 1) return jsonResponse(200, VALID_PAYLOAD);
      throw new TypeError("network unavailable");
    });
    const statusCalls: Array<string | undefined> = [];
    const host: QuotaLifecycleHost = {
      ...createHost(),
      ui: { setStatus: (_id, text) => statusCalls.push(text) },
      theme: { fg: (color, text) => `[${color}:${text}]` },
    };
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => nowSeconds });

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.match(statusCalls.at(-1) ?? "", /^\[accent:◷\] \[dim:5h 58%/u);

    nowSeconds += 60;
    lifecycle.agentSettled(host);
    await flushAsync();

    const state = lifecycle.getState("openai-codex");
    assert.equal(state?.current?.status, "unavailable");
    assert.equal(state?.lastRenderable?.status, "available");
    assert.equal(state?.stale, true);
    assert.equal(state?.consecutiveFailures, 1);
    assert.match(statusCalls.at(-1) ?? "", /^\[warning:◷\] \[muted:5h 58%/u);
  });
});

describe("quota lifecycle: session-memory state", () => {
  it("starts each session empty instead of restoring the previous last renderable snapshot", async () => {
    let fetches = 0;
    const { fetchFn } = stubFetch(() => {
      fetches += 1;
      return fetches === 1 ? jsonResponse(200, VALID_PAYLOAD) : jsonResponse(500, {});
    });
    const statusCalls: Array<string | undefined> = [];
    const host: QuotaLifecycleHost = {
      ...createHost(),
      ui: { setStatus: (_id, text) => statusCalls.push(text) },
    };
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => NOW });

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.lastRenderable?.status, "available");

    lifecycle.sessionStart(host);
    await flushAsync();

    assert.equal(statusCalls.at(-1), undefined);
    assert.equal(lifecycle.getState("openai-codex")?.lastRenderable, undefined);
    assert.equal(lifecycle.getState("openai-codex")?.stale, false);
  });
});

describe("quota lifecycle: unsupported providers", () => {
  it("clears the footer without recording unavailable state or fetching", async () => {
    const statusCalls: Array<string | undefined> = [];
    const supportedHost: QuotaLifecycleHost = {
      ...createHost(),
      ui: { setStatus: (_id, text) => statusCalls.push(text) },
    };
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => NOW });

    lifecycle.sessionStart(supportedHost);
    await flushAsync();
    assert.notEqual(statusCalls.at(-1), undefined);

    const unsupportedHost: QuotaLifecycleHost = {
      ...supportedHost,
      provider: "anthropic",
      providerBaseUrl: "https://api.anthropic.com",
    };
    lifecycle.modelSelect(unsupportedHost);
    await flushAsync();

    assert.equal(statusCalls.at(-1), undefined);
    assert.equal(calls.length, 1);
    assert.equal(lifecycle.getState("anthropic"), undefined);
  });
});

describe("quota lifecycle: provider switching", () => {
  it("aborts stale work and discards a late response from the old provider", async () => {
    const codexResponse = deferred<Response>();
    const signals: AbortSignal[] = [];
    const urls: string[] = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      urls.push(String(input));
      if (init?.signal) signals.push(init.signal);
      return String(input).includes("chatgpt.com")
        ? codexResponse.promise
        : jsonResponse(200, KIMI_PAYLOAD);
    }) as typeof fetch;
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => NOW });

    lifecycle.sessionStart(createHost());
    await flushAsync();
    assert.equal(urls.length, 1);

    lifecycle.modelSelect(createKimiHost());
    await flushAsync();

    assert.equal(signals[0]?.aborted, true);
    assert.equal(urls.length, 2);
    assert.equal(lifecycle.getState("kimi-coding")?.current?.status, "available");

    codexResponse.resolve(jsonResponse(200, VALID_PAYLOAD));
    await flushAsync();

    assert.equal(lifecycle.getState("openai-codex"), undefined);
    assert.equal(lifecycle.getState("kimi-coding")?.current?.status, "available");
  });
});

describe("quota lifecycle: provider contract mismatch", () => {
  it("discards a mismatched snapshot without wedging later refreshes", async () => {
    let fetches = 0;
    const fetchSnapshot = async (): Promise<QuotaSnapshot> => {
      fetches += 1;
      return {
        status: "degraded",
        provider: "kimi-coding",
        telemetry: [
          {
            id: "mismatched",
            providerLabel: "mismatched",
            semantics: "unknown",
          },
        ],
        source: { kind: "experimental", fetchedAtSeconds: NOW },
      };
    };
    const lifecycle = new QuotaLifecycle({
      fetchFn: (async () => {
        throw new Error("provider router should be replaced");
      }) as typeof fetch,
      fetchSnapshot,
      nowSeconds: () => NOW,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    lifecycle.agentSettled(host);
    await flushAsync();

    assert.equal(fetches, 2);
    assert.equal(lifecycle.getState("openai-codex")?.current, undefined);
  });
});

describe("quota lifecycle: cancellation", () => {
  it("combines an available Pi abort signal with provider request cancellation", async () => {
    const external = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => NOW });

    lifecycle.sessionStart(createHost(), external.signal);
    await flushAsync();
    external.abort(new Error("Pi cancelled"));
    await flushAsync();

    assert.equal(requestSignal?.aborted, true);
    assert.equal(lifecycle.getState("openai-codex")?.current?.status, "unavailable");
    assert.equal(lifecycle.getState("openai-codex")?.consecutiveFailures, 1);
  });

  it("aborts in-flight work and clears runtime state during shutdown", async () => {
    const response = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response.promise;
    }) as typeof fetch;
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => NOW });

    lifecycle.sessionStart(createHost());
    await flushAsync();
    lifecycle.sessionShutdown();

    assert.equal(requestSignal?.aborted, true);
    assert.equal(lifecycle.getState("openai-codex"), undefined);

    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex"), undefined);
  });
});

describe("quota lifecycle: request timeout", () => {
  it("aborts and completes a provider request after eight seconds even when fetch ignores cancellation", async () => {
    const clock = new FakeClock();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const lifecycle = new QuotaLifecycle({
      fetchFn,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
    });

    lifecycle.sessionStart(createHost());
    await flushAsync();
    assert.equal(requestSignal?.aborted, false);

    clock.advance(8);
    await flushAsync();

    assert.equal(requestSignal?.aborted, true);
    assert.equal(clock.pendingTimers, 0);
    assert.deepEqual(lifecycle.getState("openai-codex"), {
      provider: "openai-codex",
      current: {
        status: "unavailable",
        provider: "openai-codex",
        reason: "transient",
        source: {
          kind: "first-party-private",
          detailUrl: "https://chatgpt.com/codex/settings/usage",
          fetchedAtSeconds: NOW + 8,
        },
      },
      stale: false,
      consecutiveFailures: 1,
      lastCompletedAt: NOW + 8,
      nextAutomaticAt: NOW + 8 + 120,
    });
  });
});

describe("quota lifecycle: request coalescing", () => {
  it("coalesces repeated triggers into one in-flight provider request", async () => {
    const response = deferred<Response>();
    const { fetchFn, calls } = stubFetch(() => response.promise);
    const lifecycle = new QuotaLifecycle({ fetchFn, nowSeconds: () => NOW });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    lifecycle.agentSettled(host);
    lifecycle.agentSettled(host);
    await flushAsync();

    assert.equal(calls.length, 1);

    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.current?.status, "available");
  });
});
