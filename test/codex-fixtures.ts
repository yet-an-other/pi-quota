import assert from "node:assert/strict";
import type { CodexAdapterDeps } from "../src/providers/codex.ts";

export const NOW = 1_735_689_000;

export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

export const VALID_TOKEN = fakeJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
});

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

export function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = async (input: unknown, init?: { headers?: unknown }) => {
    const call: FetchCall = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return handler(call);
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

export function codexDeps(overrides: Partial<CodexAdapterDeps> = {}): CodexAdapterDeps {
  return {
    resolveAuth: async () => ({
      apiKey: VALID_TOKEN,
      baseUrl: "https://chatgpt.com/backend-api",
    }),
    fetchFn: stubFetch(() => jsonResponse(200, VALID_PAYLOAD)).fetchFn,
    nowSeconds: () => NOW,
    ...overrides,
  };
}

export const VALID_PAYLOAD = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18000,
      reset_after_seconds: 120,
      reset_at: NOW + 720,
    },
    secondary_window: {
      used_percent: 5,
      limit_window_seconds: 604800,
      reset_after_seconds: 43200,
      reset_at: NOW + 432000,
    },
  },
};


export function assertUnavailable(snapshot: unknown, reason: string): void {
  assert.equal((snapshot as { status: string }).status, "unavailable");
  assert.equal((snapshot as { reason: string }).reason, reason);
}
