package com.openguardrails.ogr.protocol;

/** What one SSE frame became on its way through a decoder. */
public final class FrameResult {

    /** What to forward in the frame's place — the frame itself when nothing was rewritten. */
    public final String out;

    /**
     * CLIENT-VISIBLE content bytes this frame carries: text, reasoning and tool-call
     * arguments, in UTF-8, never SSE framing.
     *
     * <p>⚠️ Framing is free on purpose. A frame that carries no content may be released
     * whatever the head budget says, so the stream reads as live from its first frame
     * even at {@code stream_head_release_bytes: 0}.
     */
    public final int contentBytes;

    /**
     * Whether this frame carried TOOL-CALL bytes.
     *
     * <p>⚠️ Released tool-call bytes are what forbid ending a refused stream on a normal
     * stop: the client may hold a partial call, and harnesses act on {@code tool_calls}
     * being non-empty rather than on the finish reason.
     */
    public final boolean carriesCalls;

    public FrameResult(String out, int contentBytes, boolean carriesCalls) {
        this.out = out;
        this.contentBytes = contentBytes;
        this.carriesCalls = carriesCalls;
    }

    /** A frame passed through untouched and carrying nothing countable. */
    public static FrameResult passthrough(String frame) {
        return new FrameResult(frame, 0, false);
    }
}
