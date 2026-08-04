import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_STATUS_ID, refreshProviderStatus, type ProviderStatusDeps } from "./provider-status.ts";

export interface PiQuotaDeps {
  readonly fetchFn?: typeof fetch;
  readonly nowSeconds?: () => number;
}

export default function registerExtension(pi: ExtensionAPI, deps: PiQuotaDeps = {}): void {
  const resolvedDeps = {
    fetchFn: deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    nowSeconds: deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
  };

  const refresh = async (ctx: ExtensionContext, provider: string | undefined): Promise<void> => {
    const statusDeps: ProviderStatusDeps = {
      ...resolvedDeps,
      width: process.stdout.columns,
    };
    try {
      await refreshProviderStatus(
        {
          mode: ctx.mode,
          provider,
          ui: ctx.ui,
          theme: ctx.ui.theme,
          resolveAuth: async (id) => (await ctx.modelRegistry.getProviderAuth(id))?.auth,
        },
        statusDeps,
      );
    } catch {
      // Adapter throws are programmer defects; the footer must never break Pi.
      // TODO(quota-state slice): treat as transient and preserve the last
      // renderable quota snapshot instead of clearing.
      ctx.ui.setStatus(PROVIDER_STATUS_ID, undefined);
    }
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx, ctx.model?.provider));
  pi.on("model_select", (event, ctx) => refresh(ctx, event.model?.provider));
}
