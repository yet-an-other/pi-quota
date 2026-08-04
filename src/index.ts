import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  QuotaLifecycle,
  type QuotaLifecycleDeps,
  type QuotaLifecycleHost,
  type ScheduleTimeout,
} from "./quota-lifecycle.ts";

export interface PiQuotaDeps {
  readonly fetchFn?: typeof fetch;
  readonly nowSeconds?: () => number;
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: ScheduleTimeout;
}

export default function registerExtension(pi: ExtensionAPI, deps: PiQuotaDeps = {}): void {
  const lifecycleDeps: QuotaLifecycleDeps = {
    fetchFn: deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    nowSeconds: deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
    get width() {
      return process.stdout.columns;
    },
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.scheduleTimeout === undefined ? {} : { scheduleTimeout: deps.scheduleTimeout }),
  };
  const lifecycle = new QuotaLifecycle(lifecycleDeps);

  const hostFor = (
    ctx: ExtensionContext,
    model: { readonly provider: string; readonly baseUrl: string } | undefined,
  ): QuotaLifecycleHost => ({
    mode: ctx.mode,
    provider: model?.provider,
    providerBaseUrl: model?.baseUrl,
    ui: ctx.ui,
    theme: ctx.ui.theme,
    resolveAuth: async (provider) => (await ctx.modelRegistry.getProviderAuth(provider))?.auth,
  });

  pi.on("session_start", (_event, ctx) => {
    lifecycle.sessionStart(hostFor(ctx, ctx.model), ctx.signal);
  });
  pi.on("model_select", (event, ctx) => {
    lifecycle.modelSelect(hostFor(ctx, event.model), ctx.signal);
  });
  pi.on("agent_settled", (_event, ctx) => {
    lifecycle.agentSettled(hostFor(ctx, ctx.model), ctx.signal);
  });
  pi.on("session_shutdown", () => {
    lifecycle.sessionShutdown();
  });
}
