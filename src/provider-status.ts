/**
 * Active-provider footer status.
 *
 * Tracer-bullet placeholder: renders the active provider name through Pi's
 * existing footer status area. Later quota slices replace the provider-name
 * text for supported providers.
 */

export const PROVIDER_STATUS_ID = "pi-quota";

/** Narrow structural seam over the Pi host so tests can mock it. */
export interface ProviderStatusInput {
  readonly mode: string;
  readonly provider: string | undefined;
  readonly ui: {
    setStatus(id: string, text: string | undefined): void;
  };
}

export function showActiveProvider(input: ProviderStatusInput): void {
  if (input.mode !== "tui") return;
  input.ui.setStatus(PROVIDER_STATUS_ID, input.provider);
}
