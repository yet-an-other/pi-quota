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

export interface NotificationCall {
  message: string;
  type: "info" | "warning" | "error" | undefined;
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
  authByProvider?: Readonly<Record<string, {
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
  } | undefined>>;
  providerBaseUrls?: Readonly<Record<string, string | undefined>>;
}

export function createExtensionHost() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();

  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    registeredEvents(): string[] {
      return [...handlers.keys()];
    },
    registeredCommands(): string[] {
      return [...commands.keys()];
    },
    async runCommand(name: string, args: string, ctx: unknown): Promise<void> {
      const handler = commands.get(name);
      if (!handler) throw new Error(`No command registered for ${name}`);
      await handler(args, ctx);
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
  const notifications: NotificationCall[] = [];
  const customViews: string[][] = [];
  const theme = {
    fg(color: string, text: string) {
      themeCalls.push({ color, text });
      return text;
    },
    bold(text: string) {
      return text;
    },
  };

  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: (options.mode ?? "tui") === "tui" || options.mode === "rpc",
    signal: undefined,
    model:
      options.provider === undefined
        ? undefined
        : {
            provider: options.provider,
            ...(options.modelBaseUrl === undefined ? {} : { baseUrl: options.modelBaseUrl }),
          },
    ui: {
      theme,
      setStatus(id: string, text: string | undefined) {
        statusCalls.push({ id, text });
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      async custom(factory: (
        tui: { requestRender(): void },
        currentTheme: typeof theme,
        keybindings: object,
        done: (result: undefined) => void,
      ) => { render(width: number): string[] } | Promise<{ render(width: number): string[] }>) {
        const component = await factory({ requestRender() {} }, theme, {}, () => {});
        customViews.push(component.render(120));
        return undefined;
      },
    },
    modelRegistry: {
      getProvider(provider: string) {
        const baseUrl = options.providerBaseUrls?.[provider];
        return baseUrl === undefined ? undefined : { baseUrl };
      },
      async getProviderAuth(provider: string) {
        const auth = options.authByProvider?.[provider] ?? options.auth;
        return auth === undefined ? undefined : { auth };
      },
    },
  };

  return { ctx, statusCalls, themeCalls, notifications, customViews };
}
