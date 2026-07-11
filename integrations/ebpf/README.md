# eBPF integrations

This category is reserved for eBPF-based OGR integrations that observe or
enforce process, filesystem, and network activity at the kernel boundary.

No reference implementation is included yet. Future integrations should map
kernel events to OGR `GuardEvent`s and preserve `guard_id` correlation with the
agent, gateway, and sandbox layers.
