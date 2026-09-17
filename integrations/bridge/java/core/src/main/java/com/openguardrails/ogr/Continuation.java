package com.openguardrails.ogr;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * HOW the runtime asks this proxy to say no (OGR 1.3).
 *
 * <h2>⚠️⚠️ It never turns a refusal into an allow</h2>
 *
 * {@code decision} is still {@code block} and the action still does not happen. This
 * selects WHICH SHAPE the refusal takes, because the shape the obvious implementation
 * uses — {@code finish_reason: "content_filter"} / {@code stop_reason: "refusal"} — is
 * the single token every agent harness treats as TERMINAL. One refused tool call in a
 * nine-step task ended the task. So the WHY moves off the finish reason and into two
 * places no loop branches on: an {@code x_ogr} body key and the notice the model reads.
 *
 * <h2>⚠️ Absent is the normal case and means "refuse as you always did"</h2>
 *
 * An older runtime sends nothing; a runtime that could not name an honest shape sends
 * nothing; both must land on the hard refusal. So every reader tests for a style it
 * KNOWS rather than for "not empty" — an unrecognised style is a directive from a newer
 * runtime, and guessing at it is how an enforcement point forwards what it was told to
 * remove.
 *
 * <p>The three styles, and which half of the step each acts on:
 *
 * <ul>
 *   <li>{@code drop_calls} — RESPONSE. Remove the named {@code payload.tool_calls.N}
 *       elements, keep the rest, append the notice. The calls the policy allowed still
 *       execute.
 *   <li>{@code withhold} — REQUEST. Replace the text at each path (a tool result) with
 *       the notice and FORWARD the request. The turn continues; the content does not
 *       reach the model.
 *   <li>{@code answer} — the notice is the whole reply, on a normal stop.
 * </ul>
 */
public final class Continuation {

    public static final String DROP_CALLS = "drop_calls";
    public static final String WITHHOLD = "withhold";
    public static final String ANSWER = "answer";

    public final String style;
    public final String notice;
    public final List<String> paths;

    Continuation(String style, String notice, List<String> paths) {
        this.style = style;
        this.notice = notice;
        this.paths = Collections.unmodifiableList(paths);
    }

    /**
     * The paths in the form a body resolver reads — the {@code payload.} prefix
     * stripped, because the runtime speaks payload paths and the body has no
     * {@code payload} wrapper.
     *
     * <p>A path that does not carry the prefix contributes nothing rather than being
     * guessed at.
     */
    public List<String> strippedPaths() {
        List<String> out = new ArrayList<String>(paths.size());
        for (String p : paths) {
            String s = Spans.stripPayloadPrefix(p);
            if (!s.isEmpty()) {
                out.add(s);
            }
        }
        return out;
    }

    /**
     * The tool-call ordinals this directive refuses, read off the trailing index of
     * each path.
     *
     * <p>⚠️ A STREAM has no body to address, only the reassembled call list, so the only
     * thing a path can contribute there is WHICH call. A path whose tail is not an
     * integer yields {@code null} for the whole set, and the caller then treats that as
     * "cannot render survivors" and drops the remainder whole. Guessing here would keep
     * a refused call.
     */
    public List<Integer> droppedOrdinals() {
        List<Integer> out = new ArrayList<Integer>(paths.size());
        for (String p : paths) {
            int cut = p.lastIndexOf('.');
            if (cut < 0) {
                return null;
            }
            try {
                int n = Integer.parseInt(p.substring(cut + 1));
                if (n < 0) {
                    return null;
                }
                out.add(Integer.valueOf(n));
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return out;
    }

    @Override
    public String toString() {
        return "Continuation[" + style + " paths=" + paths + "]";
    }
}
