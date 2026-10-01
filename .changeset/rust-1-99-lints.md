---
'@thaumic-cast/core': patch
---

build(core): pass clippy on Rust 1.99

Rust 1.99 deprecates `AtomicUsize::fetch_update` and its clippy flags the `#[must_use]` that async-trait 0.1.91
put on trait methods. The two `fetch_update` calls are now compare-exchange loops, which also build on the
declared minimum Rust 1.77, and async-trait is updated to 0.1.92. No behaviour change.
