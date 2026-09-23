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
  type ScheduleTimeout,
} from "./quota-lifecycle.ts";
import type { QuotaHost } from "./quota-host.ts";
import { fetchProviderQuotaSnapshot, isSupportedProvider, PROVIDER_ADAPTERS } from "./provider-registry.ts";
import { renderQuotaDetails } from "./quota-details.ts";

export interface PiQuotaDeps {
  readonly fetchFn?: typeof fetch;
  readonly nowSeconds?: () => number;
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: ScheduleTimeout;
  readonly scheduleHeartbeat?: ScheduleTimeout;
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
  const providerDeps = {
    fetchFn: deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    nowSeconds: deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
  };
  const lifecycleDeps: QuotaLifecycleDeps = {
    fetchSnapshot: (host, signal) => fetchProviderQuotaSnapshot(host, providerDeps, signal),
    nowSeconds: providerDeps.nowSeconds,
    get width() {
      return process.stdout.columns;
    },
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.scheduleTimeout === undefined ? {} : { scheduleTimeout: deps.scheduleTimeout }),
    ...(deps.scheduleHeartbeat === undefined ? {} : { scheduleHeartbeat: deps.scheduleHeartbeat }),
  };
  const lifecycle = new QuotaLifecycle(lifecycleDeps);

  const hostFor = (
    ctx: ExtensionContext,
    provider: string | undefined,
    providerBaseUrl: string | undefined,
  ): QuotaHost => ({
    mode: ctx.mode,
    provider,
    providerBaseUrl,
    ui: ctx.ui,
    theme: ctx.ui.theme,
    resolveAuth: async (provider) => (await ctx.modelRegistry.getProviderAuth(provider))?.auth,
  });

  const allProviderHostsFor = (ctx: ExtensionContext) =>
    PROVIDER_ADAPTERS.map(({ id }) => {
      const baseUrl = ctx.model?.provider === id
        ? ctx.model.baseUrl
        : ctx.modelRegistry.getProvider(id)?.baseUrl;
      return hostFor(ctx, id, baseUrl);
    });

  pi.registerCommand("quota", {
    description: "Show current provider quota details",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;

      const action = args.trim();
      if (action !== "") {
        ctx.ui.notify("Usage: /quota", "warning");
        return;
      }

      const states = await lifecycle.refreshProviders(allProviderHostsFor(ctx), ctx.signal);
      const details = renderQuotaDetails(
        states,
        ctx.model?.provider,
        lifecycleDeps.nowSeconds(),
      );
      await showQuotaDetails(details, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lifecycle.sessionStart(
      hostFor(ctx, ctx.model?.provider, ctx.model?.baseUrl),
      ctx.signal,
    );
  });
  pi.on("model_select", (event, ctx) => {
    lifecycle.modelSelect(hostFor(ctx, event.model.provider, event.model.baseUrl), ctx.signal);
  });
  pi.on("agent_start", (_event, ctx) => {
    lifecycle.agentStart(
      hostFor(ctx, ctx.model?.provider, ctx.model?.baseUrl),
      ctx.signal,
    );
  });
  pi.on("agent_settled", (_event, ctx) => {
    lifecycle.agentSettled(
      hostFor(ctx, ctx.model?.provider, ctx.model?.baseUrl),
      ctx.signal,
    );
  });
  pi.on("session_shutdown", () => {
    lifecycle.sessionShutdown();
  });
}
