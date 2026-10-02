---
'@thaumic-cast/core': patch
---

refactor(core): move the TCP link probe under the stream module

An internal restructuring with no behaviour change. The link probe (the TCP window sampling, the registry and the
judge that turns samples into a link quality) never used anything from the API layer, and the stream cadence is what
reads it. It now lives beside the stream code, so the stream module no longer imports from the API module. The old
`thaumic_core::api::link` path still resolves.

One thing differs in the logs: lines emitted from this file now print the module path `thaumic_core::stream::link`
instead of `thaumic_core::api::link`. Their text is the same.
