import assert from "node:assert/strict";
import type { ProviderAdapterDeps } from "../src/quota-contract.ts";

export const NOW = 1_735_689_000;
export const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const VALID_PAYLOAD = {
  data: {
    level: "pro",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        usage: 800000000,
        currentValue: 127694464,
        remaining: 672305536,
        percentage: 16,
        nextResetTime: (NOW + 4 * 60 * 60) * 1000,
      },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 1828,
        remaining: 2172,
        percentage: 45,
        nextResetTime: (NOW + 30 * 24 * 60 * 60) * 1000,
        usageDetails: [{ modelCode: "search-prime", usage: 1433 }],
      },
    ],
  },
};

export interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
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
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

export function zaiDeps(overrides: Partial<ProviderAdapterDeps> = {}): ProviderAdapterDeps {
  return {
    providerBaseUrl: ZAI_BASE_URL,
    resolveAuth: async () => ({ apiKey: "zai-test-key" }),
    fetchFn: stubFetch(() => jsonResponse(200, VALID_PAYLOAD)).fetchFn,
    nowSeconds: () => NOW,
    ...overrides,
  };
}

export function assertUnavailable(snapshot: unknown, reason: string): void {
  assert.equal((snapshot as { status: string }).status, "unavailable");
  assert.equal((snapshot as { reason: string }).reason, reason);
}
