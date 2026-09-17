package com.openguardrails.ogr;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/** What the proxy must do with a request half. */
public final class RequestOutcome {

    public enum Act {
        /** Send {@link #body} upstream. */
        FORWARD,
        /** Do not call the model; answer the caller with {@link #refusal}. */
        REFUSE
    }

    public final Act act;

    /** The body to forward — the original, or rewritten by spans or a {@code withhold} directive. */
    public final String body;

    /** The refusal document, already rendered in the CALLER's own protocol. */
    public final String refusal;

    /** Whether the refusal is SSE frames rather than one JSON document. */
    public final boolean refusalIsStream;

    /**
     * Whether this refusal is a DEGRADED-MODE one — no verdict arrived and the fail mode
     * is closed — rather than a policy decision.
     *
     * <p>⚠️ Worth keeping apart at the HTTP layer: a policy block and an outage answered
     * identically leaves an operator unable to tell "we are refusing traffic" from "the
     * decision point is down", which are opposite problems with opposite remedies.
     */
    public final boolean degraded;

    public final String eventId;
    public final List<String> unjudged;

    /** token → plaintext learned from the spans this half applied. Feeds the reply's restore. */
    public final Map<String, String> placeholders;

    RequestOutcome(Act act, String body, String refusal, boolean refusalIsStream, boolean degraded,
                   String eventId, List<String> unjudged, Map<String, String> placeholders) {
        this.act = act;
        this.body = body;
        this.refusal = refusal;
        this.refusalIsStream = refusalIsStream;
        this.degraded = degraded;
        this.eventId = eventId == null ? "" : eventId;
        this.unjudged = unjudged == null ? Collections.<String>emptyList() : unjudged;
        this.placeholders = placeholders == null
            ? Collections.<String, String>emptyMap() : placeholders;
    }

    public boolean forwards() {
        return act == Act.FORWARD;
    }
}
