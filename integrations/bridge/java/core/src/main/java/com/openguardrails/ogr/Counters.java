package com.openguardrails.ogr;

import java.util.concurrent.atomic.AtomicLong;

/**
 * What the heartbeat reports about this process.
 *
 * <p>⚠️ These exist because the failures that matter here are SILENT. A fail-open is
 * faster and quieter than success, an unresolvable span logs "applied 0" while the
 * value travels on, and a reply this proxy could not read is indistinguishable from a
 * model that said nothing. Counters are what keep an observability gap from being
 * invisible — {@code unchecked} is the one to alert on.
 *
 * <p>Monotonic within one process, and the {@code instance_id} beside them is what
 * stops two replicas' series being spliced into one.
 */
public final class Counters {

    private final AtomicLong eventsSent = new AtomicLong();
    private final AtomicLong evaluateErrors = new AtomicLong();
    private final AtomicLong unchecked = new AtomicLong();
    private final AtomicLong refused = new AtomicLong();
    private final AtomicLong unresolvedSpans = new AtomicLong();
    private final AtomicLong unreadable = new AtomicLong();

    /** An event was accepted by the runtime. */
    public void event() {
        eventsSent.incrementAndGet();
    }

    /** An evaluate call failed or answered something that was not a verdict. */
    public void evaluateError() {
        evaluateErrors.incrementAndGet();
    }

    /** A step half went through WITHOUT a verdict, under fail-open. The number to alert on. */
    public void uncheckedStep() {
        unchecked.incrementAndGet();
    }

    /** A step half was refused. */
    public void refusal() {
        refused.incrementAndGet();
    }

    /** A verdict named spans this proxy could not resolve against the body it forwarded. */
    public void unresolvedSpans(int n) {
        if (n > 0) {
            unresolvedSpans.addAndGet(n);
        }
    }

    /**
     * A reply arrived that this proxy could not read at all — no frame of it parsed.
     *
     * <p>⚠️ Distinct from an EMPTY reply, which is a real answer. Conflating them is how
     * 100% response loss on one upstream stayed invisible: every observable signal said
     * healthy, and only this counter moved.
     */
    public void unreadableReply() {
        unreadable.incrementAndGet();
    }

    public long eventsSentValue() {
        return eventsSent.get();
    }

    public long uncheckedValue() {
        return unchecked.get();
    }

    public long refusedValue() {
        return refused.get();
    }

    public String toJson() {
        return "{\"events_sent\":" + eventsSent.get()
            + ",\"evaluate_errors\":" + evaluateErrors.get()
            + ",\"unchecked\":" + unchecked.get()
            + ",\"refused\":" + refused.get()
            + ",\"unresolved_spans\":" + unresolvedSpans.get()
            + ",\"unreadable\":" + unreadable.get() + "}";
    }
}
