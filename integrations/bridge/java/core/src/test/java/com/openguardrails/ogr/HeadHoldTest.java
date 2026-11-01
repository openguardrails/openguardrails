package com.openguardrails.ogr;

import com.openguardrails.ogr.protocol.FrameResult;
import com.openguardrails.ogr.stream.HeadHold;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HeadHoldTest {

    private static FrameResult content(String out, int bytes) {
        return new FrameResult(out, bytes, false);
    }

    private static FrameResult call(String out, int bytes) {
        return new FrameResult(out, bytes, true);
    }

    /** Framing is free: a frame carrying no client-visible content goes out at any budget. */
    @Test
    void framingIsFreeEvenAtZero() {
        HeadHold hold = new HeadHold(0);
        assertEquals("open", hold.offer(FrameResult.passthrough("open")));
        assertFalse(hold.sawRelease(), "no CONTENT has been released");
        assertEquals("", hold.offer(content("a", 1)));
        assertEquals(1, hold.heldFrames());
    }

    /**
     * ⚠️ A CEILING, not a floor: a frame that would carry the caller past the bound is
     * held WHOLE. An SSE frame cut in half is not a frame.
     */
    @Test
    void aFrameThatWouldCrossTheBoundIsHeldWhole() {
        HeadHold hold = new HeadHold(10);
        assertEquals("f1", hold.offer(content("f1", 8)));
        assertEquals("", hold.offer(content("f2", 8)), "8+8 > 10, so the whole frame waits");
        assertEquals(8, hold.releasedContentBytes());
        assertTrue(hold.sawRelease());
    }

    /**
     * ⚠️ Once anything is held, everything after it is held too. Releasing a later small
     * frame around a held one delivers the answer OUT OF ORDER, which is worse than
     * delivering it late.
     */
    @Test
    void orderIsPreservedOnceAnythingIsHeld() {
        HeadHold hold = new HeadHold(10);
        hold.offer(content("big", 20));
        assertEquals("", hold.offer(content("tiny", 1)));
        assertEquals("", hold.offer(FrameResult.passthrough("done")));
        assertEquals("bigtinydone", hold.releaseAll());
        assertEquals(0, hold.heldFrames());
    }

    /**
     * ⚠️ This is the one fact that decides whether a refused stream may end on a normal
     * stop: with a partial call in the client's hands, a normal completion invites it to
     * run a call with truncated arguments.
     */
    @Test
    void releasedCallBytesAreRemembered() {
        HeadHold generous = new HeadHold(1000);
        generous.offer(call("c", 5));
        assertTrue(generous.releasedCalls());

        HeadHold tight = new HeadHold(0);
        tight.offer(call("c", 5));
        assertFalse(tight.releasedCalls(), "a HELD call frame was never released");
        assertFalse(tight.sawRelease());
    }

    @Test
    void blockDropsTheHeldRemainder() {
        HeadHold hold = new HeadHold(0);
        hold.offer(content("secret", 6));
        hold.drop();
        assertEquals("", hold.releaseAll());
    }

    /** A name-only tool-call frame is not free framing: held at zero, and counted as released calls otherwise. */
    @Test
    void aCallAnnouncementIsNotFreeFraming() {
        HeadHold zero = new HeadHold(0);
        assertEquals("", zero.offer(new FrameResult("announce", 0, true)));
        assertFalse(zero.sawRelease());
        assertFalse(zero.releasedCalls());
        HeadHold some = new HeadHold(32);
        assertEquals("announce", some.offer(new FrameResult("announce", 0, true)));
        assertTrue(some.sawRelease());
        assertTrue(some.releasedCalls());
    }
}
