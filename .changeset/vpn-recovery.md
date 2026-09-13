---
'@thaumic-cast/core': patch
---

fix(core): recover when a VPN connects or disconnects

Address detection followed the default route, so a full-tunnel VPN made the server advertise the tunnel address while
speaker discovery, which already skips virtual interfaces, still found speakers on the real network. Every callback,
stream and artwork address then named somewhere no speaker could reach. Detection now applies the same interface
filter, prefers an address sharing a subnet with a known speaker, and ranks private ranges so a container or
virtualisation bridge no longer wins. The network advertisement is re-registered when the address changes rather than
fixed at startup.

Recovery previously needed a restart because a subscription made against the wrong address renews indefinitely: the
renewal carries only the subscription identifier, needs no inbound reachability, and prevents its own replacement.
Each refresh now compares a subscription's recorded callback against the current one and rebuilds only those that
differ.

Detection is deliberately strict so a momentary loss is not mistaken for a network change, but the desktop falls back
to the default route at startup, so a machine whose only address sits on a filtered adapter still launches. The
headless server stays strict and continues to advise setting an explicit advertise address.

Relates to #112
