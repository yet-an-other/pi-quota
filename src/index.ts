import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import {
  QuotaLifecycle,
  type QuotaLifecycleDeps,
  type QuotaLifecycleHost,
  type ScheduleTimeout,
} from "./quota-lifecycle.ts";
import { renderQuotaDetails } from "./quota-render.ts";
import { SUPPORTED_PROVIDERS } from "./supported-providers.ts";

export interface PiQuotaDeps {
  readonly fetchFn?: typeof fetch;
  readonly nowSeconds?: () => number;
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: ScheduleTimeout;
}

async function showQuotaDetails(
  details: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.ui.custom((_tui, theme, _keybindings, done) => {
    const buildContainer = () => {
      const container = new Container();
      const border = new DynamicBorder((text: string) => theme.fg("accent", text));
      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold("Provider quota")), 1, 0));
      container.addChild(new Text(details, 1, 1));
      container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
      container.addChild(border);
      return container;
    };
    let container = buildContainer();
    return {
      render: (width: number) => container.render(width),
      invalidate: () => {
        container = buildContainer();
      },
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
      },
    };
  });
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
    provider: string | undefined,
    providerBaseUrl: string | undefined,
  ): QuotaLifecycleHost => ({
    mode: ctx.mode,
    provider,
    providerBaseUrl,
    ui: ctx.ui,
    theme: ctx.ui.theme,
    resolveAuth: async (provider) => (await ctx.modelRegistry.getProviderAuth(provider))?.auth,
  });

  const activeHostFor = (ctx: ExtensionContext) =>
    hostFor(ctx, ctx.model?.provider, ctx.model?.baseUrl);

  pi.registerCommand("quota", {
    description: "Show provider quota details or refresh the active provider",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;

      const action = args.trim();
      if (action === "refresh") {
        const state = await lifecycle.manualRefresh(activeHostFor(ctx), ctx.signal);
        const refreshed =
          state?.current?.status === "available" || state?.current?.status === "degraded";
        ctx.ui.notify(
          refreshed ? "Quota refreshed" : "Quota refresh failed",
          refreshed ? "info" : "warning",
        );
        return;
      }
      if (action !== "") {
        ctx.ui.notify("Usage: /quota [refresh]", "warning");
        return;
      }

      const hosts = SUPPORTED_PROVIDERS.map(({ id }) => {
        const baseUrl = ctx.model?.provider === id
          ? ctx.model.baseUrl
          : ctx.modelRegistry.getProvider(id)?.baseUrl;
        return hostFor(ctx, id, baseUrl);
      });
      const states = await lifecycle.inspectProviders(hosts, ctx.signal);
      const details = renderQuotaDetails(
        states,
        ctx.model?.provider,
        lifecycleDeps.nowSeconds(),
      );
      await showQuotaDetails(details, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lifecycle.sessionStart(activeHostFor(ctx), ctx.signal);
  });
  pi.on("model_select", (event, ctx) => {
    lifecycle.modelSelect(hostFor(ctx, event.model.provider, event.model.baseUrl), ctx.signal);
  });
  pi.on("agent_settled", (_event, ctx) => {
    lifecycle.agentSettled(activeHostFor(ctx), ctx.signal);
  });
  pi.on("session_shutdown", () => {
    lifecycle.sessionShutdown();
  });
}
