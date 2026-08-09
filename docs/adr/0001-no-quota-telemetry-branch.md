# No quota telemetry branch

The quota contract previously reserved a `degraded` status and a `QuotaTelemetry` type for provider-reported usage metrics that are displayable but lack the verified semantics needed to calculate remaining quota. No provider adapter ever produced such a snapshot — the branch existed only in tests — so we pruned it from the contract, the footer and details presenters, and the lifecycle, and dropped the *Quota telemetry* term from `CONTEXT.md`.

Re-introduce both the type and the rendering when a provider surfaces non-quota usage metrics worth showing. Until then the contract carries only what adapters actually emit (`available` and `unavailable`), and a status union with a never-produced member is speculative generality we'd rather not maintain.
