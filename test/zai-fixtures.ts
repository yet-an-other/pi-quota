import assert from "node:assert/strict";
import type { ProviderAdapterDeps } from "../src/quota-contract.ts";

export const NOW = 1_735_689_000;
export const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const VALID_PAYLOAD = {
  code: 200,
  msg: "Operation successful",
  data: {
    level: "lite",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 285,
        remaining: 1714,
        percentage: 14,
        nextResetTime: (NOW + 4 * 60 * 60) * 1000,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 1209,
        remaining: 8790,
        percentage: 12,
        nextResetTime: (NOW + 6 * 24 * 60 * 60) * 1000,
      },
    ],
  },
  success: true,
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
