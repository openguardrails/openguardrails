package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.protocol.Output;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.Protocols;
import com.openguardrails.ogr.stream.HeadHold;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The recipe, against a runtime that answers whatever the test wants. */
class StepGuardTest {

    private static final String REQUEST =
        "{\"model\":\"gpt-5\",\"messages\":[{\"role\":\"user\",\"content\":\"mail ada@acme.io\"}]}";
    private static final String REPLY =
        "{\"id\":\"c\",\"object\":\"chat.completion\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,"
        + "\"message\":{\"role\":\"assistant\",\"content\":\"done\"},\"finish_reason\":\"stop\"}]}";

    /** A runtime stub: one canned verdict per call, and every event it was sent. */
    private static final class FakeRuntime extends OgrClient {
        final List<GuardEvent> events = new ArrayList<GuardEvent>();
        final List<String> verdicts = new ArrayList<String>();
        int at;

        FakeRuntime(OgrConfig config, String... verdicts) {
            super(config);
            Collections.addAll(this.verdicts, verdicts);
        }

        @Override
        public EvaluateResult evaluate(GuardEvent event) {
            events.add(event);
            if (at >= verdicts.size() || verdicts.get(at) == null) {
                at++;
                return new EvaluateResult(Verdict.none(), 0, "unreachable", 0, 0);
            }
            return new EvaluateResult(Verdict.parse(verdicts.get(at++)), 200, null, 0, 0);
        }
    }

    private static OgrConfig config(Mode mode, FailMode failMode) {
        return OgrConfig.builder()
            .baseUrl("http://runtime.invalid")
            .apiKey("ogr_test")
            .mode(mode)
            .failMode(failMode)
            .build();
    }

    private static StepGuard step(OgrGuard guard) {
        return guard.newStep(new Identity("bot", "onesec", "finance", "u-1"), "sess-1", "conn#1",
            "api.openai.com", "");
    }

    private static Protocol chat() {
        return Protocols.byName("openai.chat");
    }

    // ------------------------------------------------------------ the happy path

    @Test
    void anAllowForwardsTheBodyUnchangedAndSendsBothHalvesUnderOneStepId() {
        FakeRuntime runtime = new FakeRuntime(config(Mode.ENFORCE, FailMode.OPEN),
            "{\"event_id\":\"e1\",\"provider\":\"p\",\"decision\":\"allow\"}",
            "{\"event_id\":\"e2\",\"provider\":\"p\",\"decision\":\"allow\"}");
        OgrGuard guard = new OgrGuard(config(Mode.ENFORCE, FailMode.OPEN), runtime);
        StepGuard step = step(guard);

        RequestOutcome req = step.guardRequest(chat(), REQUEST);
        assertTrue(req.forwards());
        assertEquals(REQUEST, req.body, "an allow with no spans forwards the body byte for byte");

        ResponseOutcome res = step.guardBufferedResponse(REPLY, Instant.now(), Instant.now());
        assertTrue(res.delivers());
        assertEquals(REPLY, res.body);

        assertEquals(2, runtime.events.size());
        assertEquals("step/request", runtime.events.get(0).kind());
        assertEquals("step/response", runtime.events.get(1).kind());
        assertEquals(runtime.events.get(0).stepId(), runtime.events.get(1).stepId(),
            "one step_id binds a call's two halves");
        guard.close();
    }

    /** ⚠️ The payload is the body's own bytes, with only `timing` spliced in by insertion. */
    @Test
    void theRequestPayloadIsTheBodyVerbatimPlusTiming() {
        FakeRuntime runtime = new FakeRuntime(config(Mode.ENFORCE, FailMode.OPEN),
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"allow\"}");
        OgrGuard guard = new OgrGuard(config(Mode.ENFORCE, FailMode.OPEN), runtime);
        step(guard).guardRequest(chat(), REQUEST);

        String payload = runtime.events.get(0).payloadJson();
        assertTrue(payload.endsWith(REQUEST.substring(1)),
            "every original byte is still where it was: " + payload);
        assertTrue(payload.startsWith("{\"timing\":{\"received_at\":"));

        String wire = runtime.events.get(0).toJson();
        Object parsed = Json.parseOrNull(wire);
        assertNotNull(parsed);
        for (String required : new String[] {"kind", "step_id", "agent_id", "agent_type",
            "agent_workspace", "agent_user", "llm_protocol", "payload"}) {
            assertNotNull(Json.get(parsed, required), "required field missing: " + required);
        }
        assertEquals("openai.chat", Json.str(parsed, "llm_protocol"));
        assertEquals("sess-1", Json.str(parsed, "session_hint"));
        assertEquals("conn#1", Json.str(parsed, "connection"));
        assertEquals("api.openai.com", Json.str(parsed, "llm_endpoint"));
        guard.close();
    }

    // ------------------------------------------------------------------ refusals

    @Test
    void aBlockedRequestNeverReachesTheModelAndIsRefusedInTheCallersProtocol() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"block\"}");
        OgrGuard guard = new OgrGuard(cfg, runtime);

        RequestOutcome req = step(guard).guardRequest(chat(), REQUEST);
        assertFalse(req.forwards());
        Output refusal = chat().parseResponse(Json.parseOrNull(req.refusal));
        assertEquals(Verdict.REASON, refusal.text);
        assertEquals("content_filter", Json.str(Json.parseOrNull(req.refusal), "choices.0.finish_reason"));
        assertFalse(req.degraded, "a policy block is not a degraded-mode refusal");
        guard.close();
    }

    /** ⚠️ `allow` with spans is not a contradiction — redaction is not a decision. */
    @Test
    void spansAreAppliedBeforeTheBodyIsSentAndRestoredInTheReply() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"allow\",\"modifications\":{\"spans\":"
            + "[{\"path\":\"payload.messages.0.content\",\"start\":5,\"end\":16,"
            + "\"replacement\":\"${OGR_EMAIL_1}\"}]}}",
            "{\"event_id\":\"e2\",\"provider\":\"p\",\"decision\":\"allow\"}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        StepGuard step = step(guard);

        RequestOutcome req = step.guardRequest(chat(), REQUEST);
        assertTrue(req.forwards());
        assertTrue(req.body.contains("mail ${OGR_EMAIL_1}"));
        assertFalse(req.body.contains("ada@acme.io"), "the value must not reach the model");
        assertEquals("ada@acme.io", req.placeholders.get("${OGR_EMAIL_1}"));

        String echoed = REPLY.replace("done", "sent to ${OGR_EMAIL_1}");
        ResponseOutcome res = step.guardBufferedResponse(echoed, Instant.now(), Instant.now());
        assertTrue(res.body.contains("sent to ada@acme.io"),
            "the caller receives its own data back, not our placeholder");
        guard.close();
    }

    // -------------------------------------------------------------- continuation

    /** ⚠️ `withhold` acts on the REQUEST and the turn CONTINUES — the content does not reach the model. */
    @Test
    void aWithholdDirectiveRewritesTheRequestAndForwardsIt() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"block\",\"continuation\":"
            + "{\"style\":\"withhold\",\"paths\":[\"payload.messages.0.content\"],"
            + "\"notice\":\"[tool result withheld by policy]\"}}");
        OgrGuard guard = new OgrGuard(cfg, runtime);

        RequestOutcome req = step(guard).guardRequest(chat(), REQUEST);
        assertTrue(req.forwards(), "the turn continues");
        assertTrue(req.body.contains("[tool result withheld by policy]"));
        assertFalse(req.body.contains("ada@acme.io"));
        assertTrue(req.placeholders.isEmpty(),
            "a withheld result must NEVER enter the restore map, or the reply would rehydrate it");
        guard.close();
    }

    /** ⚠️ Paths that do not resolve fall back to the REFUSAL, never to the passthrough. */
    @Test
    void anUnresolvableWithholdRefusesRatherThanForwards() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"block\",\"continuation\":"
            + "{\"style\":\"withhold\",\"paths\":[\"payload.messages.9.content\"],\"notice\":\"n\"}}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        assertFalse(step(guard).guardRequest(chat(), REQUEST).forwards());
        guard.close();
    }

    /** ⚠️ An unrecognised style is a directive from a newer runtime — refuse as always. */
    @Test
    void anUnknownContinuationStyleFallsBackToTheHardRefusal() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"block\",\"continuation\":"
            + "{\"style\":\"teleport\",\"notice\":\"n\"}}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        RequestOutcome req = step(guard).guardRequest(chat(), REQUEST);
        assertFalse(req.forwards());
        assertEquals("content_filter", Json.str(Json.parseOrNull(req.refusal), "choices.0.finish_reason"));
        guard.close();
    }

    // --------------------------------------------------------------- degradation

    /** ⚠️ Fail-open: the step goes through UNJUDGED and the counter is the only trace. */
    @Test
    void anUnreachableRuntimeFailsOpenByDefault() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg, (String) null);
        OgrGuard guard = new OgrGuard(cfg, runtime);
        RequestOutcome req = step(guard).guardRequest(chat(), REQUEST);
        assertTrue(req.forwards());
        assertEquals(1, guard.counters().uncheckedValue());
        guard.close();
    }

    @Test
    void failClosedRefusesAndSaysItIsDegraded() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.CLOSED);
        FakeRuntime runtime = new FakeRuntime(cfg, (String) null);
        OgrGuard guard = new OgrGuard(cfg, runtime);
        RequestOutcome req = step(guard).guardRequest(chat(), REQUEST);
        assertFalse(req.forwards());
        assertTrue(req.degraded, "an outage and a policy block must be distinguishable");
        guard.close();
    }

    /**
     * ⚠️⚠️ A 200 is not a verdict. An empty body or an HTML error page from something in
     * front of the runtime parses without error and answers "" to every question, so
     * every "did it stop?" test says no and the traffic goes through as an ALLOW NOBODY
     * MADE.
     */
    @Test
    void aTwoHundredThatIsNotAVerdictIsTreatedAsNoVerdict() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.CLOSED);
        FakeRuntime runtime = new FakeRuntime(cfg, "<html>gateway timeout</html>");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        assertFalse(step(guard).guardRequest(chat(), REQUEST).forwards());
        guard.close();
    }

    /** ⚠️ Fail-closed also refuses a PARTIAL verdict — that is the whole content of the promise. */
    @Test
    void failClosedRefusesAPartialVerdict() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.CLOSED);
        String partial = "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"allow\","
            + "\"unjudged\":[\"payload.messages.0.content\"]}";
        FakeRuntime closed = new FakeRuntime(cfg, partial);
        OgrGuard guardClosed = new OgrGuard(cfg, closed);
        assertFalse(step(guardClosed).guardRequest(chat(), REQUEST).forwards());
        guardClosed.close();

        OgrConfig open = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime opened = new FakeRuntime(open, partial);
        OgrGuard guardOpen = new OgrGuard(open, opened);
        RequestOutcome req = step(guardOpen).guardRequest(chat(), REQUEST);
        assertTrue(req.forwards());
        assertEquals(1, req.unjudged.size(), "carried to the caller either way");
        guardOpen.close();
    }

    // -------------------------------------------------------------------- observe

    /** ⚠️ Observe reports and never enforces — and never waits, so it adds no latency. */
    @Test
    void observeModeNeverRefusesAndNeverRewrites() {
        OgrConfig cfg = config(Mode.OBSERVE, FailMode.CLOSED);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"block\"}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        StepGuard step = step(guard);
        RequestOutcome req = step.guardRequest(chat(), REQUEST);
        assertTrue(req.forwards());
        assertEquals(REQUEST, req.body);
        ResponseOutcome res = step.guardBufferedResponse(REPLY, Instant.now(), Instant.now());
        assertTrue(res.delivers());
        guard.close();
    }

    // -------------------------------------------------------------------- streams

    /**
     * With nothing released, a refused stream is a CLEAN refusal. Once content is out it
     * can only be retracted — and whether it may end on a normal stop turns on one fact:
     * whether TOOL-CALL bytes were among what went out.
     */
    @Test
    void aRefusedStreamIsCleanWhenNothingWasReleased() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"allow\"}",
            "{\"event_id\":\"e2\",\"provider\":\"p\",\"decision\":\"block\"}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        StepGuard step = step(guard);
        step.guardRequest(chat(), "{\"model\":\"gpt-5\",\"messages\":[],\"stream\":true}");

        HeadHold hold = new HeadHold(0);
        hold.offer(new com.openguardrails.ogr.protocol.FrameResult("data: x\n\n", 40, false));
        StreamOutcome out = step.guardStreamedResponse(
            new Output("hello", "", null, null), hold, Instant.now(), Instant.now(), Instant.now(), 3);
        assertFalse(out.allowed);
        assertTrue(out.tail.contains("content_filter"), "a clean refusal in the caller's own frames");
        assertFalse(out.tail.contains("hello"), "the held answer is dropped, never released");
        guard.close();
    }

    @Test
    void anAllowedStreamReleasesEverythingHeld() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"allow\"}",
            "{\"event_id\":\"e2\",\"provider\":\"p\",\"decision\":\"allow\"}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        StepGuard step = step(guard);
        step.guardRequest(chat(), "{\"model\":\"gpt-5\",\"messages\":[],\"stream\":true}");

        HeadHold hold = new HeadHold(0);
        hold.offer(new com.openguardrails.ogr.protocol.FrameResult("data: held\n\n", 4, false));
        StreamOutcome out = step.guardStreamedResponse(
            new Output("held", "", null, null), hold, Instant.now(), Instant.now(), Instant.now(), 2);
        assertTrue(out.allowed);
        assertEquals("data: held\n\n", out.tail);
        guard.close();
    }

    /** The streamed step's payload is the CANONICAL shape — there is no single raw body. */
    @Test
    void aStreamedResponseIsReportedInTheCanonicalShape() {
        OgrConfig cfg = config(Mode.ENFORCE, FailMode.OPEN);
        FakeRuntime runtime = new FakeRuntime(cfg,
            "{\"event_id\":\"e\",\"provider\":\"p\",\"decision\":\"allow\"}",
            "{\"event_id\":\"e2\",\"provider\":\"p\",\"decision\":\"allow\"}");
        OgrGuard guard = new OgrGuard(cfg, runtime);
        StepGuard step = step(guard);
        step.guardRequest(chat(), "{\"model\":\"gpt-5\",\"messages\":[],\"stream\":true}");

        List<com.openguardrails.ogr.protocol.Action> actions =
            new ArrayList<com.openguardrails.ogr.protocol.Action>();
        actions.add(new com.openguardrails.ogr.protocol.Action("call_1", "bash", "{\"cmd\":\"ls\"}"));
        step.guardStreamedResponse(new Output("hi", "thinking", actions, null),
            new HeadHold(0), Instant.now(), Instant.now(), Instant.now(), 5);

        Object payload = Json.parseOrNull(runtime.events.get(1).payloadJson());
        assertEquals("hi", Json.str(payload, "text"));
        assertEquals("thinking", Json.str(payload, "reasoning"));
        assertEquals("bash", Json.str(payload, "tool_calls.0.name"));
        // ⚠️ The argument OBJECT, not a JSON string of it: the runtime reads
        // arguments.cmd, and a string would hand the judge an escaped blob.
        assertEquals("ls", Json.str(payload, "tool_calls.0.arguments.cmd"));
        guard.close();
    }
}
