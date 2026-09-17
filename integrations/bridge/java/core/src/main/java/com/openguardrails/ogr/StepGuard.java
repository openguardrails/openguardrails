package com.openguardrails.ogr;

import com.openguardrails.ogr.protocol.Output;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.RequestFacts;
import com.openguardrails.ogr.stream.HeadHold;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ONE proxied model call — the recipe, in order.
 *
 * <pre>
 *   1. mint step_id              a fresh random id; binds this call's two events
 *   2. PRE-MODEL   evaluate(step/request  {…, payload: raw request body + timing.received_at})
 *        block               → do not call the model
 *        modifications.spans → apply in place BEFORE sending
 *        no verdict          → apply the configured fail mode (default: open)
 *   3. call the model
 *   4. POST-MODEL  evaluate(step/response {same step_id, …, payload: complete raw
 *                            response body, stream-reassembled if streamed, + timing})
 *        block               → do not execute tool calls / do not release the withheld remainder
 *        modifications.spans → apply before the content is shown or acted on
 *        no verdict          → apply the configured fail mode
 * </pre>
 *
 * <p>Step 4 is the enforcement moment that matters most: the model's tool calls, held
 * BEFORE execution, are the only copy of an action anyone can still refuse.
 *
 * <p>⚠️ Tool RESULTS need no evaluate of their own — they travel in the next
 * {@code step/request}, which carries the whole conversation, and are judged there.
 *
 * <p>Not thread-safe, and does not need to be: one instance belongs to one model call.
 */
public final class StepGuard {

    private final OgrGuard guard;
    private final OgrConfig config;
    private final String stepId;
    private final Identity identity;
    private final String sessionHint;
    private final String connection;
    private final String llmEndpoint;
    private final String initiator;
    private final Instant receivedAt;

    private Protocol protocol;
    private String model = "";
    private boolean streamRequested;

    /** token → plaintext, learned from the request half's applied spans. */
    private final Map<String, String> placeholders = new LinkedHashMap<String, String>();

    /**
     * The request half's completed evaluate, stamped onto the RESPONSE event.
     *
     * <p>⚠️ A round trip is only known once it ends, so the request half's own event
     * cannot carry it — and the request half is the one in front of the first token,
     * which is why that is the half worth carrying.
     */
    private long netMs;
    private long skewMs;

    /** How long the host had the request before this guard saw it. 0 = not measured. */
    private long hostMs;

    StepGuard(OgrGuard guard, OgrConfig config, String stepId, Identity identity,
              String sessionHint, String connection, String llmEndpoint, String initiator) {
        this.guard = guard;
        this.config = config;
        this.stepId = stepId;
        this.identity = identity;
        this.sessionHint = sessionHint;
        this.connection = connection;
        this.llmEndpoint = llmEndpoint;
        this.initiator = initiator;
        this.receivedAt = Instant.now();
    }

    public String stepId() {
        return stepId;
    }

    public Protocol protocol() {
        return protocol;
    }

    public String model() {
        return model;
    }

    public boolean streamRequested() {
        return streamRequested;
    }

    /** token → plaintext learned so far. The reply's restore reads this. */
    public Map<String, String> placeholders() {
        return placeholders;
    }

    /** Seeds the mapping when the two halves are handled by different processes. */
    public void adoptPlaceholders(Map<String, String> mapping) {
        if (mapping != null) {
            placeholders.putAll(mapping);
        }
    }

    /**
     * Sets the protocol and model for a step whose REQUEST half this process never judged
     * — the out-of-band door's case, where the two halves may land on different replicas.
     *
     * <p>⚠️ The step is still reported under the caller's own {@code step_id}, so the
     * runtime pairs the two halves even though this process only saw one of them. That
     * pairing is the whole reason {@code step_id} is producer-minted.
     */
    public void adoptProtocol(Protocol protocol, String model) {
        this.protocol = protocol;
        this.model = model == null ? "" : model;
    }

    /** How long the host held the request before the guard ran — {@code transport.gw_ms}. */
    public void hostLatency(Duration d) {
        this.hostMs = d == null ? 0 : Math.max(0, d.toMillis());
    }

    // -------------------------------------------------------------- the request

    /**
     * Judges the request half.
     *
     * @param protocol the protocol the CALLER is speaking, from {@code Protocols.detect}
     * @param rawBody  the provider request body, exactly as it is about to be sent
     */
    public RequestOutcome guardRequest(Protocol protocol, String rawBody) {
        this.protocol = protocol;
        Object parsed = com.openguardrails.ogr.json.Json.parseOrNull(rawBody);
        RequestFacts facts = parsed == null
            ? new RequestFacts("", false) : protocol.requestFacts(parsed);
        this.model = facts.model;
        this.streamRequested = facts.stream;

        Instant hookAt = Instant.now();
        String payload = GuardEvent.spliceReceivedAt(rawBody, receivedAt);
        GuardEvent event = event(GuardEvent.STEP_REQUEST, payload, hookAt, false);

        if (!config.mode().enforces()) {
            // OBSERVE: the event is the point, the verdict is not. Dispatched without
            // being waited on, so the model call is not slowed by a decision nobody acts on.
            guard.dispatch(event);
            return new RequestOutcome(RequestOutcome.Act.FORWARD, rawBody, null, false, false,
                "", null, placeholders);
        }

        OgrClient.EvaluateResult result = guard.client().evaluate(event);
        this.netMs = result.netMs;
        this.skewMs = result.skewMs;
        if (!result.answered()) {
            guard.counters().evaluateError();
            return degradedRequest(rawBody);
        }
        guard.counters().event();
        Verdict verdict = result.verdict;

        if (verdict.stops()) {
            guard.counters().refusal();
            return refuseRequest(verdict, rawBody);
        }
        if (verdict.mustRefusePartial(config.failMode())) {
            guard.counters().refusal();
            return new RequestOutcome(RequestOutcome.Act.REFUSE, rawBody,
                refusalDocument(Verdict.REASON), streamRequested, true,
                verdict.eventId(), verdict.unjudged(), placeholders);
        }

        /*
         * The spans are still applied LOCALLY, for what the runtime cannot hand back:
         * the token → plaintext map the streamed reply's per-frame restore needs. What is
         * FORWARDED is the runtime's own rendering when it sent one (`?payload=true`) —
         * one splice, done where the verdict was composed — and the local result when it
         * did not (an older runtime).
         */
        Spans.Result spans = Spans.apply(rawBody, verdict.spans());
        guard.counters().unresolvedSpans(spans.unresolved);
        placeholders.putAll(spans.learned);
        String forward = verdict.hasPayload()
            ? (verdict.payloadUnchanged() ? rawBody : verdict.payloadRaw())
            : spans.body;
        return new RequestOutcome(RequestOutcome.Act.FORWARD, forward, null, false, false,
            verdict.eventId(), verdict.unjudged(), placeholders);
    }

    /**
     * Renders a refused REQUEST — and this is the one site that can let a refused turn
     * CONTINUE.
     *
     * <p>⚠️ The default is unchanged: no directive ⇒ the hard refusal. Every other branch
     * is entered only because the runtime named a shape it decided was honest for this
     * verdict.
     */
    private RequestOutcome refuseRequest(Verdict verdict, String rawBody) {
        Continuation c = verdict.continuation();
        if (verdict.hasPayload() && !verdict.payloadUnchanged()) {
            // The runtime rendered it: a continued request to FORWARD, or the refusal
            // document (SSE text when the caller asked for a stream) to answer with.
            String rendered = verdict.payloadRaw();
            if (c != null && Continuation.WITHHOLD.equals(c.style)) {
                return new RequestOutcome(RequestOutcome.Act.FORWARD, rendered, null, false, false,
                    verdict.eventId(), verdict.unjudged(), placeholders, Continuation.WITHHOLD);
            }
            return new RequestOutcome(RequestOutcome.Act.REFUSE, rawBody, rendered,
                verdict.payloadIsStream(), false, verdict.eventId(), verdict.unjudged(), placeholders);
        }
        if (c == null) {
            return new RequestOutcome(RequestOutcome.Act.REFUSE, rawBody,
                refusalDocument(Verdict.REASON), streamRequested, false,
                verdict.eventId(), verdict.unjudged(), placeholders);
        }
        if (Continuation.WITHHOLD.equals(c.style)) {
            String next = Spans.withhold(rawBody, c.strippedPaths(), c.notice);
            if (next != null) {
                /*
                 * The content the policy refused does not reach the model, and the turn
                 * continues. ⚠️ Nothing here enters the restore map: a withheld tool result
                 * must never come back, and feeding it to the restore would have the
                 * model's own reply rehydrate the very content we removed.
                 */
                return new RequestOutcome(RequestOutcome.Act.FORWARD, next, null, false, false,
                    verdict.eventId(), verdict.unjudged(), placeholders, Continuation.WITHHOLD);
            }
            /*
             * ⚠️ The paths did not resolve, so this is not the body the runtime judged.
             * Forwarding it would deliver the content we were told to remove, so this
             * falls back to the REFUSAL, never to the passthrough.
             */
            return new RequestOutcome(RequestOutcome.Act.REFUSE, rawBody,
                refusalDocument(Verdict.REASON), streamRequested, false,
                verdict.eventId(), verdict.unjudged(), placeholders);
        }
        // `answer`, and anything positional that cannot apply to a request: the notice IS
        // the reply. There is no model turn here to edit.
        String doc = streamRequested
            ? protocol.softRefuseStream(model, c.notice)
            : protocol.softRefuse(model, c.notice);
        return new RequestOutcome(RequestOutcome.Act.REFUSE, rawBody, doc, streamRequested, false,
            verdict.eventId(), verdict.unjudged(), placeholders);
    }

    private RequestOutcome degradedRequest(String rawBody) {
        if (config.failMode().isClosed()) {
            guard.counters().refusal();
            return new RequestOutcome(RequestOutcome.Act.REFUSE, rawBody,
                refusalDocument(Verdict.REASON), streamRequested, true, "", null, placeholders);
        }
        // ⚠️ FAIL OPEN: the step goes through UNJUDGED and is counted. The counter is the
        // only trace — a fail-open is faster and quieter than success.
        guard.counters().uncheckedStep();
        return new RequestOutcome(RequestOutcome.Act.FORWARD, rawBody, null, false, false,
            "", null, placeholders);
    }

    private String refusalDocument(String reason) {
        return streamRequested ? protocol.refuseStream(model, reason) : protocol.refuse(model, reason);
    }

    // ------------------------------------------------------------- the response

    /**
     * Judges a BUFFERED reply.
     *
     * @param rawBody the complete provider response body, verbatim
     */
    public ResponseOutcome guardBufferedResponse(String rawBody, Instant startedAt, Instant completedAt) {
        Instant hookAt = Instant.now();
        if (model.isEmpty()) {
            // A refusal has to be rendered under SOME model name for the caller's SDK to
            // read it, and all three protocols name the model in the reply itself. Only
            // reached when this process never saw the request half.
            model = com.openguardrails.ogr.json.Json.str(
                com.openguardrails.ogr.json.Json.parseOrNull(rawBody), "model");
        }
        String payload = GuardEvent.spliceTiming(rawBody, startedAt, null, completedAt);
        GuardEvent event = event(GuardEvent.STEP_RESPONSE, payload, hookAt, true);

        if (!config.mode().enforces()) {
            guard.dispatch(event);
            return new ResponseOutcome(ResponseOutcome.Act.DELIVER,
                protocol.restore(rawBody, placeholders), null, false, "", null);
        }

        OgrClient.EvaluateResult result = guard.client().evaluate(event);
        if (!result.answered()) {
            guard.counters().evaluateError();
            if (config.failMode().isClosed()) {
                guard.counters().refusal();
                return new ResponseOutcome(ResponseOutcome.Act.REFUSE, rawBody,
                    protocol.refuse(model, Verdict.REASON), true, "", null);
            }
            guard.counters().uncheckedStep();
            return new ResponseOutcome(ResponseOutcome.Act.DELIVER,
                protocol.restore(rawBody, placeholders), null, false, "", null);
        }
        guard.counters().event();
        Verdict verdict = result.verdict;

        if (verdict.stops()) {
            guard.counters().refusal();
            return refusedReply(verdict, rawBody);
        }
        if (verdict.mustRefusePartial(config.failMode())) {
            guard.counters().refusal();
            return new ResponseOutcome(ResponseOutcome.Act.REFUSE, rawBody,
                protocol.refuse(model, Verdict.REASON), true, verdict.eventId(), verdict.unjudged());
        }

        if (verdict.hasPayload()) {
            // The runtime applied the spans and restored the placeholders from its own
            // registry, which is a superset of what this process learned.
            return new ResponseOutcome(ResponseOutcome.Act.DELIVER,
                verdict.payloadUnchanged() ? rawBody : verdict.payloadRaw(), null, false,
                verdict.eventId(), verdict.unjudged());
        }
        Spans.Result spans = Spans.apply(rawBody, verdict.spans());
        guard.counters().unresolvedSpans(spans.unresolved);
        // Spans first, restore second: the offsets index the body AS TRANSPORTED, and a
        // restore lengthens the very strings they point into.
        String delivered = protocol.restore(spans.body, placeholders);
        return new ResponseOutcome(ResponseOutcome.Act.DELIVER, delivered, null, false,
            verdict.eventId(), verdict.unjudged());
    }

    /**
     * Renders a refused buffered REPLY.
     *
     * <p>⚠️ A {@code drop_calls} that cannot resolve every path falls back to refusing the
     * whole reply. A partial drop forwards some refused calls under a notice saying they
     * were refused — the failure mode that is worse than either honest answer, because it
     * looks like it worked.
     */
    private ResponseOutcome refusedReply(Verdict verdict, String rawBody) {
        Continuation c = verdict.continuation();
        if (verdict.hasPayload() && !verdict.payloadUnchanged()) {
            String rendered = verdict.payloadRaw();
            if (c != null && Continuation.DROP_CALLS.equals(c.style)) {
                return new ResponseOutcome(ResponseOutcome.Act.DELIVER, rendered, null, false,
                    verdict.eventId(), verdict.unjudged(), Continuation.DROP_CALLS);
            }
            return new ResponseOutcome(ResponseOutcome.Act.REFUSE, rawBody, rendered, false,
                verdict.eventId(), verdict.unjudged());
        }
        if (c == null) {
            return new ResponseOutcome(ResponseOutcome.Act.REFUSE, rawBody,
                protocol.refuse(model, Verdict.REASON), false, verdict.eventId(), verdict.unjudged());
        }
        if (Continuation.DROP_CALLS.equals(c.style)) {
            String next = protocol.dropCalls(rawBody, c.strippedPaths(), c.notice);
            if (next != null) {
                // The surviving calls still carry placeholders, so this is the one refused
                // path that still owes a restore.
                return new ResponseOutcome(ResponseOutcome.Act.DELIVER,
                    protocol.restore(next, placeholders), null, false,
                    verdict.eventId(), verdict.unjudged(), Continuation.DROP_CALLS);
            }
            return new ResponseOutcome(ResponseOutcome.Act.REFUSE, rawBody,
                protocol.refuse(model, Verdict.REASON), false, verdict.eventId(), verdict.unjudged());
        }
        return new ResponseOutcome(ResponseOutcome.Act.REFUSE, rawBody,
            protocol.softRefuse(model, c.notice), false, verdict.eventId(), verdict.unjudged());
    }

    /**
     * Judges a STREAMED reply — once, whole, at end of stream — and says what to write.
     *
     * <p>There is no single raw body for a stream, so the payload is the canonical shape
     * reassembled from the frames, with transcribed usage and observed timing.
     *
     * <h2>⚠️ What a streamed refusal can and cannot be</h2>
     *
     * With nothing released, a refusal is CLEAN: the caller gets this protocol's refusal
     * frames and never saw the answer. Once content is out it can only be RETRACTED —
     * and whether the retraction may end on a normal stop depends on one fact, whether
     * TOOL-CALL bytes were among what went out. If they were, the client may hold a
     * partial call, and ending normally invites it to run a call with truncated
     * arguments.
     *
     * <p>⚠️ A {@code drop_calls} directive cannot be rendered into a stream whose frames
     * are already written, so it degrades to a retraction — the strict side.
     */
    public StreamOutcome guardStreamedResponse(Output reassembled, HeadHold hold,
                                               Instant startedAt, Instant firstTokenAt,
                                               Instant completedAt, int recognizedFrames) {
        if (reassembled.isEmpty() && recognizedFrames == 0) {
            // ⚠️ Not an empty reply: bytes arrived that no frame of this protocol could be
            // read out of. Distinct states, opposite meanings, and conflating them is how
            // 100% response loss on one upstream stayed invisible.
            guard.counters().unreadableReply();
        }
        Instant hookAt = Instant.now();
        String payload = Canonical.responsePayload(reassembled, model, startedAt, firstTokenAt, completedAt);
        GuardEvent event = event(GuardEvent.STEP_RESPONSE, payload, hookAt, true);

        if (!config.mode().enforces()) {
            guard.dispatch(event);
            return new StreamOutcome(true, hold.releaseAll(), false, "");
        }

        OgrClient.EvaluateResult result = guard.client().evaluate(event);
        if (!result.answered()) {
            guard.counters().evaluateError();
            if (config.failMode().isClosed()) {
                guard.counters().refusal();
                return new StreamOutcome(false, refuseStreamTail(hold, null), true, "");
            }
            guard.counters().uncheckedStep();
            return new StreamOutcome(true, hold.releaseAll(), false, "");
        }
        guard.counters().event();
        Verdict verdict = result.verdict;

        boolean refuse = verdict.stops() || verdict.mustRefusePartial(config.failMode());
        if (!refuse) {
            return new StreamOutcome(true, hold.releaseAll(), false, verdict.eventId());
        }
        guard.counters().refusal();
        Continuation c = verdict.stops() ? verdict.continuation() : null;
        return new StreamOutcome(false, refuseStreamTail(hold, c), false, verdict.eventId());
    }

    private String refuseStreamTail(HeadHold hold, Continuation c) {
        hold.drop();
        if (!hold.releasedAnything()) {
            // Not a frame on the wire: a clean refusal, in this protocol's own frames,
            // opening and closing its own message — what `stream_head_release_bytes: 0`
            // buys on a stream that has not started.
            return c == null
                ? protocol.refuseStream(model, Verdict.REASON)
                : protocol.softRefuseStream(model, c.notice);
        }
        if (!hold.sawRelease()) {
            // Only the provider's opening frames went out (`message_start`,
            // `response.created`, a role delta): the message is open and nothing the caller
            // can read is in it, so the refusal is delivered INSIDE it — a second
            // `message_start` is a protocol error to a strict client.
            return c == null
                ? protocol.retractWithReason(model, Verdict.REASON)
                : protocol.retractSoft(model, c.notice);
        }
        if (c != null && !hold.releasedCalls()) {
            return protocol.retractSoft(model, c.notice);
        }
        return protocol.retract(model);
    }

    // ------------------------------------------------------------------- events

    private GuardEvent event(String kind, String payload, Instant hookAt, boolean carryNet) {
        long pluginMs = Math.max(0, Duration.between(hookAt, Instant.now()).toMillis());
        GuardEvent.Transport transport = new GuardEvent.Transport(
            hostMs, pluginMs, carryNet ? netMs : 0, carryNet ? skewMs : 0);
        return GuardEvent.builder()
            .kind(kind)
            .stepId(stepId)
            .identity(identity)
            .llmProtocol(protocol.name())
            .payloadJson(payload)
            .integration(config.integrationId())
            .connection(connection)
            .sessionHint(sessionHint)
            .initiator(initiator)
            .llmEndpoint(llmEndpoint)
            .transport(transport)
            .build();
    }
}
