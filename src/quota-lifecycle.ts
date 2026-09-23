/**
 * Provider-agnostic quota refresh lifecycle and session-memory quota state.
 *
 * The lifecycle is event-driven: session/model activation and activity changes
 * start immediate refreshes, one session heartbeat redraws the footer and runs
 * due active-provider refreshes, `/quota` refreshes every supported provider,
 * and shutdown cancels work. It owns timeout, coalescing, cancellation, stale
 * fallback, adaptive scheduling, and failure backoff. Session heartbeat work
 * is cancelled on provider replacement or session shutdown.
 */

import type { QuotaSnapshot, RenderableQuotaSnapshot } from "./quota-contract.ts";
import {
  isSupportedProvider,
  unavailableProviderQuotaSnapshot,
} from "./provider-registry.ts";
import type { QuotaHost } from "./quota-host.ts";
import {
  clearProviderStatus,
  renderProviderStatus,
  type StatusPresenterDeps,
} from "./quota-footer.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const HEARTBEAT_SECONDS = 60;
const WORKING_INTERVAL_SECONDS = 60;
const IDLE_INTERVAL_SECONDS = [60, 120, 300, 900] as const;
const FAILURE_BACKOFF_SECONDS = [120, 300, 900] as const;

type Activity = "working" | "idle";
type RefreshTrigger = "session-start" | "activity" | "automatic" | "command" | "reset";

export interface QuotaState {
  readonly provider: string;
  readonly lastRenderable?: RenderableQuotaSnapshot;
  readonly current?: QuotaSnapshot;
  readonly stale: boolean;
  readonly consecutiveFailures: number;
  /** Unix epoch seconds of the latest completed, non-discarded fetch. */
  readonly lastCompletedAt?: number;
  /** Unix epoch seconds of the next automatic refresh for the active provider. */
  readonly nextAutomaticAt?: number;
}

/** Returns a cancellation function for this request-scoped timer. */
export type ScheduleTimeout = (callback: () => void, delayMilliseconds: number) => () => void;

export interface QuotaLifecycleDeps extends StatusPresenterDeps {
  readonly timeoutMs?: number;
  /** Schedules one provider-request timeout. */
  readonly scheduleTimeout?: ScheduleTimeout;
  /** Schedules one session heartbeat tick. */
  readonly scheduleHeartbeat?: ScheduleTimeout;
  /** Fetches a normalized snapshot using lifecycle-owned cancellation. */
  readonly fetchSnapshot: (
    host: QuotaHost,
    signal: AbortSignal,
  ) => Promise<QuotaSnapshot | undefined>;
}

/** Owns freshness decisions; request and timer execution remain in the lifecycle. */
class FreshnessPolicy {
  readonly provider: string;
  private activity: Activity = "idle";
  private idleStage = 0;
  private revision = Symbol();
  private knownResetAt: number | undefined;
  private deadline: number | undefined;

  constructor(
    provider: string,
    previousSnapshot: QuotaSnapshot | undefined,
    nowSeconds: number,
  ) {
    this.provider = provider;
    this.knownResetAt = previousSnapshot === undefined
      ? undefined
      : earliestKnownReset(previousSnapshot, nowSeconds);
  }

  get nextAutomaticAt(): number | undefined {
    return this.deadline;
  }

  changeActivity(activity: Activity): boolean {
    if (this.activity === activity) return false;
    this.activity = activity;
    this.idleStage = 0;
    this.revision = Symbol();
    this.deadline = undefined;
    return true;
  }

  dueTrigger(nowSeconds: number): "reset" | "automatic" | undefined {
    // A known reset takes precedence over both idle delay and failure backoff.
    if (this.knownResetAt !== undefined && nowSeconds >= this.knownResetAt) {
      this.knownResetAt = undefined;
      return "reset";
    }
    return this.deadline !== undefined && nowSeconds >= this.deadline
      ? "automatic"
      : undefined;
  }

  requestStarted(trigger: RefreshTrigger, nowSeconds: number): symbol | undefined {
    if (this.knownResetAt !== undefined && nowSeconds >= this.knownResetAt) {
      this.knownResetAt = undefined;
    }
    this.deadline = undefined;
    // Only an automatic idle request may advance its unchanged activity schedule.
    return trigger === "automatic" && this.activity === "idle" ? this.revision : undefined;
  }

  complete(
    idleAttempt: symbol | undefined,
    snapshot: QuotaSnapshot,
    completedAt: number,
    consecutiveFailures: number,
  ): void {
    if (snapshot.status === "available") {
      this.knownResetAt = earliestKnownReset(snapshot, completedAt);
    }
    if (idleAttempt === this.revision) {
      this.idleStage = Math.min(this.idleStage + 1, IDLE_INTERVAL_SECONDS.length - 1);
    }
    const normalDelay = this.activity === "working"
      ? WORKING_INTERVAL_SECONDS
      : idleDelaySeconds(this.idleStage);
    this.deadline = completedAt + Math.max(normalDelay, failureDelaySeconds(consecutiveFailures));
  }
}

interface InFlightRequest {
  readonly provider: string;
  readonly controller: AbortController;
  readonly cancelTimeout: () => void;
  readonly renderFooter: boolean;
  readonly idleAttempt: symbol | undefined;
}

interface InFlightEntry {
  readonly request: InFlightRequest;
  readonly promise: Promise<QuotaState | undefined>;
}

interface RefreshOptions {
  readonly requireActive: boolean;
  readonly renderFooter: boolean;
  readonly trigger: RefreshTrigger;
}

function defaultScheduleTimeout(callback: () => void, delayMilliseconds: number): () => void {
  const timeout = setTimeout(callback, delayMilliseconds);
  timeout.unref();
  return () => clearTimeout(timeout);
}

function failureDelaySeconds(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return FAILURE_BACKOFF_SECONDS[
    Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_SECONDS.length - 1)
  ];
}

function idleDelaySeconds(idleStage: number): number {
  return IDLE_INTERVAL_SECONDS[Math.min(idleStage, IDLE_INTERVAL_SECONDS.length - 1)]!;
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

/** Lets one caller stop waiting without cancelling lifecycle-owned work. */
function waitForCompletion<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (signal === undefined) return promise;

  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => resolve(undefined));

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function earliestKnownReset(snapshot: QuotaSnapshot, nowSeconds: number): number | undefined {
  if (snapshot.status !== "available") return undefined;

  return snapshot.windows
    .map((quotaWindow) => quotaWindow.resetAtSeconds)
    .filter((resetAt): resetAt is number =>
      resetAt !== undefined && Number.isFinite(resetAt) && resetAt > nowSeconds
    )
    .sort((a, b) => a - b)[0];
}

/** Deep lifecycle module used by the thin Pi event-registration entry. */
export class QuotaLifecycle {
  private readonly deps: QuotaLifecycleDeps;
  private readonly states = new Map<string, Omit<QuotaState, "nextAutomaticAt">>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private activeHost: QuotaHost | undefined;
  private activeSchedule: FreshnessPolicy | undefined;
  private heartbeatCancel: (() => void) | undefined;
  private heartbeatToken = 0;

  constructor(deps: QuotaLifecycleDeps) {
    this.deps = deps;
  }

  /** Starts a fresh session-memory lifecycle and refreshes a supported provider. */
  sessionStart(host: QuotaHost, _signal?: AbortSignal): void {
    this.resetActiveRuntime();
    this.states.clear();
    this.activate(host);
  }

  /** Switches active provider, cancelling stale work and clearing old UI first. */
  modelSelect(host: QuotaHost, _signal?: AbortSignal): void {
    const previousProvider = this.activeHost?.provider;
    this.resetActiveRuntime();
    if (
      previousProvider !== undefined &&
      this.states.get(previousProvider)?.current === undefined
    ) {
      this.states.delete(previousProvider);
    }
    this.activate(host);
  }

  /** Starts an immediate refresh when the active model begins working. */
  agentStart(host: QuotaHost, _signal?: AbortSignal): void {
    this.changeActivity(host, "working");
  }

  /** Starts an immediate refresh when the active model becomes idle. */
  agentSettled(host: QuotaHost, _signal?: AbortSignal): void {
    this.changeActivity(host, "idle");
  }

  private changeActivity(host: QuotaHost, activity: Activity): void {
    if (!this.activeScheduleFor(host)?.changeActivity(activity)) return;
    this.startRefresh(host, {
      requireActive: true,
      renderFooter: true,
      trigger: "activity",
    });
  }

  /**
   * Force-refreshes every requested provider concurrently and returns their
   * resulting states. Completed snapshots are never reused. Matching
   * lifecycle-owned requests are reused, and a caller abort only stops its own
   * wait rather than cancelling shared provider work.
   */
  async refreshProviders(
    hosts: readonly QuotaHost[],
    signal?: AbortSignal,
  ): Promise<readonly QuotaState[]> {
    return Promise.all(hosts.map(async (host) => {
      const provider = host.provider;
      if (!isSupportedProvider(provider)) {
        throw new Error("Quota inspection requires a supported provider host");
      }

      const initial = this.ensureState(provider);
      const request = this.startRefresh(host, {
        requireActive: false,
        renderFooter: this.matchesActive(host),
        trigger: "command",
      });
      if (request === undefined) return this.getState(provider) ?? initial;

      const result = await waitForCompletion(request, signal);
      return result ?? this.getState(provider) ?? initial;
    }));
  }

  /** Cancels session work and drops all in-memory quota state. */
  sessionShutdown(): void {
    const host = this.resetActiveRuntime();
    this.states.clear();
    if (host !== undefined) clearProviderStatus(host);
  }

  /** Read-only state seam for diagnostics and focused tests. */
  getState(provider: string): QuotaState | undefined {
    const state = this.states.get(provider);
    const nextAutomaticAt = this.activeSchedule?.provider === provider
      ? this.activeSchedule.nextAutomaticAt
      : undefined;
    return state === undefined || nextAutomaticAt === undefined
      ? state
      : { ...state, nextAutomaticAt };
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

  private activate(host: QuotaHost): void {
    clearProviderStatus(host);
    if (host.mode !== "tui" || !isSupportedProvider(host.provider)) return;

    const state = this.ensureState(host.provider);
    const previousSnapshot = state.lastRenderable ?? (
      state.current?.status === "available" ? state.current : undefined
    );
    this.activeHost = host;
    this.activeSchedule = new FreshnessPolicy(
      host.provider,
      previousSnapshot,
      this.deps.nowSeconds(),
    );
    this.startRefresh(host, {
      requireActive: true,
      renderFooter: true,
      trigger: "session-start",
    });
    this.startHeartbeat();
  }

  private activeScheduleFor(host: QuotaHost): FreshnessPolicy | undefined {
    return this.activeSchedule !== undefined && this.matchesActive(host)
      ? this.activeSchedule
      : undefined;
  }

  private matchesActive(host: QuotaHost): boolean {
    return (
      this.activeHost !== undefined &&
      this.activeHost.provider === host.provider &&
      this.activeHost.providerBaseUrl === host.providerBaseUrl
    );
  }

  private startRefresh(
    host: QuotaHost,
    options: RefreshOptions,
  ): Promise<QuotaState | undefined> | undefined {
    const provider = host.provider;
    if (
      !isSupportedProvider(provider) ||
      (options.requireActive && !this.matchesActive(host))
    ) {
      return undefined;
    }

    const existing = this.inFlight.get(provider);
    if (existing !== undefined) return existing.promise;
    if (!this.states.has(provider)) return undefined;

    const idleAttempt = this.activeScheduleFor(host)?.requestStarted(
      options.trigger,
      this.deps.nowSeconds(),
    );

    const controller = new AbortController();
    const cancelTimeout = (this.deps.scheduleTimeout ?? defaultScheduleTimeout)(
      () => controller.abort(new Error("Quota refresh timed out")),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const request: InFlightRequest = {
      provider,
      controller,
      cancelTimeout,
      renderFooter: options.renderFooter,
      idleAttempt,
    };
    const promise = Promise.resolve().then(() => this.completeRefresh(request, host));
    this.inFlight.set(provider, { request, promise });
    return promise;
  }

  private async completeRefresh(
    request: InFlightRequest,
    host: QuotaHost,
  ): Promise<QuotaState | undefined> {
    let snapshot: QuotaSnapshot | undefined;
    try {
      snapshot = await Promise.race([
        this.deps.fetchSnapshot(host, request.controller.signal),
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
    }

    if (this.inFlight.get(request.provider)?.request !== request) return undefined;
    this.inFlight.delete(request.provider);
    const resolvedSnapshot = snapshot === undefined || snapshot.provider !== request.provider
      ? unavailableProviderQuotaSnapshot(
          request.provider,
          "schema-drift",
          this.deps.nowSeconds(),
        )
      : snapshot;
    if (resolvedSnapshot === undefined) return undefined;

    const previous = this.states.get(request.provider);
    if (previous === undefined) return undefined;

    const completedAt = this.deps.nowSeconds();
    const nextState = resolvedSnapshot.status === "available"
      ? {
          provider: request.provider,
          current: resolvedSnapshot,
          lastRenderable: resolvedSnapshot,
          stale: false,
          consecutiveFailures: 0,
          lastCompletedAt: completedAt,
        }
      : {
          provider: request.provider,
          current: resolvedSnapshot,
          ...(previous.lastRenderable === undefined
            ? {}
            : { lastRenderable: previous.lastRenderable }),
          stale: previous.lastRenderable !== undefined,
          consecutiveFailures: previous.consecutiveFailures + 1,
          lastCompletedAt: completedAt,
        };
    this.states.set(request.provider, nextState);

    if (this.activeSchedule?.provider === request.provider) {
      this.activeSchedule.complete(
        request.idleAttempt,
        resolvedSnapshot,
        completedAt,
        nextState.consecutiveFailures,
      );
    }
    if (
      request.renderFooter &&
      this.matchesActive(host) &&
      (nextState.current?.status === "available" || nextState.lastRenderable !== undefined)
    ) {
      this.renderActiveFooter();
    }
    return this.getState(request.provider);
  }

  private renderActiveFooter(): void {
    const host = this.activeHost;
    const schedule = this.activeSchedule;
    if (host === undefined || schedule === undefined) return;

    const state = this.states.get(schedule.provider);
    if (state?.stale && state.lastRenderable !== undefined) {
      renderProviderStatus(host, state.lastRenderable, this.deps, true);
      return;
    }
    if (state?.current?.status === "available") {
      renderProviderStatus(host, state.current, this.deps, false);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const token = ++this.heartbeatToken;
    this.scheduleHeartbeatTick(token);
  }

  private scheduleHeartbeatTick(token: number): void {
    if (this.activeHost === undefined || this.activeSchedule === undefined) return;

    const scheduleHeartbeat = this.deps.scheduleHeartbeat ?? defaultScheduleTimeout;
    this.heartbeatCancel = scheduleHeartbeat(() => {
      if (token !== this.heartbeatToken) return;
      this.heartbeatCancel = undefined;
      this.handleHeartbeat();
      this.scheduleHeartbeatTick(token);
    }, HEARTBEAT_SECONDS * 1000);
  }

  private handleHeartbeat(): void {
    const host = this.activeHost;
    const schedule = this.activeSchedule;
    if (host === undefined || schedule === undefined) return;

    this.renderActiveFooter();
    const trigger = schedule.dueTrigger(this.deps.nowSeconds());
    if (trigger !== undefined) {
      this.startRefresh(host, { requireActive: true, renderFooter: true, trigger });
    }
  }

  private resetActiveRuntime(): QuotaHost | undefined {
    const host = this.activeHost;
    this.stopHeartbeat();
    this.abortAllInFlight();
    this.activeHost = undefined;
    this.activeSchedule = undefined;
    return host;
  }

  private stopHeartbeat(): void {
    this.heartbeatToken += 1;
    this.heartbeatCancel?.();
    this.heartbeatCancel = undefined;
  }

  private abortAllInFlight(): void {
    const requests = [...this.inFlight.values()].map(({ request }) => request);
    this.inFlight.clear();
    for (const request of requests) {
      request.cancelTimeout();
      request.controller.abort(new Error("Quota refresh cancelled"));
    }
  }
}
