/**
 * Quota host: the Pi-side context the quota subsystem reads from at a seam.
 *
 * The Quota host carries what Pi supplies at runtime — the active mode,
 * provider, and base URL, the status UI and theme, and provider-auth
 * resolution. It is deliberately distinct from the environment capabilities
 * (clock, fetch, terminal width) the subsystem also depends on: those are
 * injected deps, not the Pi context, and live with their consumers.
 *
 * Every module that touches the Pi host — the quota lifecycle, the footer
 * presenter, and the provider fetch dispatch — imports this one type, so the
 * host contract has a single home and a single name. See CONTEXT.md,
 * "Quota host".
 */

import type { ResolvedProviderAuth } from "./quota-contract.ts";

/** The Pi-side context the quota subsystem reads from. */
export interface QuotaHost {
  readonly mode: string;
  readonly provider: string | undefined;
  /** Effective base URL of the active model, supplied by Pi. */
  readonly providerBaseUrl: string | undefined;
  readonly ui: {
    setStatus(id: string, text: string | undefined): void;
  };
  readonly theme: {
    fg(color: string, text: string): string;
  };
  resolveAuth(provider: string): Promise<ResolvedProviderAuth | undefined>;
}
