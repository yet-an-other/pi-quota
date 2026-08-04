/**
 * Provider-agnostic quota refresh lifecycle and session-memory quota state.
 *
 * The lifecycle is event-driven: session/model activation starts one refresh,
 * settled activity may start a throttled refresh, diagnostics lazily fetch
 * missing providers, and shutdown cancels work. It owns timeout, coalescing,
 * cancellation, stale fallback, and failure backoff. No timers survive an
 * in-flight request.
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
  readonly renderFooter: boolean;
}

interface InFlightEntry {
  readonly request: InFlightRequest;
  readonly promise: Promise<QuotaState | undefined>;
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
  private readonly inFlight = new Map<string, InFlightEntry>();
  private activeHost: QuotaLifecycleHost | undefined;

  constructor(deps: QuotaLifecycleDeps) {
    this.deps = deps;
  }

  /** Starts a fresh session-memory lifecycle and refreshes a supported provider. */
  sessionStart(host: QuotaLifecycleHost, signal?: AbortSignal): void {
    this.abortAllInFlight();
    this.states.clear();
    this.activate(host, signal);
  }

  /** Switches active provider, cancelling stale work and clearing old UI first. */
  modelSelect(host: QuotaLifecycleHost, signal?: AbortSignal): void {
    const previousProvider = this.activeHost?.provider;
    this.abortAllInFlight();
    if (
      previousProvider !== undefined &&
      this.states.get(previousProvider)?.current === undefined
    ) {
      this.states.delete(previousProvider);
    }
    this.activate(host, signal);
  }

  /** Refreshes after settled work only when throttle/backoff permits it. */
  agentSettled(host: QuotaLifecycleHost, signal?: AbortSignal): void {
    if (!this.matchesActive(host)) return;
    this.activeHost = host;
    this.startRefresh(host, false, true, true, signal);
  }

  /** Forces the active provider while coalescing with matching in-flight work. */
  async manualRefresh(
    host: QuotaLifecycleHost,
    signal?: AbortSignal,
  ): Promise<QuotaState | undefined> {
    if (host.mode !== "tui" || !this.matchesActive(host)) return undefined;
    return this.startRefresh(host, true, true, true, signal);
  }

  /**
   * Returns all requested provider states, reusing completed snapshots and
   * lazily fetching only providers that have never completed in this session.
   */
  async inspectProviders(
    hosts: readonly QuotaLifecycleHost[],
    signal?: AbortSignal,
  ): Promise<readonly QuotaState[]> {
    return Promise.all(hosts.map(async (host) => {
      const provider = host.provider;
      if (!isSupportedProvider(provider)) {
        throw new Error("Diagnostics require a supported provider host");
      }

      const state = this.ensureState(provider);
      if (state.current !== undefined) return state;

      await this.startRefresh(
        host,
        true,
        false,
        this.matchesActive(host),
        signal,
      );
      return this.states.get(provider) ?? state;
    }));
  }

  /** Cancels session work and drops all in-memory quota state. */
  sessionShutdown(): void {
    const host = this.activeHost;
    this.activeHost = undefined;
    this.abortAllInFlight();
    this.states.clear();
    if (host !== undefined) clearProviderStatus(host);
  }

  /** Read-only state seam for diagnostics and focused tests. */
  getState(provider: string): QuotaState | undefined {
    return this.states.get(provider);
  }

  private ensureState(provider: string): QuotaState {
    const existing = this.states.get(provider);
    if (existing !== undefined) return existing;
    const initial: QuotaState = {
      provider,
      stale: false,
      consecutiveFailures: 0,
    };
    this.states.set(provider, initial);
    return initial;
  }

  private activate(host: QuotaLifecycleHost, signal: AbortSignal | undefined): void {
    this.activeHost = undefined;
    clearProviderStatus(host);

    if (host.mode !== "tui" || !isSupportedProvider(host.provider)) return;

    this.activeHost = host;
    this.ensureState(host.provider);
    this.startRefresh(host, true, true, true, signal);
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
    requireActive: boolean,
    renderFooter: boolean,
    externalSignal: AbortSignal | undefined,
  ): Promise<QuotaState | undefined> | undefined {
    const provider = host.provider;
    if (!isSupportedProvider(provider) || (requireActive && !this.matchesActive(host))) {
      return undefined;
    }

    const existing = this.inFlight.get(provider);
    if (existing !== undefined) return existing.promise;

    const state = this.states.get(provider);
    if (state === undefined) return undefined;
    const nowSeconds = this.deps.nowSeconds();
    if (!force && state.nextAutomaticAt !== undefined && nowSeconds < state.nextAutomaticAt) {
      return undefined;
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
      renderFooter,
    };
    const promise = Promise.resolve().then(() => this.completeRefresh(request, host));
    this.inFlight.set(provider, { request, promise });
    return promise;
  }

  private async completeRefresh(
    request: InFlightRequest,
    host: QuotaLifecycleHost,
  ): Promise<QuotaState | undefined> {
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

    if (this.inFlight.get(request.provider)?.request !== request) return undefined;
    this.inFlight.delete(request.provider);
    if (snapshot === undefined || snapshot.provider !== request.provider) return undefined;

    const previous = this.states.get(request.provider);
    if (previous === undefined) return undefined;

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
      if (request.renderFooter && this.matchesActive(host)) {
        renderProviderStatus(host, snapshot, this.deps, false);
      }
      return next;
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
    if (
      request.renderFooter &&
      this.matchesActive(host) &&
      next.lastRenderable !== undefined
    ) {
      renderProviderStatus(host, next.lastRenderable, this.deps, true);
    }
    return next;
  }

  private abortAllInFlight(): void {
    const requests = [...this.inFlight.values()].map(({ request }) => request);
    this.inFlight.clear();
    for (const request of requests) {
      request.cancelTimeout();
      request.cancelExternalAbort();
      request.controller.abort(new Error("Quota refresh cancelled"));
    }
  }
}
