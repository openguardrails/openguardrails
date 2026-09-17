package com.openguardrails.ogr.protocol;

/** How a protocol answers "is this request path mine?". */
public enum Claim {
    /** Not this protocol's path. */
    IGNORE,
    /** This protocol's completion endpoint. */
    SERVE,
    /**
     * A path this protocol OWNS but which is not a completion — Anthropic's
     * {@code /v1/messages/count_tokens}.
     *
     * <p>⚠️ Distinct from {@link #IGNORE} because it must stop detection OUTRIGHT: a
     * count_tokens body is a valid messages body, so falling through to shape matching
     * would read it as a conversation and report a turn that never happened.
     */
    REJECT
}
