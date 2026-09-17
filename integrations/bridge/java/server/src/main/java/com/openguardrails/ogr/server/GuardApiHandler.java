package com.openguardrails.ogr.server;

import com.openguardrails.ogr.Identity;
import com.openguardrails.ogr.OgrGuard;
import com.openguardrails.ogr.RequestOutcome;
import com.openguardrails.ogr.ResponseOutcome;
import com.openguardrails.ogr.StepGuard;
import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.Protocols;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The OUT-OF-BAND lane: a proxy that already holds both bodies asks for a decision
 * instead of putting this code in its byte path.
 *
 * <h2>The answer: three decisions, and the body's meaning follows the decision</h2>
 *
 * The same contract AIRS's built-in LLM door ({@code POST /v1/step/request},
 * {@code POST /v1/step/response}) answers with, so a caller can move between the two
 * without changing a line:
 *
 * <pre>
 *   POST /guard/v1/step/request    {llm_protocol?, path?, agent_id?, …, body: &lt;raw provider request&gt;}
 *     → {"decision":"allow",    "step_id":…, "body":"unchanged"}
 *     → {"decision":"redacted", "step_id":…, "body":&lt;the request with spans applied — FORWARD THIS&gt;, "placeholders":{…}}
 *     → {"decision":"block",    "step_id":…, "body":&lt;a refusal in the caller's own protocol&gt;, "refusal_is_stream"?:true}
 *     → {"decision":"block",    "step_id":…, "continuation":"withhold", "body":&lt;the request to forward&gt;}
 *
 *   POST /guard/v1/step/response   {step_id:…, placeholders?:{…}, body: &lt;raw provider reply&gt;}
 *     → {"decision":"allow",    "body":"unchanged"}
 *     → {"decision":"redacted", "body":&lt;the reply with placeholders restored — DELIVER THIS&gt;}
 *     → {"decision":"block",    "body":&lt;a refusal&gt;}
 *     → {"decision":"block",    "continuation":"drop_calls", "body":&lt;the reply to deliver&gt;}
 * </pre>
 *
 * <ul>
 *   <li><b>{@code allow}</b> — nothing about the body changed. {@code body} is the literal
 *       string {@code "unchanged"}: the caller forwards (or delivers) its OWN copy, and no
 *       bytes are echoed back. On enforce this is what keeps the door from doubling every
 *       request's size.
 *   <li><b>{@code redacted}</b> — the body was REWRITTEN and the caller must use the returned
 *       one, never its own copy: a request with the verdict's spans applied, or a reply
 *       with the placeholders put back. A copy forwarded instead is a body the runtime
 *       believes was masked and was not.
 *   <li><b>{@code block}</b> — the FULL content the caller needs, which depends on the case.
 *       With no {@code continuation}: a refusal document, in the caller's own protocol —
 *       answer the client with it, do not call the model / do not act on the reply's tool
 *       calls ({@code refusal_is_stream} says it is SSE text for a caller that asked for a
 *       stream). With {@code continuation}: a CONTINUED body — {@code withhold} on the
 *       request half (forward it; the refused content is replaced by the notice),
 *       {@code drop_calls} on the response half (deliver it; the refused calls are gone
 *       and the survivors may run). ⚠️ A continuation changes no enforcement: the decision
 *       is still a block, which is why a continued body rides {@code block} and never
 *       {@code redacted}.
 * </ul>
 *
 * <h2>What this lane gives up, said plainly</h2>
 *
 * <ul>
 *   <li><b>Streaming is the caller's problem.</b> There is no held head here, so a
 *       streamed answer is either buffered by the caller before it asks, or judged after
 *       the client has already seen it — a record, not a control. The inline lane exists
 *       for the other case.
 *   <li><b>The mapping has to travel.</b> The token→plaintext map from the request half
 *       is returned as {@code placeholders} and accepted back on the response call, so a
 *       caller that load-balances the two halves across replicas needs nothing from this
 *       process's memory. A caller that omits it relies on {@link StepStore}, which is
 *       per process. (AIRS's built-in door remembers it server-side instead.)
 * </ul>
 *
 * <h2>⚠️ The raw body, whichever way it arrives</h2>
 *
 * {@code body} may be the provider body INLINE (a JSON object) or a STRING containing it.
 * The inline form is taken as its raw character range out of this request, never
 * re-serialized — a body round-tripped through any JSON writer has its keys reordered and
 * its strings re-escaped, and every verdict offset would then index characters the runtime
 * never counted.
 */
final class GuardApiHandler implements HttpHandler {

    static final String REQUEST_PATH = "/guard/v1/step/request";
    static final String RESPONSE_PATH = "/guard/v1/step/response";

    /** What {@code body} says on an allow: the caller's own copy is the body. */
    static final String UNCHANGED = "unchanged";

    /**
     * The three-way decision. A continued body is a BLOCK the caller carries out, never a
     * redaction; a body that came back byte-identical is an allow; anything else rewritten
     * is a redaction the caller must forward instead of its own copy.
     */
    static String decisionOf(boolean proceeds, String continuation, boolean changed) {
        if (!proceeds || continuation != null) {
            return "block";
        }
        return changed ? "redacted" : "allow";
    }

    private final OgrGuard guard;
    private final ProxyServer.Settings settings;
    private final StepStore steps;

    GuardApiHandler(OgrGuard guard, ProxyServer.Settings settings, StepStore steps) {
        this.guard = guard;
        this.settings = settings;
        this.steps = steps;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        try {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                Http.send(exchange, 405, "application/json", "{\"error\":\"method_not_allowed\"}");
                return;
            }
            String envelope = new String(Http.readAll(exchange.getRequestBody()), StandardCharsets.UTF_8);
            Object parsed = Json.parseOrNull(envelope);
            if (parsed == null) {
                Http.send(exchange, 400, "application/json", "{\"error\":\"invalid_body\"}");
                return;
            }
            String rawBody = bodyOf(envelope, parsed);
            if (rawBody == null) {
                Http.send(exchange, 400, "application/json",
                    "{\"error\":\"invalid_body\",\"detail\":\"'body' must be the provider body, inline or as a string\"}");
                return;
            }
            if (REQUEST_PATH.equals(exchange.getRequestURI().getPath())) {
                requestHalf(exchange, parsed, rawBody);
            } else {
                responseHalf(exchange, parsed, rawBody);
            }
        } catch (RuntimeException e) {
            Http.trySend(exchange, 500, "{\"error\":\"guard_error\"}");
        } finally {
            exchange.close();
        }
    }

    private void requestHalf(HttpExchange exchange, Object envelope, String rawBody) throws IOException {
        Protocol protocol = resolveProtocol(envelope, rawBody);
        if (protocol == null) {
            Http.send(exchange, 400, "application/json",
                "{\"error\":\"unknown_protocol\",\"detail\":\"send llm_protocol, or a body this proxy can recognise\"}");
            return;
        }
        StepGuard step = guard.resumeStep(
            Json.str(envelope, "step_id"),
            identity(envelope),
            Json.str(envelope, "session_hint"),
            Json.str(envelope, "connection"),
            Json.str(envelope, "llm_endpoint"),
            Json.str(envelope, "initiator"));

        RequestOutcome outcome = step.guardRequest(protocol, rawBody);
        steps.put(step.stepId(), step);

        Map<String, Object> answer = Json.obj(
            "decision", decisionOf(outcome.forwards(), outcome.continuation, !rawBody.equals(outcome.body)),
            "step_id", step.stepId(),
            "llm_protocol", protocol.name(),
            "event_id", outcome.eventId);
        if (!outcome.forwards()) {
            // The refusal, whole: one JSON document, or SSE text for a caller that asked
            // for a stream — which is not JSON and must not be spliced in as if it were.
            answer.put("body", outcome.refusalIsStream ? outcome.refusal : Json.raw(outcome.refusal));
            if (outcome.refusalIsStream) {
                answer.put("refusal_is_stream", Boolean.TRUE);
            }
        } else if (outcome.continuation != null) {
            answer.put("continuation", outcome.continuation);
            answer.put("body", Json.raw(outcome.body));
        } else if (!rawBody.equals(outcome.body)) {
            answer.put("body", Json.raw(outcome.body));
        } else {
            answer.put("body", UNCHANGED);
        }
        if (outcome.degraded) {
            answer.put("degraded", Boolean.TRUE);
        }
        if (!outcome.unjudged.isEmpty()) {
            answer.put("unjudged", outcome.unjudged);
        }
        if (!outcome.placeholders.isEmpty()) {
            /*
             * ⚠️ Returned in the CLEAR, and that discloses nothing new: the caller is the
             * proxy that just handed us this very plaintext. Withholding it would protect
             * nothing from the only party reading it, and would make a stateless
             * deployment impossible — see the class comment.
             */
            answer.put("placeholders", new LinkedHashMap<String, Object>(outcome.placeholders));
        }
        Http.send(exchange, 200, "application/json", Json.write(answer));
    }

    private void responseHalf(HttpExchange exchange, Object envelope, String rawBody) throws IOException {
        String stepId = Json.str(envelope, "step_id");
        StepGuard step = stepId.isEmpty() ? null : steps.peek(stepId);
        if (step == null) {
            /*
             * No remembered step: either the two halves landed on different processes, or
             * the request half was never judged. Either way the response half is still
             * worth judging on its own — losing the pairing costs the placeholder
             * mapping, which the caller may supply, and nothing else.
             */
            Protocol protocol = resolveProtocol(envelope, rawBody);
            if (protocol == null) {
                Http.send(exchange, 400, "application/json", "{\"error\":\"unknown_protocol\"}");
                return;
            }
            step = guard.resumeStep(stepId, identity(envelope),
                Json.str(envelope, "session_hint"), Json.str(envelope, "connection"),
                Json.str(envelope, "llm_endpoint"), Json.str(envelope, "initiator"));
            // The response half needs the protocol and the model name, which the request
            // half would have established; a response body carries the model itself.
            step.adoptProtocol(protocol, Json.str(envelope, "model"));
        }
        Map<String, Object> supplied = Json.getMap(envelope, "placeholders");
        if (supplied != null) {
            Map<String, String> mapping = new LinkedHashMap<String, String>();
            for (Map.Entry<String, Object> e : supplied.entrySet()) {
                if (e.getValue() instanceof String) {
                    mapping.put(e.getKey(), (String) e.getValue());
                }
            }
            step.adoptPlaceholders(mapping);
        }

        ResponseOutcome outcome = step.guardBufferedResponse(rawBody, Instant.now(), Instant.now());
        Map<String, Object> answer = Json.obj(
            "decision", decisionOf(outcome.delivers(), outcome.continuation, !rawBody.equals(outcome.body)),
            "step_id", step.stepId(),
            "event_id", outcome.eventId);
        if (!outcome.delivers()) {
            answer.put("body", Json.raw(outcome.refusal));
        } else if (outcome.continuation != null) {
            answer.put("continuation", outcome.continuation);
            answer.put("body", Json.raw(outcome.body));
        } else if (!rawBody.equals(outcome.body)) {
            answer.put("body", Json.raw(outcome.body));
        } else {
            answer.put("body", UNCHANGED);
        }
        if (outcome.degraded) {
            answer.put("degraded", Boolean.TRUE);
        }
        if (!outcome.unjudged.isEmpty()) {
            answer.put("unjudged", outcome.unjudged);
        }
        Http.send(exchange, 200, "application/json", Json.write(answer));
    }

    /**
     * The provider body, VERBATIM.
     *
     * <p>An inline object is sliced out of the envelope by character range, so the bytes
     * the caller sent are the bytes we judge and the bytes a span's offsets index.
     */
    static String bodyOf(String envelope, Object parsed) {
        Object value = Json.get(parsed, "body");
        if (value instanceof String) {
            return (String) value;
        }
        RawJson.Range r = RawJson.locate(envelope, "body");
        if (r == null) {
            return null;
        }
        return r.of(envelope);
    }

    private Protocol resolveProtocol(Object envelope, String rawBody) {
        String named = Json.str(envelope, "llm_protocol");
        if (!named.isEmpty()) {
            return Protocols.byName(named);
        }
        return Protocols.detect(Json.str(envelope, "path"), Json.parseOrNull(rawBody));
    }

    private Identity identity(Object envelope) {
        String id = Json.str(envelope, "agent_id");
        String type = Json.str(envelope, "agent_type");
        String workspace = Json.str(envelope, "agent_workspace");
        String user = Json.str(envelope, "agent_user");
        if (id.isEmpty() && type.isEmpty() && workspace.isEmpty() && user.isEmpty()) {
            return settings.identity;
        }
        return new Identity(
            id.isEmpty() ? settings.identity.agentId : id,
            type.isEmpty() ? settings.identity.agentType : type,
            workspace.isEmpty() ? settings.identity.agentWorkspace : workspace,
            user);
    }
}
