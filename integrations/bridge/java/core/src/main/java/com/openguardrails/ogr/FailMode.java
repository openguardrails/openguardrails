package com.openguardrails.ogr;

/**
 * What to do when no verdict arrives.
 *
 * <p>"No verdict" is wider than it looks: a timeout, a 429, a 5xx, a socket error —
 * and a <b>200 that is not a verdict</b>. An empty body, an HTML error page from
 * something in front of the runtime, or a JSON document of another shape all parse
 * without complaint and answer "" to every question, so every "did it stop?" test says
 * no and the traffic goes through as an allow nobody made. {@link Verdict#usable()} is
 * the gate that routes those into this setting instead.
 *
 * <p>{@link #OPEN} is the specification's default and this integration's: an
 * unanswered evaluate proceeds and is counted. The counter is the whole point — a
 * fail-open is <i>faster and quieter than success</i>, so nothing about the traffic
 * will tell you it happened.
 *
 * <p>{@link #CLOSED} also refuses on a PARTIAL verdict — one whose {@code unjudged}
 * names paths. That is the entire content of the promise: if we could not look at it,
 * it does not go through. A runtime fans out per text, so a reply with five tool calls
 * is five judge calls, and one of them failing under the runtime's own fail-open
 * contributes no findings while the verdict comes back looking complete.
 */
public enum FailMode {
    OPEN,
    CLOSED;

    public static FailMode of(String s) {
        return "closed".equalsIgnoreCase(s) ? CLOSED : OPEN;
    }

    public boolean isClosed() {
        return this == CLOSED;
    }
}
