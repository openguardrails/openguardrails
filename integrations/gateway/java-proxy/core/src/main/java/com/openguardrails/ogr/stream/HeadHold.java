package com.openguardrails.ogr.stream;

import com.openguardrails.ogr.protocol.FrameResult;

import java.util.ArrayList;
import java.util.List;

/**
 * ENFORCING ON A STREAM: release a bounded HEAD, hold the rest, judge once.
 *
 * <p>A buffered reply can be judged and refused before anyone sees it. A stream cannot:
 * the first token is on the wire before there is anything to judge. Judging every N
 * characters and cutting on a hit was tried and measured wrong — at 25% of the reply
 * visible, false positives are an order of magnitude worse than on the whole reply, all
 * of it the answer that agrees on the surface and corrects underneath. Early judgement
 * is a fit prefilter and an unfit blocking criterion.
 *
 * <p>So the answer is judged ONCE, whole, at end of stream, and the only remaining
 * question is how much of it may be on the wire by then:
 *
 * <ol>
 *   <li>Forward at most {@code head} bytes of client-visible content and WITHHOLD
 *       everything after it.
 *   <li>At stream end, submit the reassembled reply as the step's one
 *       {@code step/response} evaluate.
 *   <li>{@code allow} → release everything held. {@code block} → drop it and end the
 *       stream, so the answer never completes as sent.
 * </ol>
 *
 * <h2>⚠️⚠️ The bound is measured from the HEAD, and that inversion is the whole point</h2>
 *
 * "Withhold the last N bytes" guarantees only that N are withheld: what reaches the
 * caller is {@code total − N}, unbounded in the length of the answer. Measured, a
 * ~900-byte answer to a prohibited question was delivered essentially whole and then
 * retracted, because the verdict cannot exist before the last token. Bounding the head
 * makes exposure a CONSTANT.
 *
 * <h2>⚠️ It is a CEILING, and order is preserved</h2>
 *
 * A frame that would carry the caller past the budget is held WHOLE — an SSE frame cut
 * in half is not a frame. And once anything is held, everything after it is held too,
 * whatever its size: releasing a later frame around a held one delivers the answer out
 * of order, which is worse than delivering it late.
 *
 * <h2>⚠️ The enforcement property does not rest on the number</h2>
 *
 * TOOL CALLS NEVER EXECUTE BEFORE THE VERDICT whatever the budget is: a provider stream
 * only completes tool calls at its end, so argument completions and the terminal frames
 * are always inside the held remainder. {@code head = 0} is a real value meaning release
 * nothing — a spinner until the judged answer arrives, and every block then a CLEAN
 * refusal rather than a retraction.
 */
public final class HeadHold {

    private final int head;
    private final List<String> held = new ArrayList<String>();
    private int releasedContentBytes;
    private boolean releasedAnyContent;
    private boolean releasedCalls;

    public HeadHold(int headBytes) {
        this.head = Math.max(0, headBytes);
    }

    /**
     * Offers one decoded frame and returns what to write to the caller NOW — the empty
     * string when the frame is held.
     */
    public String offer(FrameResult frame) {
        if (!held.isEmpty()) {
            held.add(frame.out);
            return "";
        }
        if (frame.contentBytes == 0) {
            // Framing is free: a frame carrying no client-visible content may go out
            // whatever the budget says, so the stream reads as live from its first frame.
            return frame.out;
        }
        if (releasedContentBytes + frame.contentBytes > head) {
            held.add(frame.out);
            return "";
        }
        releasedContentBytes += frame.contentBytes;
        releasedAnyContent = true;
        if (frame.carriesCalls) {
            releasedCalls = true;
        }
        return frame.out;
    }

    /** Everything held, in order. The hold is empty afterwards. */
    public String releaseAll() {
        if (held.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (String frame : held) {
            sb.append(frame);
        }
        held.clear();
        return sb.toString();
    }

    /** Discards everything held — the {@code block} path. */
    public void drop() {
        held.clear();
    }

    /** Whether any client-visible content has reached the caller. */
    public boolean sawRelease() {
        return releasedAnyContent;
    }

    /**
     * Whether a RELEASED frame carried tool-call bytes.
     *
     * <p>⚠️ This is the one fact that decides whether a refused stream may end on a normal
     * stop. With a partial call in the client's hands, a normal completion invites it to
     * run a call with truncated arguments — harnesses branch on {@code tool_calls} being
     * non-empty, not on the finish reason.
     */
    public boolean releasedCalls() {
        return releasedCalls;
    }

    public int heldFrames() {
        return held.size();
    }

    public int releasedContentBytes() {
        return releasedContentBytes;
    }
}
