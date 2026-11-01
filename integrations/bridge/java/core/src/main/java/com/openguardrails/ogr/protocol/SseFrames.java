package com.openguardrails.ogr.protocol;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * SSE framing, shared; SSE SEMANTICS, per protocol.
 *
 * <p>All three protocols stream {@code data: <json>} lines, so finding frame boundaries
 * and carrying a frame that a chunk split in half is identical work and lives here.
 *
 * <h2>Why this splits BYTES and not characters</h2>
 *
 * A network chunk boundary falls wherever TCP put it, which is regularly in the middle
 * of a multi-byte UTF-8 sequence. Decoding each chunk to a string as it arrives turns
 * that into a replacement character — silently, in the middle of a Chinese word — and
 * the corruption is then in the reassembled text a guardrail judges AND in the bytes the
 * client renders. Frames always end at a newline, so decoding a COMPLETE frame is always
 * safe.
 *
 * <h2>A frame, never a line</h2>
 *
 * ⚠️ The unit is the frame, because a {@code data:} line is inert until its blank
 * terminator: releasing one without the other spends the streaming head budget on bytes
 * the client cannot render yet.
 */
public final class SseFrames {

    private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

    /** Feeds a network chunk and returns the COMPLETE frames it completed, in order. */
    public List<String> feed(byte[] chunk, int length) {
        pending.write(chunk, 0, length);
        List<String> out = new ArrayList<String>();
        byte[] buffer = pending.toByteArray();
        int start = 0;
        int i = 0;
        while (i + 1 < buffer.length) {
            if (buffer[i] == '\n' && buffer[i + 1] == '\n') {
                out.add(new String(buffer, start, i + 2 - start, StandardCharsets.UTF_8));
                i += 2;
                start = i;
                continue;
            }
            if (i + 3 < buffer.length
                && buffer[i] == '\r' && buffer[i + 1] == '\n'
                && buffer[i + 2] == '\r' && buffer[i + 3] == '\n') {
                out.add(new String(buffer, start, i + 4 - start, StandardCharsets.UTF_8));
                i += 4;
                start = i;
                continue;
            }
            i++;
        }
        pending.reset();
        if (start < buffer.length) {
            pending.write(buffer, start, buffer.length - start);
        }
        return out;
    }

    /**
     * Whatever is left that never became a frame.
     *
     * <p>⚠️ Forwarded at end of stream rather than dropped: an upstream that ends without
     * a terminating blank line has still sent bytes the client may need, and silently
     * eating them is how a proxy turns a provider quirk into a truncated answer.
     */
    public String remainder() {
        if (pending.size() == 0) {
            return "";
        }
        String rest = new String(pending.toByteArray(), StandardCharsets.UTF_8);
        pending.reset();
        return rest;
    }

    /** Renders one {@code data:} frame. */
    public static String frame(String data) {
        return "data: " + data + "\n\n";
    }

    /** Renders one named-event frame — Anthropic's dialect. */
    public static String event(String name, String data) {
        return "event: " + name + "\ndata: " + data + "\n\n";
    }

    /**
     * The concatenated {@code data:} payload of a frame, or {@code null} when it carries
     * none (a comment line, a bare {@code event:} line, a keepalive).
     */
    public static String dataOf(String frame) {
        StringBuilder sb = null;
        for (String line : frame.split("\n")) {
            String l = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            if (!l.startsWith("data:")) {
                continue;
            }
            String value = l.substring(5);
            if (value.startsWith(" ")) {
                value = value.substring(1);
            }
            if (sb == null) {
                sb = new StringBuilder(value);
            } else {
                sb.append('\n').append(value);
            }
        }
        return sb == null ? null : sb.toString();
    }

    /** The {@code event:} name of a frame, or "". */
    public static String eventOf(String frame) {
        for (String line : frame.split("\n")) {
            String l = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            if (l.startsWith("event:")) {
                return l.substring(6).trim();
            }
        }
        return "";
    }

    /** UTF-8 byte length — the unit the streaming head budget is counted in. */
    public static int utf8Length(String s) {
        return s == null ? 0 : s.getBytes(StandardCharsets.UTF_8).length;
    }
}
