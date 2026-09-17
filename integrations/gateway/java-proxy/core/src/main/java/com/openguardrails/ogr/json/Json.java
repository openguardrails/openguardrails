package com.openguardrails.ogr.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader and writer.
 *
 * <h2>Why this library carries no JSON dependency</h2>
 *
 * This code is meant to be EMBEDDED in someone else's Java service — a Spring Boot
 * proxy that already pins its own Jackson, a Netty gateway that pins another. A
 * guardrail that forces a JSON library version onto its host is a guardrail an
 * operator has a reason to remove, so there is none: {@code core} depends on the JDK
 * and nothing else.
 *
 * <p>The second reason is stricter. Two jobs here look alike and are not:
 *
 * <ul>
 *   <li><b>Reading</b> a body to inspect it — is this a stream, which model, what did
 *       the reply say. That is what this class does.
 *   <li><b>Rewriting</b> a body that is about to be forwarded. That is
 *       {@link RawJson}, and it must never go through a parse-and-re-serialize
 *       round trip: re-encoding reorders keys and re-escapes strings, so every
 *       offset in a verdict would index bytes the runtime never counted, and the
 *       value a span was supposed to remove would travel on while the log said
 *       "masked".
 * </ul>
 *
 * <p>Keeping the two in separate classes is what keeps the second rule visible.
 *
 * <p>Numbers parse to {@link Long} when they are integral and fit, otherwise to
 * {@link Double}. Objects keep their insertion order ({@link LinkedHashMap}), which
 * matters only for readability of anything this class writes — a body read here is
 * never written back.
 */
public final class Json {

    private Json() {}

    /** Thrown when a document is not JSON. Callers that have a fallback use {@link #parseOrNull}. */
    public static class JsonException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public JsonException(String message) {
            super(message);
        }
    }

    // ---------------------------------------------------------------- reading

    public static Object parse(String text) {
        if (text == null) {
            throw new JsonException("null document");
        }
        Reader r = new Reader(text);
        r.skipWs();
        Object value = r.readValue();
        r.skipWs();
        if (r.pos != r.len) {
            throw new JsonException("trailing content at " + r.pos);
        }
        return value;
    }

    /** {@link #parse} with {@code null} for anything that is not JSON. */
    public static Object parseOrNull(String text) {
        try {
            return parse(text);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The document as an object, or {@code null} when it is not one. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object v = parseOrNull(text);
        return (v instanceof Map) ? (Map<String, Object>) v : null;
    }

    // ------------------------------------------------------------- navigation

    /**
     * Resolves a dotted path against a parsed document: {@code choices.0.message.content}.
     * Bracket form ({@code choices[0].message.content}) is accepted and folded first.
     * Returns {@code null} for any segment that does not resolve.
     */
    public static Object get(Object root, String path) {
        if (root == null || path == null || path.isEmpty()) {
            return root;
        }
        Object cur = root;
        for (String seg : dotted(path).split("\\.", -1)) {
            if (cur == null) {
                return null;
            }
            if (cur instanceof Map) {
                cur = ((Map<?, ?>) cur).get(seg);
            } else if (cur instanceof List) {
                int i = index(seg);
                List<?> list = (List<?>) cur;
                cur = (i >= 0 && i < list.size()) ? list.get(i) : null;
            } else {
                return null;
            }
        }
        return cur;
    }

    /** The string at {@code path}, or {@code null} when it is absent or not a string. */
    public static String getString(Object root, String path) {
        Object v = get(root, path);
        return (v instanceof String) ? (String) v : null;
    }

    /** The string at {@code path}, or {@code ""} — for the many fields where absent and empty mean the same. */
    public static String str(Object root, String path) {
        String s = getString(root, path);
        return s == null ? "" : s;
    }

    public static boolean getBool(Object root, String path) {
        Object v = get(root, path);
        return (v instanceof Boolean) && (Boolean) v;
    }

    public static long getLong(Object root, String path, long fallback) {
        Object v = get(root, path);
        if (v instanceof Long) {
            return (Long) v;
        }
        if (v instanceof Double) {
            return (long) (double) (Double) v;
        }
        return fallback;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> getList(Object root, String path) {
        Object v = get(root, path);
        return (v instanceof List) ? (List<Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> getMap(Object root, String path) {
        Object v = get(root, path);
        return (v instanceof Map) ? (Map<String, Object>) v : null;
    }

    /** Folds {@code a[0].b} into {@code a.0.b}, the only form the resolvers read. */
    public static String dotted(String path) {
        if (path.indexOf('[') < 0) {
            return path;
        }
        StringBuilder out = new StringBuilder(path.length());
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '[') {
                if (out.length() > 0 && out.charAt(out.length() - 1) != '.') {
                    out.append('.');
                }
            } else if (c == ']') {
                if (i + 1 < path.length() && path.charAt(i + 1) == '.') {
                    i++;
                }
                if (i + 1 < path.length()) {
                    out.append('.');
                }
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static int index(String seg) {
        if (seg.isEmpty()) {
            return -1;
        }
        for (int i = 0; i < seg.length(); i++) {
            if (seg.charAt(i) < '0' || seg.charAt(i) > '9') {
                return -1;
            }
        }
        try {
            return Integer.parseInt(seg);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    // ---------------------------------------------------------------- writing

    public static String write(Object value) {
        StringBuilder sb = new StringBuilder(64);
        writeTo(sb, value);
        return sb.toString();
    }

    public static void writeTo(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof Raw) {
            sb.append(((Raw) value).json);
        } else if (value instanceof String) {
            escape(sb, (String) value);
        } else if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
            sb.append(value);
        } else if (value instanceof Double || value instanceof Float) {
            double d = ((Number) value).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                sb.append("null"); // JSON has no NaN; a null says "no number" honestly
            } else if (d == Math.rint(d) && Math.abs(d) < 1e15) {
                sb.append((long) d);
            } else {
                sb.append(d);
            }
        } else if (value instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (e.getValue() == null) {
                    continue; // an absent key and a null one are different answers; we write absent
                }
                if (!first) {
                    sb.append(',');
                }
                first = false;
                escape(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeTo(sb, e.getValue());
            }
            sb.append('}');
        } else if (value instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object o : (List<?>) value) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeTo(sb, o);
            }
            sb.append(']');
        } else {
            escape(sb, String.valueOf(value));
        }
    }

    /**
     * A pre-serialized JSON fragment that writes as itself.
     *
     * <p>This is how a provider body reaches the wire as {@code payload}: verbatim,
     * never re-marshalled. An invalid fragment degrades to a JSON string rather than
     * corrupting the document around it — a truncated argument stream must not be
     * able to break the whole event.
     */
    public static final class Raw {
        public final String json;

        private Raw(String json) {
            this.json = json;
        }

        public static Raw of(String json) {
            if (json == null || json.isEmpty()) {
                return new Raw("null");
            }
            return new Raw(valid(json) ? json : write(json));
        }
    }

    public static Raw raw(String json) {
        return Raw.of(json);
    }

    /** Whether a fragment parses. Used only to decide whether {@link Raw} may pass it through. */
    public static boolean valid(String json) {
        try {
            parse(json);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        escape(sb, s);
        return sb.toString();
    }

    public static void escape(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    /** An ordered map literal: {@code obj("a", 1, "b", "two")}. A null value is dropped by the writer. */
    public static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }

    // ----------------------------------------------------------------- parser

    private static final class Reader {
        private final String s;
        private final int len;
        private int pos;

        Reader(String s) {
            this.s = s;
            this.len = s.length();
        }

        void skipWs() {
            while (pos < len) {
                char c = s.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    return;
                }
            }
        }

        Object readValue() {
            if (pos >= len) {
                throw new JsonException("unexpected end of document");
            }
            char c = s.charAt(pos);
            switch (c) {
                case '{':
                    return readObject();
                case '[':
                    return readArray();
                case '"':
                    return readString();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return readNumber();
            }
        }

        private void expect(String word) {
            if (!s.startsWith(word, pos)) {
                throw new JsonException("bad literal at " + pos);
            }
            pos += word.length();
        }

        private Map<String, Object> readObject() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            pos++; // '{'
            skipWs();
            if (pos < len && s.charAt(pos) == '}') {
                pos++;
                return m;
            }
            while (true) {
                skipWs();
                if (pos >= len || s.charAt(pos) != '"') {
                    throw new JsonException("expected key at " + pos);
                }
                String key = readString();
                skipWs();
                if (pos >= len || s.charAt(pos) != ':') {
                    throw new JsonException("expected ':' at " + pos);
                }
                pos++;
                skipWs();
                m.put(key, readValue());
                skipWs();
                if (pos >= len) {
                    throw new JsonException("unterminated object");
                }
                char c = s.charAt(pos++);
                if (c == '}') {
                    return m;
                }
                if (c != ',') {
                    throw new JsonException("expected ',' or '}' at " + (pos - 1));
                }
            }
        }

        private List<Object> readArray() {
            List<Object> list = new ArrayList<Object>();
            pos++; // '['
            skipWs();
            if (pos < len && s.charAt(pos) == ']') {
                pos++;
                return list;
            }
            while (true) {
                skipWs();
                list.add(readValue());
                skipWs();
                if (pos >= len) {
                    throw new JsonException("unterminated array");
                }
                char c = s.charAt(pos++);
                if (c == ']') {
                    return list;
                }
                if (c != ',') {
                    throw new JsonException("expected ',' or ']' at " + (pos - 1));
                }
            }
        }

        private String readString() {
            int end = RawJson.stringEnd(s, pos);
            if (end < 0) {
                throw new JsonException("unterminated string at " + pos);
            }
            String decoded = RawJson.decodeString(s, pos, end);
            pos = end;
            return decoded;
        }

        private Object readNumber() {
            int start = pos;
            if (pos < len && (s.charAt(pos) == '-' || s.charAt(pos) == '+')) {
                pos++;
            }
            boolean integral = true;
            while (pos < len) {
                char c = s.charAt(pos);
                if (c >= '0' && c <= '9') {
                    pos++;
                } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                    integral = false;
                    pos++;
                } else {
                    break;
                }
            }
            String text = s.substring(start, pos);
            if (text.isEmpty() || "-".equals(text) || "+".equals(text)) {
                throw new JsonException("bad number at " + start);
            }
            if (integral) {
                try {
                    return Long.valueOf(Long.parseLong(text));
                } catch (NumberFormatException e) {
                    // falls through to double: an integer past 64 bits is still a number
                }
            }
            try {
                return Double.valueOf(Double.parseDouble(text));
            } catch (NumberFormatException e) {
                throw new JsonException("bad number at " + start);
            }
        }
    }
}
