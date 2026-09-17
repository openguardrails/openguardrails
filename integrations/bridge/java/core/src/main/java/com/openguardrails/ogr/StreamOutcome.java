package com.openguardrails.ogr;

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

    StreamOutcome(boolean allowed, String tail, boolean degraded, String eventId) {
        this.allowed = allowed;
        this.tail = tail;
        this.degraded = degraded;
        this.eventId = eventId == null ? "" : eventId;
    }
}
