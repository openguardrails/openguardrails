package com.openguardrails.ogr;

import java.util.Collections;
import java.util.List;

/** What the proxy must hand back for a BUFFERED reply. */
public final class ResponseOutcome {

    public enum Act {
        /** Hand {@link #body} to the caller. */
        DELIVER,
        /** Hand {@link #refusal} to the caller; no tool call in the reply may run. */
        REFUSE
    }

    public final Act act;

    /** The reply to deliver — spans applied, placeholders restored, refused calls dropped. */
    public final String body;

    public final String refusal;
    public final boolean degraded;
    public final String eventId;
    public final List<String> unjudged;

    ResponseOutcome(Act act, String body, String refusal, boolean degraded,
                    String eventId, List<String> unjudged) {
        this.act = act;
        this.body = body;
        this.refusal = refusal;
        this.degraded = degraded;
        this.eventId = eventId == null ? "" : eventId;
        this.unjudged = unjudged == null ? Collections.<String>emptyList() : unjudged;
    }

    public boolean delivers() {
        return act == Act.DELIVER;
    }
}
