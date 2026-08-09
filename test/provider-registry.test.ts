import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROVIDER_ADAPTERS,
  providerAdapter,
  unavailableProviderQuotaSnapshot,
} from "../src/provider-registry.ts";

describe("provider registry", () => {
  it("has unique provider ids", () => {
    const ids = PROVIDER_ADAPTERS.map((adapter) => adapter.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("gives every adapter a non-empty id and label", () => {
    for (const adapter of PROVIDER_ADAPTERS) {
      assert.ok(adapter.id.length > 0);
      assert.ok(adapter.label.length > 0);
    }
  });

  it("reaches every adapter's fetch behavior and source identity through the lookup", () => {
    for (const adapter of PROVIDER_ADAPTERS) {
      const resolved = providerAdapter(adapter.id);
      assert.equal(resolved, adapter);
      assert.equal(typeof resolved.fetch, "function");
      assert.ok(resolved.source.kind.length > 0);
    }
  });

  it("builds an unavailable snapshot from each adapter's source identity", () => {
    for (const adapter of PROVIDER_ADAPTERS) {
      const snapshot = unavailableProviderQuotaSnapshot(adapter.id, "transient", 1_700_000_000);
      assert.equal(snapshot?.status, "unavailable");
      assert.equal(snapshot?.provider, adapter.id);
      assert.equal(snapshot?.source.kind, adapter.source.kind);
    }
  });

  it("returns undefined for unknown or missing provider ids", () => {
    assert.equal(providerAdapter("not-a-provider"), undefined);
    assert.equal(providerAdapter(undefined), undefined);
    assert.equal(unavailableProviderQuotaSnapshot("not-a-provider", "transient", 0), undefined);
  });
});
