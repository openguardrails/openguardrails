package com.openguardrails.ogr.protocol;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Puts plaintext back into ONE streamed content channel, holding back only what could
 * still turn out to be a placeholder.
 *
 * <h2>The problem</h2>
 *
 * A placeholder is written into the request, so the model may echo it back — and a
 * stream delivers it in pieces. {@code ${OGR_EMA} + {IL_1}} arriving in two frames is
 * two deltas, neither of which contains a token, so a naive per-delta replace restores
 * nothing and the customer's application receives the placeholder as content. On the
 * next turn their client sends it back to us as text.
 *
 * <h2>The rule</h2>
 *
 * Emit everything that can no longer become a token, hold the rest. Concretely: after
 * replacing every complete token, the longest SUFFIX of the pending text that is a
 * proper PREFIX of some token is held back, and everything before it is released.
 *
 * <p>⚠️ Whatever is still held at end of stream must be FLUSHED as an extra frame. A
 * restorer that simply stops holding loses the answer's last few characters — the exact
 * loss it exists to prevent, arriving from the other side.
 *
 * <p>One instance per channel: the assistant text, the reasoning, and each tool call's
 * arguments are independent streams, and sharing a pending buffer between them splices
 * one channel's tail onto another's head.
 */
public final class Restorer {

    private final Map<String, String> mapping;
    private final Set<String> prefixes;
    private final int longestToken;
    private final StringBuilder pending = new StringBuilder();

    public Restorer(Map<String, String> mapping) {
        this.mapping = mapping;
        Set<String> p = new HashSet<String>();
        int longest = 0;
        if (mapping != null) {
            for (String token : mapping.keySet()) {
                longest = Math.max(longest, token.length());
                for (int i = 1; i < token.length(); i++) {
                    p.add(token.substring(0, i));
                }
            }
        }
        this.prefixes = p;
        this.longestToken = longest;
    }

    /** Whether there is anything to restore at all — the common case is nothing. */
    public boolean idle() {
        return mapping == null || mapping.isEmpty();
    }

    /** Feeds one delta and returns the text that is safe to emit now. */
    public String feed(String delta) {
        if (idle()) {
            return delta;
        }
        pending.append(delta);
        String text = pending.toString();
        for (Map.Entry<String, String> e : mapping.entrySet()) {
            if (text.indexOf(e.getKey()) >= 0) {
                text = text.replace(e.getKey(), e.getValue());
            }
        }
        int hold = holdLength(text);
        String emit = text.substring(0, text.length() - hold);
        pending.setLength(0);
        pending.append(text, text.length() - hold, text.length());
        return emit;
    }

    /** Everything still held. Empty once it has been called. */
    public String flush() {
        if (pending.length() == 0) {
            return "";
        }
        String rest = pending.toString();
        pending.setLength(0);
        return rest;
    }

    private int holdLength(String text) {
        int max = Math.min(text.length(), longestToken - 1);
        for (int n = max; n > 0; n--) {
            if (prefixes.contains(text.substring(text.length() - n))) {
                return n;
            }
        }
        return 0;
    }
}
