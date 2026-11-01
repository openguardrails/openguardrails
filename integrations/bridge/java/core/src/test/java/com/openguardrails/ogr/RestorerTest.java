package com.openguardrails.ogr;

import com.openguardrails.ogr.protocol.Restorer;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RestorerTest {

    private static Map<String, String> mapping() {
        Map<String, String> m = new LinkedHashMap<String, String>();
        m.put("${OGR_EMAIL_1}", "ada@acme.io");
        return m;
    }

    /**
     * ⚠️ The whole reason this class exists: a stream delivers a placeholder in pieces, so
     * a naive per-delta replace restores nothing and the placeholder escapes into the
     * customer's application — which then sends it back to us as content on the next turn.
     */
    @Test
    void restoresATokenSplitAcrossDeltas() {
        Restorer r = new Restorer(mapping());
        StringBuilder emitted = new StringBuilder();
        emitted.append(r.feed("mail "));
        emitted.append(r.feed("${OGR_EMA"));
        emitted.append(r.feed("IL_1} now"));
        emitted.append(r.flush());
        assertEquals("mail ada@acme.io now", emitted.toString());
    }

    /** Everything that can no longer become a token is emitted at once; only the tail waits. */
    @Test
    void holdsOnlyWhatCouldStillBecomeAToken() {
        Restorer r = new Restorer(mapping());
        assertEquals("plain text ", r.feed("plain text ${"),
            "the two characters that could still start a token are held, the rest is not");
        assertEquals("${", r.flush());
    }

    /**
     * ⚠️ Whatever is still held at end of stream must be FLUSHED. A restorer that simply
     * stops holding loses the answer's last few characters — the exact loss it exists to
     * prevent, arriving from the other side.
     */
    @Test
    void flushesAnIncompleteTokenAsItself() {
        Restorer r = new Restorer(mapping());
        assertEquals("", r.feed("${OGR_EMA"));
        assertEquals("${OGR_EMA", r.flush());
        assertEquals("", r.flush());
    }

    @Test
    void anEmptyMappingIsAPassthrough() {
        Restorer r = new Restorer(Collections.<String, String>emptyMap());
        assertTrue(r.idle());
        assertEquals("anything ${OGR_EMA", r.feed("anything ${OGR_EMA"));
        assertEquals("", r.flush());
    }
}
