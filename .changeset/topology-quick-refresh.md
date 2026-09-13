---
'@thaumic-cast/core': patch
---

fix(core): reconcile subscriptions on every topology refresh

The quick refresh replaced only the group snapshot and reset the periodic timer, so a speaker promoted to coordinator
could go a full interval or longer without an event subscription, leaving its transport state stale. A burst of
topology events could also defer the full refresh indefinitely. Both paths now share one reconciliation step and the
quick path no longer resets the timer.
