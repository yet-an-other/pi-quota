import { CODEX_PROVIDER } from "./providers/codex.ts";
import { KIMI_PROVIDER } from "./providers/kimi.ts";
import { ZAI_PROVIDER } from "./providers/zai.ts";

export interface SupportedProvider {
  readonly id: string;
  readonly label: string;
}

/** Stable display order for the integrations supported by pi-quota. */
export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
  { id: CODEX_PROVIDER, label: "OpenAI Codex" },
  { id: KIMI_PROVIDER, label: "Kimi For Coding" },
  { id: ZAI_PROVIDER, label: "Z.AI" },
];
