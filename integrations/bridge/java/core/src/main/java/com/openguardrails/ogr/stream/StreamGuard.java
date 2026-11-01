package com.openguardrails.ogr.stream;

import com.openguardrails.ogr.StepGuard;
import com.openguardrails.ogr.StreamOutcome;
import com.openguardrails.ogr.protocol.FrameResult;
import com.openguardrails.ogr.protocol.SseFrames;
import com.openguardrails.ogr.protocol.StreamDecoder;

import java.time.Instant;

/**
 * ONE streamed reply, from the first byte to the verdict — the four parts of streaming
 * enforcement wired together, with no I/O of its own.
 *
 * <pre>
 *   bytes ─▶ SseFrames ─▶ StreamDecoder ─▶ HeadHold ─▶ what to write NOW
 *                              │                          (the bounded head, then "")
 *                              └── reassembled reply ─▶ one step/response evaluate ─▶ tail
 * </pre>
 *
 * <p>PUSH, not pull, and that is deliberate: the caller owns its own transport. The
 * inline proxy reads a provider socket and writes an {@code HttpExchange}; the message
 * door reads the caller's uploaded stream and writes its answer; a host embedding
 * {@code core} has whatever I/O model it already chose. All three feed chunks in and
 * write what comes back, so the rules that must not differ between them — what counts
 * against the head budget, when the first token was seen, what a refusal looks like
 * after bytes are already gone — live here once.
 *
 * <p>⚠️ Not thread-safe, and one instance belongs to one reply.
 */
public final class StreamGuard {

    private final StepGuard step;
    private final StreamDecoder decoder;
    private final HeadHold hold;
    private final SseFrames frames = new SseFrames();
    private final Instant startedAt;

    private Instant firstTokenAt;
    private StreamOutcome outcome;

    /**
     * @param step      the step this reply belongs to; its protocol must already be set
     * @param headBytes client-visible content that may be released before the verdict
     * @param startedAt when the provider call was made, or {@code null} when this
     *                  process did not make it — an unmeasured instant is an ABSENT
     *                  timing key, never a fabricated one
     */
    public StreamGuard(StepGuard step, int headBytes, Instant startedAt) {
        this.step = step;
        this.decoder = step.protocol().newDecoder(step.placeholders());
        /*
         * ⚠️ OBSERVE HOLDS NOTHING. A hold buys the ability to refuse, and observe never
         * refuses — so holding there would spend the whole of a stream's
         * time-to-first-token to arrive at a verdict nobody acts on, in the one mode that
         * exists to be rolled out without changing what anyone sees.
         */
        this.hold = new HeadHold(step.enforces() ? headBytes : Integer.MAX_VALUE);
        this.startedAt = startedAt;
    }

    /**
     * Feeds one network chunk and returns what to write to the caller NOW — the empty
     * string while the budget is spent, which is the normal case after the head.
     */
    public String feed(byte[] chunk, int length) {
        StringBuilder out = null;
        for (String frame : frames.feed(chunk, length)) {
            FrameResult r = decoder.frame(frame);
            if (firstTokenAt == null && r.contentBytes > 0) {
                firstTokenAt = Instant.now();
            }
            String release = hold.offer(r);
            if (!release.isEmpty()) {
                if (out == null) {
                    out = new StringBuilder(release.length());
                }
                out.append(release);
            }
        }
        return out == null ? "" : out.toString();
    }

    /**
     * Ends the stream: judges the reassembled reply ONCE and returns the last bytes to
     * write — the released remainder on an allow, the refusal or retraction on a block.
     *
     * <p>⚠️ The judge runs BEFORE the restorer's held tail is written, and that tail
     * rides the release rather than the refusal: it is part of the answer, so a refused
     * answer must not deliver it.
     */
    public String finish() {
        StringBuilder out = new StringBuilder();
        String rest = frames.remainder();
        if (!rest.isEmpty()) {
            // Bytes that never became a frame. Offered rather than written, so that an
            // upstream which ended mid-frame cannot walk past a hold that is already on.
            out.append(hold.offer(FrameResult.passthrough(rest)));
        }
        String flushed = decoder.flush();
        step.adoptModel(decoder.model());
        outcome = step.guardStreamedResponse(decoder.output(), hold, startedAt, firstTokenAt,
            Instant.now(), decoder.recognizedFrames());
        if (outcome.allowed && !flushed.isEmpty()) {
            out.append(flushed);
        }
        out.append(outcome.tail);
        return out.toString();
    }

    /** The verdict's consequences, once {@link #finish()} has run. */
    public StreamOutcome outcome() {
        return outcome;
    }

    /** The model the frames named, or the one the request half established. */
    public String model() {
        return step.model().isEmpty() ? decoder.model() : step.model();
    }

    /**
     * Whether the bytes were unreadable AS THIS PROTOCOL — not the same fact as an empty
     * answer.
     *
     * <p>⚠️ A well-formed stream whose answer was genuinely empty is a reportable reply;
     * zero recognised frames means a wrong dialect, a compressed body or garbage, and
     * conflating the two is how 100% response loss on one upstream stayed invisible.
     */
    public boolean unreadable() {
        return decoder.output().isEmpty() && decoder.recognizedFrames() == 0;
    }
}
