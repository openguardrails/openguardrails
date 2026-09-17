package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Applying a verdict's modification spans to the body that is about to be forwarded.
 *
 * <h2>⚠️⚠️ A span that does not resolve is DROPPED and COUNTED, never applied elsewhere</h2>
 *
 * A path that names no string in this body, or offsets past the end of the value, means
 * this is not the body the runtime judged. Slicing one span's offsets out of another
 * text masks characters nobody detected while the real value travels on — and both
 * failures look exactly like a healthy proxy. The count is the only thing that says
 * otherwise, which is why it goes on the heartbeat as {@code unresolved_spans}.
 *
 * <h2>Highest offset first</h2>
 *
 * Spans on one path are applied in DESCENDING start order, so an earlier splice cannot
 * shift the offsets a later span was computed against.
 */
public final class Spans {

    private Spans() {}

    /** The outcome of applying a span set. */
    public static final class Result {
        public final String body;
        public final int applied;
        public final int unresolved;

        /**
         * token → the characters it displaced, learned from the splices.
         *
         * <p>This is what restores the model's reply: the model may echo
         * {@code ${OGR_EMAIL_1}} and the caller must receive its own data back. It is
         * learned rather than received, because the runtime returns no plaintext.
         */
        public final Map<String, String> learned;

        Result(String body, int applied, int unresolved, Map<String, String> learned) {
            this.body = body;
            this.applied = applied;
            this.unresolved = unresolved;
            this.learned = Collections.unmodifiableMap(learned);
        }

        public boolean changed() {
            return applied > 0;
        }
    }

    /** The most placeholders one request may carry. Past this a body is not being redacted, it is being copied. */
    public static final int MAX_TOKENS = 256;

    public static Result apply(String body, List<Span> spans) {
        if (spans == null || spans.isEmpty()) {
            return new Result(body, 0, 0, new LinkedHashMap<String, String>());
        }
        Map<String, List<Span>> byPath = new LinkedHashMap<String, List<Span>>();
        int unresolved = 0;
        for (Span s : spans) {
            String p = stripPayloadPrefix(s.path);
            if (p.isEmpty() || s.replacement.isEmpty()) {
                unresolved++;
                continue;
            }
            List<Span> group = byPath.get(p);
            if (group == null) {
                group = new ArrayList<Span>();
                byPath.put(p, group);
            }
            group.add(s);
        }

        String out = body;
        int applied = 0;
        Map<String, String> learned = new LinkedHashMap<String, String>();
        for (Map.Entry<String, List<Span>> e : byPath.entrySet()) {
            String path = e.getKey();
            List<Span> group = e.getValue();
            String text = RawJson.stringAt(out, path);
            if (text == null) {
                unresolved += group.size();
                continue;
            }
            Collections.sort(group, new Comparator<Span>() {
                @Override
                public int compare(Span a, Span b) {
                    return Integer.compare(b.start, a.start);
                }
            });
            boolean changed = false;
            int appliedHere = 0;
            for (Span s : group) {
                String[] next = RawJson.replaceRunes(text, s.start, s.end, s.replacement);
                if (next == null) {
                    unresolved++;
                    continue;
                }
                text = next[0];
                changed = true;
                appliedHere++;
                if (learned.size() < MAX_TOKENS && !next[1].isEmpty()) {
                    learned.put(s.replacement, next[1]);
                }
            }
            if (!changed) {
                continue;
            }
            String rewritten = RawJson.replaceStringValue(out, path, text);
            if (rewritten == null) {
                // The path resolved for reading, so a write failure is a corrupt body:
                // count the group unresolved rather than forwarding a half-edit.
                unresolved += group.size();
                continue;
            }
            out = rewritten;
            applied += appliedHere;
        }
        return new Result(out, applied, unresolved, learned);
    }

    /**
     * Replaces the whole text at each path with the notice — the {@code withhold}
     * continuation, and the only shape that lets a REQUEST carrying a refused tool
     * result proceed.
     *
     * <p>⚠️⚠️ NOTHING IS LEARNED INTO THE RESTORE MAP, and that is the load-bearing
     * difference from {@link #apply}. A redaction's replacement is a placeholder this
     * proxy puts BACK on the way home; a withheld tool result must never come back.
     * Feeding this to the restore map would have the model's own reply rehydrate the
     * exfiltrated page we just removed — the control inverted, silently, on the return
     * path.
     *
     * <p>⚠️ WHOLE-VALUE replacement, never a span: the runtime judged the entire tool
     * result, so offsets into it name nothing worth keeping, and a partial replacement
     * would leave the untrusted remainder in front of the model under a notice claiming
     * it was withheld.
     *
     * <p>⚠️ ALL OR NOTHING. A path that does not resolve means this is not the body the
     * runtime judged, and the caller must fall back to the REFUSAL — never to the
     * passthrough.
     *
     * @return the rewritten body, or {@code null} when any path did not resolve
     */
    public static String withhold(String body, List<String> paths, String notice) {
        if (paths == null || paths.isEmpty()) {
            return null;
        }
        String out = body;
        for (String p : paths) {
            if (RawJson.stringAt(out, p) == null) {
                return null;
            }
            String next = RawJson.replaceStringValue(out, p, notice);
            if (next == null) {
                return null;
            }
            out = next;
        }
        return out;
    }


    /**
     * {@link #restoreInto} applied to a NON-STRING value — Anthropic transports a tool
     * call's {@code input} as a real object, so its placeholders live inside string
     * leaves of a subtree rather than in one string.
     *
     * <p>The replacement is done on the value's RAW JSON text, with each plaintext value
     * escaped as it would appear inside a JSON string. That is exact because a
     * placeholder is plain ASCII with nothing in it that JSON escapes, so it can only
     * ever match inside a string literal.
     */
    public static String restoreRawAt(String body, String path, Map<String, String> mapping) {
        if (mapping == null || mapping.isEmpty()) {
            return body;
        }
        RawJson.Range r = RawJson.locate(body, path);
        if (r == null) {
            return body;
        }
        String raw = r.of(body);
        String out = raw;
        for (Map.Entry<String, String> e : mapping.entrySet()) {
            if (out.indexOf(e.getKey()) >= 0) {
                out = out.replace(e.getKey(), escapeInner(e.getValue()));
            }
        }
        if (out.equals(raw)) {
            return body;
        }
        String next = RawJson.replaceValue(body, path, out);
        return next == null ? body : next;
    }

    /** A value escaped for the inside of a JSON string literal, without the quotes. */
    static String escapeInner(String value) {
        String quoted = Json.escape(value);
        return quoted.substring(1, quoted.length() - 1);
    }

    /**
     * Folds a wire path ({@code payload.messages.3.content}, bracket form included)
     * into the path inside the body ({@code messages.3.content}).
     *
     * <p>A path that is not under {@code payload} names nothing this proxy can address,
     * and answers "".
     */
    public static String stripPayloadPrefix(String path) {
        if (path == null) {
            return "";
        }
        String p = Json.dotted(path);
        if ("payload".equals(p)) {
            return "";
        }
        return p.startsWith("payload.") ? p.substring("payload.".length()) : "";
    }

    /**
     * Puts plaintext back wherever a token appears in {@code text}.
     *
     * <p>⚠️ Not symmetric with masking failing. If a value is masked and never restored,
     * the caller receives {@code ${OGR_EMAIL_1}} where its own data belongs — the
     * placeholder escapes into the customer's application, and on the next turn their
     * client sends it back as content.
     */
    public static String restoreInto(String text, Map<String, String> mapping) {
        if (text == null || text.isEmpty() || mapping == null || mapping.isEmpty()) {
            return text;
        }
        String out = text;
        for (Map.Entry<String, String> e : mapping.entrySet()) {
            if (out.indexOf(e.getKey()) >= 0) {
                out = out.replace(e.getKey(), e.getValue());
            }
        }
        return out;
    }

    /** {@link #restoreInto} applied to the string at one body path; returns the body unchanged when it is absent. */
    public static String restoreAt(String body, String path, Map<String, String> mapping) {
        String text = RawJson.stringAt(body, path);
        if (text == null) {
            return body;
        }
        String restored = restoreInto(text, mapping);
        if (restored.equals(text)) {
            return body;
        }
        String next = RawJson.replaceStringValue(body, path, restored);
        return next == null ? body : next;
    }
}
