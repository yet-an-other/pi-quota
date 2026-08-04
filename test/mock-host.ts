/**
 * Mocked Pi extension host: captures event subscriptions from ExtensionAPI and
 * lets tests drive lifecycle events with a mocked ExtensionContext.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface StatusCall {
  id: string;
  text: string | undefined;
}

export interface ThemeCall {
  color: string;
  text: string;
}

export interface MockContextOptions {
  mode?: string;
  provider?: string;
  modelBaseUrl?: string;
  auth?: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
  };
}

export function createExtensionHost() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    registeredEvents(): string[] {
      return [...handlers.keys()];
    },
    async emit(event: string, eventPayload: unknown, ctx: unknown): Promise<void> {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`No handler registered for ${event}`);
      if (
        event === "model_select" &&
        typeof ctx === "object" &&
        ctx !== null &&
        typeof eventPayload === "object" &&
        eventPayload !== null &&
        "model" in eventPayload
      ) {
        (ctx as { model?: unknown }).model = eventPayload.model;
      }
      await handler(eventPayload, ctx);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async flush(): Promise<void> {
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

export function createContext(options: MockContextOptions = {}) {
  const statusCalls: StatusCall[] = [];
  const themeCalls: ThemeCall[] = [];

  const ctx = {
    mode: options.mode ?? "tui",
    model:
      options.provider === undefined
        ? undefined
        : {
            provider: options.provider,
            ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }),
          },
    ui: {
      theme: {
        fg(color: string, text: string) {
          themeCalls.push({ color, text });
          return text;
        },
      },
      setStatus(id: string, text: string | undefined) {
        statusCalls.push({ id, text });
      },
    },
    modelRegistry: {
      async getProviderAuth(_provider: string) {
        return options.auth === undefined ? undefined : { auth: options.auth };
      },
    },
  };

  return { ctx, statusCalls, themeCalls };
}
