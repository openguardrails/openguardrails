package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;
import org.junit.jupiter.api.Test;

import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RawJsonTest {

    @Test
    void locatesAValueByDottedPath() {
        String body = "{\"a\":{\"b\":[1,{\"c\":\"hi\"}]}}";
        assertEquals("\"hi\"", RawJson.locate(body, "a.b.1.c").of(body));
        assertEquals("hi", RawJson.stringAt(body, "a.b.1.c"));
        assertNull(RawJson.locate(body, "a.b.9.c"));
        assertNull(RawJson.stringAt(body, "a.b"));
    }

    @Test
    void bracketPathsFoldToDotted() {
        String body = "{\"messages\":[{\"content\":\"x\"}]}";
        assertEquals("x", RawJson.stringAt(body, "messages[0].content"));
    }

    /**
     * The property the whole rewrite design rests on: everything the edit did not touch
     * is carried through byte for byte, ODD SPACING AND ESCAPES INCLUDED. A body that
     * came back re-serialized would move every offset a later verdict names.
     */
    @Test
    void replacingAStringLeavesEveryOtherByteWhereItWas() {
        String body = "{ \"keep\" : \"a\\u003cb\" ,  \"t\":\"secret\", \"n\": 1.50 }";
        String out = RawJson.replaceStringValue(body, "t", "MASKED");
        assertEquals("{ \"keep\" : \"a\\u003cb\" ,  \"t\":\"MASKED\", \"n\": 1.50 }", out);
    }

    @Test
    void timingIsSplicedByInsertion() {
        String body = "{\"model\":\"m\",\"messages\":[]}";
        String out = RawJson.spliceTopLevel(body, "timing", "{\"received_at\":\"T\"}");
        assertEquals("{\"timing\":{\"received_at\":\"T\"},\"model\":\"m\",\"messages\":[]}", out);
        assertTrue(out.endsWith("\"messages\":[]}"));
        // An existing key is never duplicated — a duplicate is worse than a missing one.
        assertEquals(out, RawJson.spliceTopLevel(out, "timing", "{\"x\":1}"));
        // A degenerate but valid body.
        assertEquals("{\"timing\":1}", RawJson.spliceTopLevel("{}", "timing", "1"));
        // Not an object: untouched.
        assertEquals("[1]", RawJson.spliceTopLevel("[1]", "timing", "1"));
    }

    @Test
    void removesArrayElementsAllOrNothing() {
        String body = "{\"c\":[{\"i\":0},{\"i\":1},{\"i\":2}]}";
        assertEquals("{\"c\":[{\"i\":1}]}",
            RawJson.removeArrayElements(body, "c", Arrays.asList(0, 2)));
        // An index that is not there refuses the whole edit rather than dropping the rest.
        assertNull(RawJson.removeArrayElements(body, "c", Arrays.asList(0, 9)));
        assertEquals(3, RawJson.arrayLength(body, "c"));
    }

    @Test
    void removesAMemberWithoutEatingItsNeighbours() {
        assertEquals("{\"a\":1,\"c\":3}", RawJson.removeMember("{\"a\":1,\"b\":2,\"c\":3}", "", "b"));
        assertEquals("{\"b\":2}", RawJson.removeMember("{\"a\":1,\"b\":2}", "", "a"));
        assertEquals("{\"a\":1}", RawJson.removeMember("{\"a\":1,\"b\":2}", "", "b"));
        assertEquals("{}", RawJson.removeMember("{\"a\":1}", "", "a"));
        // A key with an escaped quote must not confuse the walk.
        assertEquals("{\"x\":1}", RawJson.removeMember("{\"x\":1,\"a\\\"b\":2}", "", "a\"b"));
        // Absent: already the intended state.
        assertEquals("{\"a\":1}", RawJson.removeMember("{\"a\":1}", "", "zzz"));
    }

    @Test
    void putsAndReplacesMembers() {
        assertEquals("{\"n\":true,\"a\":1}", RawJson.putMember("{\"a\":1}", "", "n", "true"));
        assertEquals("{\"a\":2}", RawJson.putMember("{\"a\":1}", "", "a", "2"));
        assertEquals("{\"o\":{\"k\":1,\"x\":0}}",
            RawJson.putMember("{\"o\":{\"x\":0}}", "o", "k", "1"));
    }

    /**
     * ⚠️ Offsets are CODE POINTS. Java strings are UTF-16, so an emoji ahead of a span
     * shifts a naive substring by one position per character — and the result is a
     * masked fragment that matches nothing while the real value goes to the model. BMP
     * text is identical under both counts, which is exactly why this survives every test
     * written in one language.
     */
    @Test
    void spansAreCountedInCodePointsNotUtf16Units() {
        String text = "😀abc";          // one emoji (2 UTF-16 units) then abc
        String[] r = RawJson.replaceRunes(text, 1, 4, "X");
        assertNotNull(r);
        assertEquals("😀X", r[0]);
        assertEquals("abc", r[1]);

        String chinese = "用户邮箱是 a@b.c 谢谢";
        String[] c = RawJson.replaceRunes(chinese, 6, 11, "${OGR_EMAIL_1}");
        assertNotNull(c);
        assertEquals("用户邮箱是 ${OGR_EMAIL_1} 谢谢", c[0]);
        assertEquals("a@b.c", c[1]);
    }

    @Test
    void anOutOfRangeSpanIsRefusedRatherThanClamped() {
        assertNull(RawJson.replaceRunes("abc", 1, 99, "X"));
        assertNull(RawJson.replaceRunes("abc", -1, 2, "X"));
        assertNull(RawJson.replaceRunes("abc", 2, 2, "X"));
    }

    @Test
    void decodesEscapesWhenReadingAString() {
        String body = "{\"t\":\"a\\nb\\u0041\\\"c\"}";
        assertEquals("a\nbA\"c", RawJson.stringAt(body, "t"));
    }

    @Test
    void parsesAndWritesWithoutLosingShape() {
        Object v = Json.parse("{\"a\":[1,2.5,true,null,\"s\"]}");
        assertEquals("{\"a\":[1,2.5,true,null,\"s\"]}", Json.write(v));
        assertNull(Json.parseOrNull("{oops"));
    }
}
