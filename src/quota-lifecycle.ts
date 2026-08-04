/**
 * Provider-agnostic quota refresh lifecycle and session-memory quota state.
 *
 * The lifecycle is event-driven: session/model activation starts one refresh,
 * settled activity may start a throttled refresh, and shutdown cancels work.
 * It owns timeout, coalescing, cancellation, stale fallback, and failure
 * backoff. No timers survive an in-flight request.
 */

import type { QuotaSnapshot } from "./quota-contract.ts";
import {
  clearProviderStatus,
  fetchProviderQuotaSnapshot,
  isSupportedProvider,
  renderProviderStatus,
  unavailableProviderQuotaSnapshot,
  type ProviderStatusDeps,
  type ProviderStatusHost,
} from "./provider-status.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const AUTOMATIC_THROTTLE_SECONDS = 60;
const FAILURE_BACKOFF_SECONDS = [120, 300, 900] as const;

type RenderableQuotaSnapshot = Extract<QuotaSnapshot, { status: "available" | "degraded" }>;

export interface QuotaState {
  readonly provider: string;
  readonly lastRenderable?: RenderableQuotaSnapshot;
  readonly current?: QuotaSnapshot;
  readonly stale: boolean;
  readonly consecutiveFailures: number;
  /** Unix epoch seconds of the latest completed, non-discarded fetch. */
  readonly lastCompletedAt?: number;
  /** Unix epoch seconds before which automatic triggers are ignored. */
  readonly nextAutomaticAt?: number;
}

export type QuotaLifecycleHost = ProviderStatusHost;

/** Returns a cancellation function for this request-scoped timeout. */
export type ScheduleTimeout = (callback: () => void, delayMilliseconds: number) => () => void;

export interface QuotaLifecycleDeps extends ProviderStatusDeps {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: ScheduleTimeout;
  /** Provider adapter seam; defaults to the built-in provider router. */
  readonly fetchSnapshot?: typeof fetchProviderQuotaSnapshot;
}

interface InFlightRequest {
  readonly provider: string;
  readonly controller: AbortController;
  readonly cancelTimeout: () => void;
  readonly cancelExternalAbort: () => void;
}

function defaultScheduleTimeout(callback: () => void, delayMilliseconds: number): () => void {
  const timeout = setTimeout(callback, delayMilliseconds);
  return () => clearTimeout(timeout);
}

function failureDelaySeconds(consecutiveFailures: number): number {
  return FAILURE_BACKOFF_SECONDS[
    Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_SECONDS.length - 1)
  ];
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Quota refresh aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("Quota refresh aborted")),
      { once: true },
    );
  });
}

/** Deep lifecycle module used by the thin Pi event-registration entry. */
export class QuotaLifecycle {
  private readonly deps: QuotaLifecycleDeps;
  private readonly states = new Map<string, QuotaState>();
  private activeHost: QuotaLifecycleHost | undefined;
  private inFlight: InFlightRequest | undefined;

  constructor(deps: QuotaLifecycleDeps) {
    this.deps = deps;
  }

  /** Starts a fresh session-memory lifecycle and refreshes a supported provider. */
  sessionStart(host: QuotaLifecycleHost, signal?: AbortSignal): void {
    this.abortInFlight();
    this.states.clear();
    this.activate(host, signal);
  }

  /** Switches active provider, cancelling old work and clearing old UI first. */
  modelSelect(host: QuotaLifecycleHost, signal?: AbortSignal): void {
    const previousProvider = this.activeHost?.provider;
    this.abortInFlight();
    if (previousProvider !== undefined) this.states.delete(previousProvider);
    if (host.provider !== undefined) this.states.delete(host.provider);
    this.activate(host, signal);
  }

  /** Refreshes after settled work only when throttle/backoff permits it. */
  agentSettled(host: QuotaLifecycleHost, signal?: AbortSignal): void {
    if (!this.matchesActive(host)) return;
    this.activeHost = host;
    this.startRefresh(host, false, signal);
  }

  /** Cancels session work and drops all in-memory quota state. */
  sessionShutdown(): void {
    const host = this.activeHost;
    this.activeHost = undefined;
    this.abortInFlight();
    this.states.clear();
    if (host !== undefined) clearProviderStatus(host);
  }

  /** Read-only state seam for later diagnostics and focused tests. */
  getState(provider: string): QuotaState | undefined {
    return this.states.get(provider);
  }

  private activate(host: QuotaLifecycleHost, signal: AbortSignal | undefined): void {
    this.activeHost = undefined;
    clearProviderStatus(host);

    if (host.mode !== "tui" || !isSupportedProvider(host.provider)) return;

    this.activeHost = host;
    if (!this.states.has(host.provider)) {
      this.states.set(host.provider, {
        provider: host.provider,
        stale: false,
        consecutiveFailures: 0,
      });
    }
    this.startRefresh(host, true, signal);
  }

  private matchesActive(host: QuotaLifecycleHost): boolean {
    return (
      this.activeHost !== undefined &&
      this.activeHost.provider === host.provider &&
      this.activeHost.providerBaseUrl === host.providerBaseUrl
    );
  }

  private startRefresh(
    host: QuotaLifecycleHost,
    force: boolean,
    externalSignal: AbortSignal | undefined,
  ): void {
    const provider = host.provider;
    if (!isSupportedProvider(provider) || !this.matchesActive(host)) return;

    if (this.inFlight !== undefined) {
      // One request per extension instance. Same-provider triggers coalesce;
      // stale provider work is cancelled before activate() installs a host.
      return;
    }

    const state = this.states.get(provider);
    if (state === undefined) return;
    const nowSeconds = this.deps.nowSeconds();
    if (!force && state.nextAutomaticAt !== undefined && nowSeconds < state.nextAutomaticAt) {
      return;
    }

    const controller = new AbortController();
    const cancelTimeout = (this.deps.scheduleTimeout ?? defaultScheduleTimeout)(
      () => controller.abort(new Error("Quota refresh timed out")),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const request: InFlightRequest = {
      provider,
      controller,
      cancelTimeout,
      cancelExternalAbort: () => externalSignal?.removeEventListener("abort", onExternalAbort),
    };
    this.inFlight = request;
    void this.completeRefresh(request, host);
  }

  private async completeRefresh(
    request: InFlightRequest,
    host: QuotaLifecycleHost,
  ): Promise<void> {
    let snapshot: QuotaSnapshot | undefined;
    try {
      snapshot = await Promise.race([
        (this.deps.fetchSnapshot ?? fetchProviderQuotaSnapshot)(
          host,
          this.deps,
          request.controller.signal,
        ),
        aborted(request.controller.signal),
      ]);
    } catch {
      snapshot = unavailableProviderQuotaSnapshot(
        request.provider,
        "transient",
        this.deps.nowSeconds(),
      );
    } finally {
      request.cancelTimeout();
      request.cancelExternalAbort();
    }

    if (this.inFlight !== request) return;
    this.inFlight = undefined;
    if (
      snapshot === undefined ||
      this.activeHost === undefined ||
      this.activeHost.provider !== request.provider ||
      snapshot.provider !== request.provider
    ) {
      return;
    }

    const previous = this.states.get(request.provider);
    if (previous === undefined) return;

    const completedAt = this.deps.nowSeconds();
    if (snapshot.status === "available" || snapshot.status === "degraded") {
      const next: QuotaState = {
        provider: request.provider,
        current: snapshot,
        lastRenderable: snapshot,
        stale: false,
        consecutiveFailures: 0,
        lastCompletedAt: completedAt,
        nextAutomaticAt: completedAt + AUTOMATIC_THROTTLE_SECONDS,
      };
      this.states.set(request.provider, next);
      renderProviderStatus(host, snapshot, this.deps, false);
      return;
    }

    const consecutiveFailures = previous.consecutiveFailures + 1;
    const next: QuotaState = {
      provider: request.provider,
      current: snapshot,
      ...(previous.lastRenderable === undefined
        ? {}
        : { lastRenderable: previous.lastRenderable }),
      stale: previous.lastRenderable !== undefined,
      consecutiveFailures,
      lastCompletedAt: completedAt,
      nextAutomaticAt: completedAt + failureDelaySeconds(consecutiveFailures),
    };
    this.states.set(request.provider, next);
    if (next.lastRenderable !== undefined) {
      renderProviderStatus(host, next.lastRenderable, this.deps, true);
    }
  }

  private abortInFlight(): void {
    const request = this.inFlight;
    this.inFlight = undefined;
    if (request === undefined) return;
    request.cancelTimeout();
    request.cancelExternalAbort();
    request.controller.abort(new Error("Quota refresh cancelled"));
  }
}
