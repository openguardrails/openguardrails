package com.openguardrails.ogr;

import java.util.Collections;
import java.util.List;

/**
 * What to write to the caller once a STREAMED reply has been judged.
 *
 * <p>There is only ever a tail to write: the stream's head is already gone, by
 * construction and within the bound.
 */
public final class StreamOutcome {

    public final boolean allowed;

    /**
     * The bytes to write next and last: the released remainder on an allow, or the
     * refusal/retraction frames on a block.
     */
    public final String tail;

    public final boolean degraded;
    public final String eventId;

    /**
     * Paths the runtime routed to a judge and got no judgment for.
     *
     * <p>⚠️ Carried on a stream for the same reason it is carried on a buffered reply:
     * it is the only assertion a fail-closed deployment can rest on, and a streamed
     * answer is the half where nobody can re-read the body to find out. A caller that
     * reads the door's trailing verdict line gets it there.
     */
    public final List<String> unjudged;

    StreamOutcome(boolean allowed, String tail, boolean degraded, String eventId) {
        this(allowed, tail, degraded, eventId, null);
    }

    StreamOutcome(boolean allowed, String tail, boolean degraded, String eventId,
                  List<String> unjudged) {
        this.allowed = allowed;
        this.tail = tail;
        this.degraded = degraded;
        this.eventId = eventId == null ? "" : eventId;
        this.unjudged = unjudged == null ? Collections.<String>emptyList() : unjudged;
    }
}
