package com.openguardrails.ogr;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SpansTest {

    private static final String BODY =
        "{\"messages\":[{\"role\":\"user\",\"content\":\"mail ada@acme.io and bob@acme.io now\"}]}";

    /**
     * ⚠️ Spans on one path are applied HIGHEST OFFSET FIRST, so an earlier splice cannot
     * shift the offsets a later span was computed against. Applied in the given order
     * instead, the second replacement lands a few characters off — and masks text nobody
     * detected while the real value travels on.
     */
    @Test
    void appliesSeveralSpansOnOnePathWithoutShiftingTheOthers() {
        List<Span> spans = Arrays.asList(
            new Span("payload.messages.0.content", 5, 16, "${OGR_EMAIL_1}"),
            new Span("payload.messages.0.content", 21, 32, "${OGR_EMAIL_2}"));
        Spans.Result r = Spans.apply(BODY, spans);
        assertEquals(2, r.applied);
        assertEquals(0, r.unresolved);
        assertEquals("mail ${OGR_EMAIL_1} and ${OGR_EMAIL_2} now",
            com.openguardrails.ogr.json.RawJson.stringAt(r.body, "messages.0.content"));
        assertEquals("ada@acme.io", r.learned.get("${OGR_EMAIL_1}"));
        assertEquals("bob@acme.io", r.learned.get("${OGR_EMAIL_2}"));
    }

    /**
     * ⚠️⚠️ A span that does not resolve is DROPPED and COUNTED, never applied elsewhere.
     * Slicing one span's offsets out of another text masks characters nobody detected
     * while the real value travels on — and both failures look exactly like a healthy
     * proxy. The count is the only thing that says otherwise.
     */
    @Test
    void anUnresolvableSpanIsDroppedAndCounted() {
        Spans.Result r = Spans.apply(BODY, Arrays.asList(
            new Span("payload.messages.9.content", 0, 3, "X"),   // no such message
            new Span("payload.messages.0.role", 0, 99, "X"),     // past the end
            new Span("messages.0.content", 0, 3, "X"),           // not under payload.
            new Span("payload.messages.0.content", 0, 4, "")));  // empty replacement
        assertEquals(0, r.applied);
        assertEquals(4, r.unresolved);
        assertEquals(BODY, r.body);
    }

    @Test
    void stripsThePayloadPrefixAndNothingElse() {
        assertEquals("messages.0.content", Spans.stripPayloadPrefix("payload.messages.0.content"));
        assertEquals("messages.0.content", Spans.stripPayloadPrefix("payload.messages[0].content"));
        assertEquals("", Spans.stripPayloadPrefix("payload"));
        assertEquals("", Spans.stripPayloadPrefix("messages.0.content"));
        assertEquals("", Spans.stripPayloadPrefix(null));
    }

    /**
     * ⚠️⚠️ A withhold is ALL OR NOTHING. A path that does not resolve means this is not the
     * body the runtime judged, and a partial withhold forwards the content we refused.
     */
    @Test
    void withholdIsAllOrNothing() {
        String body = "{\"messages\":[{\"content\":\"tool result A\"},{\"content\":\"tool result B\"}]}";
        String ok = Spans.withhold(body, Arrays.asList("messages.0.content", "messages.1.content"), "[withheld]");
        assertEquals("{\"messages\":[{\"content\":\"[withheld]\"},{\"content\":\"[withheld]\"}]}", ok);

        assertNull(Spans.withhold(body, Arrays.asList("messages.0.content", "messages.9.content"), "x"));
        assertNull(Spans.withhold(body, Collections.<String>emptyList(), "x"));
    }

    @Test
    void restoresTokensBackIntoText() {
        java.util.Map<String, String> map = new java.util.LinkedHashMap<String, String>();
        map.put("${OGR_EMAIL_1}", "ada@acme.io");
        assertEquals("mail ada@acme.io", Spans.restoreInto("mail ${OGR_EMAIL_1}", map));

        String body = "{\"t\":\"say ${OGR_EMAIL_1}\"}";
        assertEquals("{\"t\":\"say ada@acme.io\"}", Spans.restoreAt(body, "t", map));
        assertEquals(body, Spans.restoreAt(body, "nope", map));
    }

    /** A restored value is escaped for the inside of a JSON string when it lands in raw JSON. */
    @Test
    void restoresIntoAToolArgumentObject() {
        java.util.Map<String, String> map = new java.util.LinkedHashMap<String, String>();
        map.put("OGRKR0000001", "a \"quoted\" \\ path\n");
        String body = "{\"input\":{\"cmd\":\"cat OGRKR0000001\"}}";
        String out = Spans.restoreRawAt(body, "input", map);
        assertEquals("cat a \"quoted\" \\ path\n",
            com.openguardrails.ogr.json.RawJson.stringAt(out, "input.cmd"));
        assertTrue(com.openguardrails.ogr.json.Json.valid(out));
    }
}
