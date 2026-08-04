/**
 * Mocked Pi extension host: captures event subscriptions from ExtensionAPI and
 * lets tests drive lifecycle events with a mocked ExtensionContext.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface StatusCall {
  id: string;
  text: string | undefined;
}

export interface MockContextOptions {
  mode?: string;
  provider?: string;
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
      await handler(eventPayload, ctx);
    },
  };
}

export function createContext(options: MockContextOptions = {}) {
  const statusCalls: StatusCall[] = [];

  const ctx = {
    mode: options.mode ?? "tui",
    model: options.provider === undefined ? undefined : { provider: options.provider },
    ui: {
      setStatus(id: string, text: string | undefined) {
        statusCalls.push({ id, text });
      },
    },
  };

  return { ctx, statusCalls };
}
