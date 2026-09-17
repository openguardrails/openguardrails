package com.openguardrails.ogr.json;

import java.util.List;

/**
 * Surgical edits to a JSON document, by raw character range.
 *
 * <h2>The rule this class exists to keep</h2>
 *
 * A verdict's {@code modifications.spans} and {@code continuation.paths} address the
 * body <b>as transported</b>. So every rewrite here leaves every byte it did not
 * change exactly where it was: the document is never parsed into a tree and written
 * back out. A round trip through any JSON writer reorders keys and re-escapes
 * strings ({@code <} becomes {@code <} in several libraries), and the failure
 * that follows is the worst one available — the log says "applied 3 spans" while the
 * value the runtime asked us to remove travels to the model untouched, because every
 * offset after the first re-escape landed in different characters.
 *
 * <h2>Offsets are CHARACTERS, and that is not free</h2>
 *
 * {@link #replaceRunes} counts the span in Unicode CODE POINTS, because that is what
 * the runtime counts. Java strings are UTF-16, so an emoji or a CJK Extension-B
 * character ahead of a span shifts a naive {@code String.substring} by one position
 * per character — and the result is a masked fragment that matches nothing while the
 * real value goes through. BMP text (including all common Chinese) is identical under
 * both counts, which is exactly why this kind of bug survives every test written in
 * one language.
 */
public final class RawJson {

    private RawJson() {}

    /** A raw character range {@code [start, end)} of the source document. */
    public static final class Range {
        public final int start;
        public final int end;

        Range(int start, int end) {
            this.start = start;
            this.end = end;
        }

        public String of(String body) {
            return body.substring(start, end);
        }
    }

    // --------------------------------------------------------------- locating

    /**
     * The raw range of the value at {@code dottedPath}, or {@code null} when the path
     * names nothing in this document.
     *
     * <p>An empty path names the whole document.
     */
    public static Range locate(String body, String dottedPath) {
        if (body == null) {
            return null;
        }
        int i = skipWs(body, 0);
        if (i >= body.length()) {
            return null;
        }
        String path = dottedPath == null ? "" : Json.dotted(dottedPath);
        if (path.isEmpty()) {
            int end = skipValue(body, i);
            return end < 0 ? null : new Range(i, end);
        }
        int valueStart = i;
        for (String seg : path.split("\\.", -1)) {
            if (seg.isEmpty()) {
                return null;
            }
            char c = body.charAt(valueStart);
            Range next;
            if (c == '{') {
                next = memberOf(body, valueStart, seg);
            } else if (c == '[') {
                int idx = asIndex(seg);
                next = idx < 0 ? null : elementOf(body, valueStart, idx);
            } else {
                return null;
            }
            if (next == null) {
                return null;
            }
            valueStart = next.start;
            if (valueStart >= body.length()) {
                return null;
            }
        }
        int end = skipValue(body, valueStart);
        return end < 0 ? null : new Range(valueStart, end);
    }

    /** The decoded string at {@code path}, or {@code null} when it is absent or not a string. */
    public static String stringAt(String body, String path) {
        Range r = locate(body, path);
        if (r == null || body.charAt(r.start) != '"') {
            return null;
        }
        return decodeString(body, r.start, r.end);
    }

    /** Whether the top-level object already carries {@code key}. */
    public static boolean hasTopLevelKey(String body, String key) {
        int i = skipWs(body, 0);
        if (i >= body.length() || body.charAt(i) != '{') {
            return false;
        }
        return memberOf(body, i, key) != null;
    }

    // --------------------------------------------------------------- rewriting

    /**
     * Replaces the whole string value at {@code path} with {@code replacement},
     * re-encoded. Returns {@code null} when the path does not name a string — the
     * caller then counts the edit unresolved rather than writing somewhere else.
     *
     * <p>Only the bytes of that one string literal change; everything around it is
     * carried through untouched.
     */
    public static String replaceStringValue(String body, String path, String replacement) {
        Range r = locate(body, path);
        if (r == null || body.charAt(r.start) != '"') {
            return null;
        }
        return body.substring(0, r.start) + Json.escape(replacement) + body.substring(r.end);
    }

    /**
     * Replaces {@code [start, end)} — counted in CODE POINTS — of {@code text} with
     * {@code replacement}, returning the new text and the characters displaced.
     * Returns {@code null} when the range does not lie inside the text.
     */
    public static String[] replaceRunes(String text, int start, int end, String replacement) {
        if (start < 0 || end <= start) {
            return null;
        }
        int from = offsetByCodePoints(text, start);
        if (from < 0) {
            return null;
        }
        int to = offsetByCodePoints(text, end);
        if (to < 0) {
            return null;
        }
        return new String[] {
            text.substring(0, from) + replacement + text.substring(to),
            text.substring(from, to),
        };
    }

    /** The UTF-16 index of code point {@code n}, or {@code -1} when the text is shorter. */
    private static int offsetByCodePoints(String text, int n) {
        int i = 0;
        int seen = 0;
        while (seen < n) {
            if (i >= text.length()) {
                return -1;
            }
            i += Character.charCount(text.codePointAt(i));
            seen++;
        }
        return i;
    }

    /**
     * Inserts one sibling key at the head of a top-level object, by byte insertion.
     *
     * <p>This is how {@code timing} joins a provider body on its way into a
     * GuardEvent. Inserting after the opening brace leaves every original character —
     * and therefore every offset a verdict span can name — exactly where it was. A
     * body that is not a JSON object, or that already carries the key, is returned
     * untouched: a duplicate key is a worse answer than a missing one.
     */
    public static String spliceTopLevel(String body, String key, String rawValueJson) {
        if (body == null || rawValueJson == null || rawValueJson.isEmpty()) {
            return body;
        }
        int i = skipWs(body, 0);
        if (i >= body.length() || body.charAt(i) != '{') {
            return body;
        }
        if (hasTopLevelKey(body, key)) {
            return body;
        }
        int after = skipWs(body, i + 1);
        String separator = (after < body.length() && body.charAt(after) == '}') ? "" : ",";
        return body.substring(0, i + 1)
            + Json.escape(key) + ":" + rawValueJson + separator
            + body.substring(i + 1);
    }

    /**
     * Removes array elements by index from the array at {@code arrayPath}.
     *
     * <p>Returns {@code null} when the path is not an array or any index is out of
     * range. ALL OR NOTHING, like every multi-path edit in this integration: a partial
     * drop forwards the tool calls a policy refused, under a notice claiming they were
     * refused — the shape that reads as a working control and is not one.
     */
    public static String removeArrayElements(String body, String arrayPath, List<Integer> indexes) {
        Range arr = locate(body, arrayPath);
        if (arr == null || body.charAt(arr.start) != '[' || indexes == null || indexes.isEmpty()) {
            return null;
        }
        int count = 0;
        while (elementOf(body, arr.start, count) != null) {
            count++;
        }
        for (Integer idx : indexes) {
            if (idx == null || idx < 0 || idx >= count) {
                return null;
            }
        }
        StringBuilder rebuilt = new StringBuilder("[");
        boolean first = true;
        for (int n = 0; n < count; n++) {
            if (indexes.contains(Integer.valueOf(n))) {
                continue;
            }
            Range el = elementOf(body, arr.start, n);
            int end = skipValue(body, el.start);
            if (end < 0) {
                return null;
            }
            if (!first) {
                rebuilt.append(',');
            }
            first = false;
            rebuilt.append(body, el.start, end);
        }
        rebuilt.append(']');
        return body.substring(0, arr.start) + rebuilt + body.substring(arr.end);
    }

    /**
     * Appends one raw element to the array at {@code path}, leaving every element already
     * there byte for byte.
     *
     * <p>The alternative — parse the array, add, re-serialize — rewrites the model's own
     * output on its way to the client, and this is the drop-calls path, where what
     * SURVIVED is exactly what must not be touched.
     *
     * @return the new body, or {@code null} when the path is not an array
     */
    public static String appendArrayElement(String body, String path, String rawJson) {
        Range arr = locate(body, path);
        if (arr == null || body.charAt(arr.start) != '[') {
            return null;
        }
        int closing = arr.end - 1;
        int lastContent = skipWsBack(body, closing - 1);
        String separator = (lastContent > arr.start) ? "," : "";
        return body.substring(0, closing) + separator + rawJson + body.substring(closing);
    }

    /** How many elements the array at {@code path} holds; {@code -1} when it is not an array. */
    public static int arrayLength(String body, String path) {
        Range arr = locate(body, path);
        if (arr == null || body.charAt(arr.start) != '[') {
            return -1;
        }
        int n = 0;
        while (elementOf(body, arr.start, n) != null) {
            n++;
        }
        return n;
    }


    /**
     * Replaces whatever value sits at {@code path} with a raw JSON fragment, leaving
     * every other character of the document where it was. {@code null} when the path
     * names nothing.
     */
    public static String replaceValue(String body, String path, String rawJson) {
        Range r = locate(body, path);
        if (r == null) {
            return null;
        }
        return body.substring(0, r.start) + rawJson + body.substring(r.end);
    }

    /**
     * Sets a member of the object at {@code objectPath} ({@code ""} for the document
     * itself) to a raw JSON fragment, inserting it at the head when it is absent.
     * {@code null} when the path does not name an object.
     */
    public static String putMember(String body, String objectPath, String key, String rawJson) {
        Range obj = locate(body, objectPath);
        if (obj == null || body.charAt(obj.start) != '{') {
            return null;
        }
        String memberPath = objectPath == null || objectPath.isEmpty() ? key : objectPath + "." + key;
        if (locate(body, memberPath) != null) {
            return replaceValue(body, memberPath, rawJson);
        }
        int after = skipWs(body, obj.start + 1);
        String separator = (after < body.length() && body.charAt(after) == '}') ? "" : ",";
        return body.substring(0, obj.start + 1)
            + Json.escape(key) + ":" + rawJson + separator
            + body.substring(obj.start + 1);
    }

    /**
     * Removes a member of the object at {@code objectPath}. Returns the body unchanged
     * when the member is not there — an absent key is already the intended state.
     *
     * <p>The member's extent is found by walking the object FORWARD, never by scanning
     * backwards from the value: a key containing an escaped quote makes a backward walk
     * stop in the middle of the key, and the cut then eats a character of the member
     * before it.
     */
    public static String removeMember(String body, String objectPath, String key) {
        Range obj = locate(body, objectPath);
        if (obj == null || body.charAt(obj.start) != '{') {
            return body;
        }
        int[] extent = memberExtent(body, obj.start, key);
        if (extent == null) {
            return body;
        }
        int cutFrom = extent[0];
        int cutTo = extent[1];
        int before = skipWsBack(body, cutFrom - 1);
        int afterIdx = skipWs(body, cutTo);
        if (afterIdx < body.length() && body.charAt(afterIdx) == ',') {
            cutTo = afterIdx + 1; // a following member exists: take the comma after us
        } else if (before > obj.start && body.charAt(before) == ',') {
            cutFrom = before;     // we are last: take the comma before us
        }
        return body.substring(0, cutFrom) + body.substring(cutTo);
    }

    /** {@code [keyStart, valueEnd)} of one member of the object starting at {@code objStart}. */
    private static int[] memberExtent(String s, int objStart, String key) {
        int i = skipWs(s, objStart + 1);
        while (i < s.length() && s.charAt(i) == '"') {
            int keyStart = i;
            int keyEnd = stringEnd(s, i);
            if (keyEnd < 0) {
                return null;
            }
            String k = decodeString(s, i, keyEnd);
            i = skipWs(s, keyEnd);
            if (i >= s.length() || s.charAt(i) != ':') {
                return null;
            }
            i = skipWs(s, i + 1);
            int valueEnd = skipValue(s, i);
            if (valueEnd < 0) {
                return null;
            }
            if (k.equals(key)) {
                return new int[] {keyStart, valueEnd};
            }
            i = skipWs(s, valueEnd);
            if (i >= s.length() || s.charAt(i) != ',') {
                return null;
            }
            i = skipWs(s, i + 1);
        }
        return null;
    }

    private static int skipWsBack(String s, int i) {
        while (i >= 0) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                i--;
            } else {
                return i;
            }
        }
        return -1;
    }

    // ---------------------------------------------------------------- scanning

    static int skipWs(String s, int i) {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                i++;
            } else {
                return i;
            }
        }
        return i;
    }

    /** The index just past the value that starts at {@code i}; {@code -1} when it is malformed. */
    static int skipValue(String s, int i) {
        if (i >= s.length()) {
            return -1;
        }
        char c = s.charAt(i);
        switch (c) {
            case '"':
                return stringEnd(s, i);
            case '{':
                return containerEnd(s, i, '{', '}');
            case '[':
                return containerEnd(s, i, '[', ']');
            default:
                break;
        }
        int j = i;
        while (j < s.length()) {
            char d = s.charAt(j);
            if (d == ',' || d == '}' || d == ']' || d == ' ' || d == '\t' || d == '\n' || d == '\r') {
                break;
            }
            j++;
        }
        return j == i ? -1 : j;
    }

    /** The index just past the string literal whose opening quote is at {@code i}. */
    static int stringEnd(String s, int i) {
        if (i >= s.length() || s.charAt(i) != '"') {
            return -1;
        }
        int j = i + 1;
        while (j < s.length()) {
            char c = s.charAt(j);
            if (c == '\\') {
                j += 2;
                continue;
            }
            if (c == '"') {
                return j + 1;
            }
            j++;
        }
        return -1;
    }

    private static int containerEnd(String s, int i, char open, char close) {
        int depth = 0;
        int j = i;
        while (j < s.length()) {
            char c = s.charAt(j);
            if (c == '"') {
                int e = stringEnd(s, j);
                if (e < 0) {
                    return -1;
                }
                j = e;
                continue;
            }
            if (c == open) {
                depth++;
            } else if (c == close) {
                depth--;
                if (depth == 0) {
                    return j + 1;
                }
            }
            j++;
        }
        return -1;
    }

    /** The range of the VALUE of {@code key} in the object starting at {@code objStart}. */
    private static Range memberOf(String s, int objStart, String key) {
        int i = skipWs(s, objStart + 1);
        if (i < s.length() && s.charAt(i) == '}') {
            return null;
        }
        while (i < s.length()) {
            if (s.charAt(i) != '"') {
                return null;
            }
            int keyEnd = stringEnd(s, i);
            if (keyEnd < 0) {
                return null;
            }
            String k = decodeString(s, i, keyEnd);
            i = skipWs(s, keyEnd);
            if (i >= s.length() || s.charAt(i) != ':') {
                return null;
            }
            i = skipWs(s, i + 1);
            int valueEnd = skipValue(s, i);
            if (valueEnd < 0) {
                return null;
            }
            if (k.equals(key)) {
                return new Range(i, valueEnd);
            }
            i = skipWs(s, valueEnd);
            if (i >= s.length()) {
                return null;
            }
            char c = s.charAt(i++);
            if (c == '}') {
                return null;
            }
            if (c != ',') {
                return null;
            }
            i = skipWs(s, i);
        }
        return null;
    }

    /** The range of element {@code n} of the array starting at {@code arrStart}. */
    private static Range elementOf(String s, int arrStart, int n) {
        int i = skipWs(s, arrStart + 1);
        if (i < s.length() && s.charAt(i) == ']') {
            return null;
        }
        int at = 0;
        while (i < s.length()) {
            int end = skipValue(s, i);
            if (end < 0) {
                return null;
            }
            if (at == n) {
                return new Range(i, end);
            }
            at++;
            i = skipWs(s, end);
            if (i >= s.length()) {
                return null;
            }
            char c = s.charAt(i++);
            if (c == ']') {
                return null;
            }
            if (c != ',') {
                return null;
            }
            i = skipWs(s, i);
        }
        return null;
    }

    /** Decodes the string literal spanning {@code [quoteStart, afterClosingQuote)}. */
    static String decodeString(String s, int quoteStart, int afterClosingQuote) {
        StringBuilder sb = new StringBuilder(afterClosingQuote - quoteStart);
        for (int i = quoteStart + 1; i < afterClosingQuote - 1; i++) {
            char c = s.charAt(i);
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            i++;
            if (i >= afterClosingQuote - 1) {
                break;
            }
            char e = s.charAt(i);
            switch (e) {
                case 'n':
                    sb.append('\n');
                    break;
                case 't':
                    sb.append('\t');
                    break;
                case 'r':
                    sb.append('\r');
                    break;
                case 'b':
                    sb.append('\b');
                    break;
                case 'f':
                    sb.append('\f');
                    break;
                case 'u':
                    if (i + 4 < afterClosingQuote) {
                        try {
                            sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException ex) {
                            sb.append(e);
                        }
                    }
                    break;
                default:
                    sb.append(e); // covers " and \ and /
            }
        }
        return sb.toString();
    }

    private static int asIndex(String seg) {
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
}
