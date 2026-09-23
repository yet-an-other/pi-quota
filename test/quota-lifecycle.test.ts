import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuotaLifecycle } from "../src/quota-lifecycle.ts";
import { fetchProviderQuotaSnapshot } from "../src/provider-registry.ts";
import type { QuotaHost } from "../src/quota-host.ts";
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

function createHost(): QuotaHost {
  return {
    mode: "tui",
    provider: "openai-codex",
    providerBaseUrl: CODEX_BASE_URL,
    ui: { setStatus() {} },
    theme: { fg: (_color, text) => text },
    resolveAuth: async () => ({ apiKey: VALID_TOKEN, baseUrl: CODEX_BASE_URL }),
  };
}

function createKimiHost(): QuotaHost {
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

async function heartbeat(clock: FakeClock, count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    clock.advance(60);
    await flushAsync();
  }
}

function availableSnapshot(
  provider: string,
  windows: Extract<QuotaSnapshot, { status: "available" }>['windows'] = [],
  fetchedAtSeconds = NOW,
): Extract<QuotaSnapshot, { status: "available" }> {
  return {
    status: "available",
    provider,
    windows,
    source: { kind: "experimental", fetchedAtSeconds },
  };
}

describe("quota lifecycle: adaptive activity schedule", () => {
  it("requests immediately when work starts and every minute while working", async () => {
    const clock = new FakeClock();
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => clock.nowSeconds }, signal),
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    lifecycle.agentStart(host);
    await flushAsync();
    assert.equal(calls.length, 2);

    await heartbeat(clock, 1);
    assert.equal(calls.length, 3);

    lifecycle.agentStart(host);
    await flushAsync();
    assert.equal(calls.length, 3);

    lifecycle.sessionShutdown();
  });

  it("backs off idle requests through 1, 2, 5, and 15 minutes, then stays at 15", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const fetchSnapshot = async (host: QuotaHost): Promise<QuotaSnapshot> => {
      fetches += 1;
      return availableSnapshot(host.provider!, [], clock.nowSeconds);
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.equal(fetches, 1);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 60);

    await heartbeat(clock);
    assert.equal(fetches, 2);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 180);

    await heartbeat(clock, 2);
    assert.equal(fetches, 3);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 480);

    await heartbeat(clock, 5);
    assert.equal(fetches, 4);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 1_380);

    await heartbeat(clock, 15);
    assert.equal(fetches, 5);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 2_280);

    lifecycle.sessionShutdown();
  });

  it("triggers a known reset before a later idle request and preserves the idle stage", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const fetchSnapshot = async (host: QuotaHost): Promise<QuotaSnapshot> => {
      fetches += 1;
      return availableSnapshot(
        host.provider!,
        fetches < 3
          ? [{ id: "short", label: "5h", remainingPercent: 58, resetAtSeconds: NOW + 119 }]
          : [],
        clock.nowSeconds,
      );
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    await heartbeat(clock);
    assert.equal(fetches, 2);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 180);

    await heartbeat(clock);
    assert.equal(fetches, 3);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 240);

    lifecycle.sessionShutdown();
  });
});

describe("quota lifecycle: freshness races", () => {
  for (const settleBeforeCompletion of [false, true]) {
    it(`uses the latest activity when an idle request completes${settleBeforeCompletion ? " after returning to idle" : " while working"}`, async () => {
      const clock = new FakeClock();
      const pending = deferred<QuotaSnapshot>();
      let fetches = 0;
      const host = createHost();
      const lifecycle = new QuotaLifecycle({
        fetchSnapshot: async () => ++fetches === 2
          ? pending.promise
          : availableSnapshot(host.provider!),
        nowSeconds: () => clock.nowSeconds,
        scheduleTimeout: clock.scheduleTimeout,
        scheduleHeartbeat: clock.scheduleTimeout,
      });

      lifecycle.sessionStart(host);
      await flushAsync();
      await heartbeat(clock);
      assert.equal(fetches, 2);
      assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, undefined);

      lifecycle.agentStart(host);
      if (settleBeforeCompletion) lifecycle.agentSettled(host);
      const inspection = lifecycle.refreshProviders([host]);
      await flushAsync();
      assert.equal(fetches, 2, "activity and inspection share the in-flight request");

      pending.resolve(availableSnapshot(host.provider!));
      const [state] = await inspection;
      assert.equal(state?.nextAutomaticAt, NOW + 120);
      assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 120);

      await heartbeat(clock);
      assert.equal(fetches, 3);
      assert.equal(
        lifecycle.getState(host.provider!)?.nextAutomaticAt,
        NOW + (settleBeforeCompletion ? 240 : 180),
      );
      lifecycle.sessionShutdown();
    });
  }

  for (const resetAfterSeconds of [120, 180]) {
    it(`prioritizes a known reset ${resetAfterSeconds === 120 ? "before" : "at"} the failure-backoff deadline`, async () => {
      const clock = new FakeClock();
      const host = createHost();
      let fetches = 0;
      const lifecycle = new QuotaLifecycle({
        fetchSnapshot: async () => {
          fetches += 1;
          if (fetches === 2) throw new Error("temporary failure");
          return availableSnapshot(host.provider!, [
            { id: "short", label: "5h", remainingPercent: 58, resetAtSeconds: NOW + resetAfterSeconds },
          ]);
        },
        nowSeconds: () => clock.nowSeconds,
        scheduleTimeout: clock.scheduleTimeout,
        scheduleHeartbeat: clock.scheduleTimeout,
      });

      lifecycle.sessionStart(host);
      await flushAsync();
      await heartbeat(clock);
      assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 180);
      assert.equal(lifecycle.getState(host.provider!)?.stale, true);

      await heartbeat(clock, (resetAfterSeconds - 60) / 60);
      assert.equal(fetches, 3);
      const state = lifecycle.getState(host.provider!);
      assert.equal(state?.consecutiveFailures, 0);
      assert.equal(state?.stale, false);
      assert.equal(state?.nextAutomaticAt, NOW + resetAfterSeconds + 120,
        "a reset request does not advance the idle stage");

      await heartbeat(clock);
      assert.equal(fetches, 3, "the past reset is not requested again");
      lifecycle.sessionShutdown();
    });
  }

  it("exposes deadlines only for the active provider", async () => {
    const clock = new FakeClock();
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: async (host) => availableSnapshot(host.provider!),
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    lifecycle.sessionStart(createHost());
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, NOW + 60);

    lifecycle.modelSelect(createKimiHost());
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.current?.status, "available");
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, undefined);
    assert.equal(lifecycle.getState("kimi-coding")?.nextAutomaticAt, NOW + 60);
    lifecycle.sessionShutdown();
  });
});

describe("quota lifecycle: failure backoff", () => {
  it("uses 2-minute, 5-minute, then capped 15-minute automatic retry delays", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const fetchSnapshot = async (host: QuotaHost): Promise<QuotaSnapshot> => {
      fetches += 1;
      return fetches === 5
        ? availableSnapshot(host.provider!, [], clock.nowSeconds)
        : {
            status: "unavailable",
            provider: host.provider!,
            reason: "transient",
            source: { kind: "experimental", fetchedAtSeconds: clock.nowSeconds },
          };
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 120);

    await heartbeat(clock, 2);
    assert.equal(fetches, 2);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 420);

    await heartbeat(clock, 5);
    assert.equal(fetches, 3);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 1_320);

    await heartbeat(clock, 15);
    assert.equal(fetches, 4);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 2_220);

    await heartbeat(clock, 15);
    assert.equal(fetches, 5);
    assert.equal(lifecycle.getState(host.provider!)?.consecutiveFailures, 0);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 3_120);

    lifecycle.sessionShutdown();
  });
});

describe("quota lifecycle: stale last renderable state", () => {
  it("preserves same-provider renderable data, marks it stale, and warns on the quota icon", async () => {
    let fetches = 0;
    const { fetchFn } = stubFetch(() => {
      fetches += 1;
      if (fetches === 1) return jsonResponse(200, VALID_PAYLOAD);
      throw new TypeError("network unavailable");
    });
    const statusCalls: Array<string | undefined> = [];
    const host: QuotaHost = {
      ...createHost(),
      ui: { setStatus: (_id, text) => statusCalls.push(text) },
      theme: { fg: (color, text) => `[${color}:${text}]` },
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => NOW }, signal),
      nowSeconds: () => NOW,
    });

    lifecycle.sessionStart(host);
    await flushAsync();
    lifecycle.agentStart(host);
    await flushAsync();

    const state = lifecycle.getState("openai-codex");
    assert.equal(state?.current?.status, "unavailable");
    assert.equal(state?.lastRenderable?.status, "available");
    assert.equal(state?.stale, true);
    assert.equal(state?.consecutiveFailures, 1);
    assert.match(statusCalls.at(-1) ?? "", /^\[warning:◷\] \[muted:5h: 58%/u);
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
    const host: QuotaHost = {
      ...createHost(),
      ui: { setStatus: (_id, text) => statusCalls.push(text) },
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => NOW }, signal),
      nowSeconds: () => NOW,
    });

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
  it("clears the footer and heartbeat without fetching unsupported providers", async () => {
    const clock = new FakeClock();
    const statusCalls: Array<string | undefined> = [];
    const supportedHost: QuotaHost = {
      ...createHost(),
      ui: { setStatus: (_id, text) => statusCalls.push(text) },
    };
    const { fetchFn, calls } = stubFetch(() => jsonResponse(200, VALID_PAYLOAD));
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => clock.nowSeconds }, signal),
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });

    lifecycle.sessionStart(supportedHost);
    await flushAsync();
    assert.notEqual(statusCalls.at(-1), undefined);

    const unsupportedHost: QuotaHost = {
      ...supportedHost,
      provider: "anthropic",
      providerBaseUrl: "https://api.anthropic.com",
    };
    lifecycle.modelSelect(unsupportedHost);
    await flushAsync();
    await heartbeat(clock);

    assert.equal(statusCalls.at(-1), undefined);
    assert.equal(calls.length, 1);
    assert.equal(clock.pendingTimers, 0);
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
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => NOW }, signal),
      nowSeconds: () => NOW,
      scheduleHeartbeat: (callback, delay) => {
        const timeout = setTimeout(callback, delay);
        timeout.unref();
        return () => clearTimeout(timeout);
      },
    });

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
    lifecycle.sessionShutdown();
  });
});

describe("quota lifecycle: provider contract mismatch", () => {
  it("maps a mismatched snapshot to a provider-specific failure", async () => {
    let fetches = 0;
    const fetchSnapshot = async (): Promise<QuotaSnapshot> => {
      fetches += 1;
      return {
        status: "unavailable",
        provider: "kimi-coding",
        reason: "transient",
        source: { kind: "experimental", fetchedAtSeconds: NOW },
      };
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => NOW,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    lifecycle.agentStart(host);
    await flushAsync();

    assert.equal(fetches, 2);
    assert.equal(lifecycle.getState("openai-codex")?.current?.provider, "openai-codex");
    assert.equal(lifecycle.getState("openai-codex")?.current?.status, "unavailable");
    assert.equal(lifecycle.getState("openai-codex")?.consecutiveFailures, 2);
  });

  it("applies failure backoff after a mismatched snapshot", async () => {
    const clock = new FakeClock();
    let fetches = 0;
    const fetchSnapshot = async (): Promise<QuotaSnapshot> => {
      fetches += 1;
      return {
        status: "unavailable",
        provider: "kimi-coding",
        reason: "transient",
        source: { kind: "experimental", fetchedAtSeconds: clock.nowSeconds },
      };
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    assert.equal(fetches, 1);
    assert.equal(lifecycle.getState(host.provider!)?.nextAutomaticAt, NOW + 120);

    await heartbeat(clock);
    assert.equal(fetches, 1);
    await heartbeat(clock);
    assert.equal(fetches, 2);
    lifecycle.sessionShutdown();
  });
});

describe("quota lifecycle: cancellation", () => {
  it("lets a caller stop waiting without cancelling shared provider work", async () => {
    const response = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response.promise;
    }) as typeof fetch;
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => NOW }, signal),
      nowSeconds: () => NOW,
      scheduleHeartbeat: (callback, delay) => {
        const timeout = setTimeout(callback, delay);
        timeout.unref();
        return () => clearTimeout(timeout);
      },
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    const external = new AbortController();
    const inspection = lifecycle.refreshProviders([host], external.signal);
    await flushAsync();
    external.abort(new Error("caller stopped waiting"));

    const [stateBeforeCompletion] = await inspection;
    assert.equal(requestSignal?.aborted, false);
    assert.equal(stateBeforeCompletion?.current, undefined);

    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    await flushAsync();
    assert.equal(lifecycle.getState("openai-codex")?.current?.status, "available");
    lifecycle.sessionShutdown();
  });

  it("aborts in-flight work and clears runtime state during shutdown", async () => {
    const response = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return response.promise;
    }) as typeof fetch;
    const clock = new FakeClock();
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => clock.nowSeconds }, signal),
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });

    lifecycle.sessionStart(createHost());
    await flushAsync();
    lifecycle.sessionShutdown();

    assert.equal(requestSignal?.aborted, true);
    assert.equal(clock.pendingTimers, 0);
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
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => clock.nowSeconds }, signal),
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
      scheduleHeartbeat: clock.scheduleTimeout,
    });

    lifecycle.sessionStart(createHost());
    await flushAsync();
    assert.equal(requestSignal?.aborted, false);

    clock.advance(8);
    await flushAsync();

    assert.equal(requestSignal?.aborted, true);
    assert.equal(clock.pendingTimers, 1);
    assert.equal(lifecycle.getState("openai-codex")?.current?.status, "unavailable");
    assert.equal(lifecycle.getState("openai-codex")?.consecutiveFailures, 1);
    assert.equal(lifecycle.getState("openai-codex")?.lastCompletedAt, NOW + 8);
    assert.equal(lifecycle.getState("openai-codex")?.nextAutomaticAt, NOW + 128);

    lifecycle.sessionShutdown();
  });
});

describe("quota lifecycle: /quota refresh", () => {
  it("force-refreshes every provider on every invocation without reusing completed state", async () => {
    const started: string[] = [];
    const fetchSnapshot = async (host: QuotaHost): Promise<QuotaSnapshot> => {
      started.push(host.provider!);
      return availableSnapshot(host.provider!);
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => NOW,
    });
    const hosts: QuotaHost[] = [
      createHost(),
      createKimiHost(),
      { ...createHost(), provider: "zai", providerBaseUrl: "https://api.z.ai" },
    ];

    await lifecycle.refreshProviders(hosts);
    await lifecycle.refreshProviders(hosts);

    assert.deepEqual(started, [
      "openai-codex", "kimi-coding", "zai",
      "openai-codex", "kimi-coding", "zai",
    ]);
    assert.ok((await lifecycle.refreshProviders(hosts))[0]?.current?.status === "available");
  });

  it("starts all provider requests in parallel and returns each provider state", async () => {
    const started: string[] = [];
    const pending = new Map<string, ReturnType<typeof deferred<QuotaSnapshot>>>();
    const fetchSnapshot = (host: QuotaHost): Promise<QuotaSnapshot> => {
      const provider = host.provider!;
      started.push(provider);
      const request = deferred<QuotaSnapshot>();
      pending.set(provider, request);
      return request.promise;
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => NOW,
    });
    const hosts: QuotaHost[] = [
      createHost(),
      createKimiHost(),
      { ...createHost(), provider: "zai", providerBaseUrl: "https://api.z.ai" },
    ];

    const inspection = lifecycle.refreshProviders(hosts);
    await flushAsync();
    assert.deepEqual(started.sort(), ["kimi-coding", "openai-codex", "zai"]);

    for (const provider of started) {
      pending.get(provider)!.resolve({
        status: "unavailable",
        provider,
        reason: "auth-unavailable",
        source: { kind: "experimental", fetchedAtSeconds: NOW },
      });
    }
    const states = await inspection;

    assert.equal(states.length, 3);
    assert.ok(states.every((state) => state.current?.status === "unavailable"));
  });

  it("coalesces /quota with a provider request already in flight", async () => {
    const response = deferred<Response>();
    const { fetchFn, calls } = stubFetch(() => response.promise);
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, { fetchFn, nowSeconds: () => NOW }, signal),
      nowSeconds: () => NOW,
      scheduleHeartbeat: (callback, delay) => {
        const timeout = setTimeout(callback, delay);
        timeout.unref();
        return () => clearTimeout(timeout);
      },
    });
    const host = createHost();

    lifecycle.sessionStart(host);
    await flushAsync();
    const inspection = lifecycle.refreshProviders([host]);
    await flushAsync();
    assert.equal(calls.length, 1);

    response.resolve(jsonResponse(200, VALID_PAYLOAD));
    const [state] = await inspection;
    assert.equal(state?.current?.status, "available");
    lifecycle.sessionShutdown();
  });

  it("applies the eight-second timeout policy to provider refreshes", async () => {
    const clock = new FakeClock();
    let requestSignal: AbortSignal | undefined;
    const fetchSnapshot = async (
      _host: QuotaHost,
      signal: AbortSignal,
    ): Promise<QuotaSnapshot> => {
      requestSignal = signal;
      return new Promise<QuotaSnapshot>(() => {});
    };
    const lifecycle = new QuotaLifecycle({
      fetchSnapshot,
      nowSeconds: () => clock.nowSeconds,
      scheduleTimeout: clock.scheduleTimeout,
    });

    const inspection = lifecycle.refreshProviders([createHost()]);
    await flushAsync();
    clock.advance(8);
    const [state] = await inspection;

    assert.equal(requestSignal?.aborted, true);
    assert.equal(state?.current?.status, "unavailable");
    assert.equal(clock.pendingTimers, 0);
  });
});
