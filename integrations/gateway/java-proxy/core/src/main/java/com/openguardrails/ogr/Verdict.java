package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The runtime's answer about one GuardEvent.
 *
 * <p>ONE event in, one verdict out. There is no batch form and no composed decision:
 * a step half is one event, and one event has one verdict.
 *
 * <p>Two decisions, {@code allow} and {@code block}. Redaction is not a decision — a
 * non-empty {@code modifications.spans} on an allow says it. "Flag" is not a decision —
 * an allow with findings says it.
 */
public final class Verdict {

    /** What a refused caller is told. */
    public static final String REASON =
        "This request was refused by the organization's AI usage policy.";

    private final Object root;

    private Verdict(Object root) {
        this.root = root;
    }

    public static Verdict parse(String body) {
        return new Verdict(Json.parseOrNull(body));
    }

    /** A verdict that does not exist — what a failed call answers. */
    public static Verdict none() {
        return new Verdict(null);
    }

    /**
     * Whether this is a VERDICT at all.
     *
     * <p>⚠️⚠️ A 200 is not a verdict. An empty body, an HTML error page from something in
     * front of the runtime, or a JSON document of another shape all parse without error
     * and answer "" to every question — so every "did it stop?" test says no and the
     * traffic goes through as an ALLOW NOBODY MADE. The fail mode does not cover it,
     * because a fail mode is consulted on non-200 and transport failures only. Every
     * caller must gate on this and route a false through the same path as an
     * unreachable runtime.
     */
    public boolean usable() {
        return !decision().isEmpty();
    }

    public String decision() {
        return Json.str(root, "decision");
    }

    /** The one stopping decision. */
    public boolean stops() {
        return "block".equals(decision());
    }

    public String eventId() {
        return Json.str(root, "event_id");
    }

    public String provider() {
        return Json.str(root, "provider");
    }

    public long latencyMs() {
        return Json.getLong(root, "latency_ms", -1);
    }

    /** The modification spans to apply in place; empty when there are none. */
    public List<Span> spans() {
        List<Object> raw = Json.getList(root, "modifications.spans");
        if (raw == null) {
            return Collections.emptyList();
        }
        List<Span> out = new ArrayList<Span>(raw.size());
        for (Object o : raw) {
            out.add(new Span(
                Json.str(o, "path"),
                (int) Json.getLong(o, "start", -1),
                (int) Json.getLong(o, "end", -1),
                Json.str(o, "replacement")));
        }
        return out;
    }

    /**
     * The payload paths that reached a detector and got NO judgement.
     *
     * <p>⚠️ This is what makes a partial verdict distinguishable from a complete one,
     * and without it {@link FailMode#CLOSED} is a promise this proxy cannot keep.
     *
     * <p>⚠️ ABSENT OR EMPTY MEANS EVERY ROUTED TEXT WAS JUDGED. That is the only
     * assertion fail-closed hangs on.
     *
     * <p>⚠️ COVERAGE, NOT ATTENDANCE: a path appears if ANY guardrail routed to it
     * failed, and two others answering does not make it covered.
     *
     * <p>⚠️ The reader is deliberately vocabulary-agnostic — nothing here parses an
     * entry or resolves it against the payload. The security property rests on
     * NON-EMPTINESS alone; interpreting entries would break the moment the runtime
     * added a kind, and it would break by UNDER-reporting, which is the direction that
     * silently passes traffic.
     */
    public List<String> unjudged() {
        List<Object> raw = Json.getList(root, "unjudged");
        if (raw == null) {
            return Collections.emptyList();
        }
        List<String> out = new ArrayList<String>(raw.size());
        for (Object o : raw) {
            if (o instanceof String) {
                out.add((String) o);
            }
        }
        return out;
    }

    /** Whether the runtime answered about only PART of the event. */
    public boolean partial() {
        return !unjudged().isEmpty();
    }

    /** The fail-mode rule for partial coverage, kept pure so it is testable without a proxy. */
    public boolean mustRefusePartial(FailMode mode) {
        return mode.isClosed() && partial();
    }

    /**
     * The rendering directive, or {@code null} when there is none or it names a style
     * this build does not implement. See {@link Continuation}.
     *
     * <p>⚠️ A directive with a style we know but NO paths is rejected for the two styles
     * that act on paths: a {@code drop_calls} naming nothing would append a notice
     * saying an action was refused to a reply in which every action survived — the
     * shape that reads as a working control and is not one.
     */
    public Continuation continuation() {
        Map<String, Object> c = Json.getMap(root, "continuation");
        if (c == null) {
            return null;
        }
        String style = Json.str(c, "style");
        String notice = Json.str(c, "notice");
        if (notice.isEmpty()) {
            return null;
        }
        List<String> paths = new ArrayList<String>();
        List<Object> raw = Json.getList(c, "paths");
        if (raw != null) {
            for (Object o : raw) {
                if (o instanceof String && !((String) o).isEmpty()) {
                    paths.add((String) o);
                }
            }
        }
        if (Continuation.ANSWER.equals(style)) {
            return new Continuation(style, notice, paths);
        }
        if (Continuation.DROP_CALLS.equals(style) || Continuation.WITHHOLD.equals(style)) {
            return paths.isEmpty() ? null : new Continuation(style, notice, paths);
        }
        return null;
    }

    /**
     * The runtime's own two instants (OGR 1.8): when it received the request and when
     * it serialized this verdict. {@code null} when the verdict carries none.
     *
     * <p>⚠️⚠️ NEITHER IS TO BE SUBTRACTED FROM THIS PROCESS'S CLOCK. They are two points
     * of an NTP exchange whose other two this proxy holds (dispatch, receive);
     * {@link OgrClient} turns them into a network duration without either end trusting
     * the other's clock. Subtracting one from {@code Instant.now()} measures the clock
     * OFFSET and calls it latency — which is exactly the reading that once produced a
     * steady 2.1 seconds of imaginary network time.
     */
    public Instant receivedAt() {
        return instant("timing.received_at");
    }

    public Instant respondedAt() {
        return instant("timing.responded_at");
    }

    private Instant instant(String path) {
        String s = Json.str(root, path);
        if (s.isEmpty()) {
            return null;
        }
        try {
            return Instant.parse(s);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The findings, as raw maps. A RECORD for logging; nothing here branches on them. */
    public List<Object> findings() {
        List<Object> raw = Json.getList(root, "findings");
        return raw == null ? Collections.<Object>emptyList() : raw;
    }
}
