import assert from "node:assert/strict";
import type { KimiAdapterDeps } from "../src/providers/kimi.ts";

export const NOW = 1_735_689_000;
export const WEEKLY_RESET = new Date((NOW + 5 * 86400) * 1000).toISOString();
export const FIVE_HOUR_RESET = new Date((NOW + 3 * 3600 + 12 * 60) * 1000).toISOString();

export const VALID_PAYLOAD = {
  usage: {
    limit: "1000",
    used: "250",
    remaining: "750",
    resetTime: WEEKLY_RESET,
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "40",
        remaining: "60",
        resetTime: FIVE_HOUR_RESET,
      },
    },
  ],
};

export interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = async (input: unknown, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

export function kimiDeps(overrides: Partial<KimiAdapterDeps> = {}): KimiAdapterDeps {
  return {
    resolveAuth: async () => ({
      headers: { Authorization: "Bearer kimi-test-token" },
      baseUrl: "https://api.kimi.com/coding",
    }),
    fetchFn: stubFetch(() => jsonResponse(200, VALID_PAYLOAD)).fetchFn,
    nowSeconds: () => NOW,
    ...overrides,
  };
}

export function assertUnavailable(snapshot: unknown, reason: string): void {
  assert.equal((snapshot as { status: string }).status, "unavailable");
  assert.equal((snapshot as { reason: string }).reason, reason);
}
