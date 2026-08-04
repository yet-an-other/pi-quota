import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showActiveProvider } from "./provider-status.ts";

export default function registerExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    showActiveProvider({ mode: ctx.mode, provider: ctx.model?.provider, ui: ctx.ui });
  });

  pi.on("model_select", (event, ctx) => {
    showActiveProvider({ mode: ctx.mode, provider: event.model?.provider, ui: ctx.ui });
  });
}
