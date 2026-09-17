package com.openguardrails.ogr;

/**
 * One modification the runtime asks this enforcement point to apply IN PLACE:
 * {@code {path, start, end, replacement}}, with the offsets counted in CODE POINTS
 * against the payload as transported.
 *
 * <p>⚠️ The runtime deliberately does NOT return plaintext. A span carries offsets and
 * a replacement token, so no verdict store becomes a copy of the data it guards. The
 * process that already holds the plaintext — this proxy — slices the span out of its
 * own bytes, which is also how the token→value mapping for restoring the reply is
 * learned.
 *
 * <p>⚠️ {@code allow} with a non-empty span list is not a contradiction: redaction is
 * not a decision. The two questions are independent, and a redacting verdict means
 * "send it, with these characters replaced".
 */
public final class Span {

    public final String path;
    public final int start;
    public final int end;
    public final String replacement;

    public Span(String path, int start, int end, String replacement) {
        this.path = path == null ? "" : path;
        this.start = start;
        this.end = end;
        this.replacement = replacement == null ? "" : replacement;
    }

    @Override
    public String toString() {
        return path + "[" + start + "," + end + ")→" + replacement;
    }
}
