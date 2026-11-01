package com.openguardrails.ogr.server;

import com.openguardrails.ogr.Identity;
import com.openguardrails.ogr.OgrGuard;
import com.openguardrails.ogr.StepGuard;
import com.openguardrails.ogr.StreamOutcome;
import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.Protocols;
import com.openguardrails.ogr.stream.StreamGuard;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * THE STREAMED TRANSPORT OF THE MESSAGE DOOR — the same event, its payload arriving as
 * the provider's frames instead of as one JSON document.
 *
 * <pre>
 *   POST /guard/v1/step/response
 *   Content-Type: text/event-stream          ← the switch; the body is the provider's SSE
 *   ogr-step-id: &lt;the request half's&gt;         (required — see below)
 *   ogr-llm-protocol: openai.chat | openai.responses | anthropic.messages   (required)
 *   ogr-agent-id · ogr-agent-type · ogr-agent-workspace · ogr-agent-user    ("" = no assertion)
 *   ogr-session-hint · ogr-connection · ogr-llm-endpoint · ogr-initiator
 *   ogr-head-release-bytes: 32               (0 = release nothing before the verdict)
 *   ogr-placeholders: {"${OGR_EMAIL_1}":"…"} (only when the two halves land on different replicas)
 *
 *   → 200 text/event-stream: the frames to forward to the client, and a last line
 *     : ogr {"decision":"allow","step_id":…,"event_id":…,"llm_protocol":…}
 * </pre>
 *
 * <h2>Why this exists, when a bridge holds one message</h2>
 *
 * A streamed reply IS one message — one {@code step/response}, judged once, whole. What
 * changes is the transport, and the transport is exactly what the JSON envelope cannot
 * carry: there is no single body to put in {@code body}, and by the time there is, the
 * caller has already delivered the answer. So this lane takes the frames as they arrive
 * and gives back the frames to forward, which is the only shape in which a decision at
 * end of stream can still be an ENFORCEMENT rather than a record — the bounded head is
 * released live, everything after it is held, and a block drops what is held.
 *
 * <p>⚠️ The mechanism is {@link StreamGuard}, byte for byte the one the inline lane
 * uses. This class is transport only: headers in, frames through, a trailing verdict
 * line out.
 *
 * <h2>⚠️⚠️ Built on the PLAIN evaluate, and that is the point</h2>
 *
 * Nothing here asks the runtime for anything but the one call the specification
 * requires: the frames are reassembled into the canonical shape and sent as ONE ordinary
 * {@code step/response} GuardEvent, and one ordinary Verdict comes back. Every
 * consequence of that verdict is carried out HERE — the bounded head, the per-frame
 * placeholder restore, the refusal or retraction rendered in the caller's own protocol,
 * the continuation. So this lane works against any runtime that implements
 * {@code POST /v1/evaluate}, at any version, with no optional extension switched on and
 * nothing to negotiate.
 *
 * <p>⚠️ The identity headers are named {@code ogr-*} rather than {@code x-ogr-*}
 * because they are this ENVELOPE's fields carried as headers — the same four the JSON
 * call names in its body — and not the gateway header table of
 * specification/runtime-api.md, whose entries are claims a proxy reads off someone
 * else's request and must strip first. ⚠️ There is no {@code ogr-fail-mode}: the fail
 * mode is the OPERATOR's setting ({@code OGR_FAIL_MODE}), and a caller that could pick
 * fail-open per stream could opt out of the policy by asking.
 *
 * <h2>⚠️ Why `ogr-step-id` is REQUIRED here when the JSON door mints one</h2>
 *
 * The JSON response door can be asked about a reply whose request half nobody judged.
 * This lane cannot usefully be: the placeholders learned by the request half are what a
 * streamed reply needs restored FRAME BY FRAME, and the step id is how they are found —
 * either in this process's {@link StepStore} or, across replicas, by the caller sending
 * them back in {@code ogr-placeholders}. A stream with no step id would deliver
 * {@code ${OGR_EMAIL_1}} to the client and report a response half that pairs with
 * nothing.
 *
 * <p>⚠️ {@code ogr-placeholders} carries the caller's OWN plaintext back to the caller,
 * exactly as the JSON door's {@code placeholders} does — it discloses nothing to anyone
 * else. It is a header rather than a field only because the body is the stream, and a
 * header is likelier to reach an access log: route a step's two halves to one replica
 * where you can, and this stays unused.
 */
final class GuardStreamHandler {

    private final OgrGuard guard;
    private final ProxyServer.Settings settings;
    private final StepStore steps;

    GuardStreamHandler(OgrGuard guard, ProxyServer.Settings settings, StepStore steps) {
        this.guard = guard;
        this.settings = settings;
        this.steps = steps;
    }

    void handle(HttpExchange exchange) throws IOException {
        if (GuardApiHandler.REQUEST_PATH.equals(exchange.getRequestURI().getPath())) {
            // ⚠️ A REQUEST is one body and is judged before anything is sent, so there is
            // nothing to stream and nothing a head budget could bound. Refused rather
            // than quietly buffered: a caller streaming a request has misread the door.
            Http.send(exchange, 400, "application/json",
                "{\"error\":\"invalid_event\",\"detail\":\"the streamed transport carries a"
                    + " step/response only; a request is one body — send it as JSON\"}");
            return;
        }
        String kind = header(exchange, "ogr-kind", GuardApiHandler.RESPONSE_KIND);
        if (!GuardApiHandler.RESPONSE_KIND.equals(kind)) {
            Http.send(exchange, 400, "application/json",
                "{\"error\":\"invalid_event\",\"detail\":\"ogr-kind must be step/response\"}");
            return;
        }
        String stepId = header(exchange, "ogr-step-id", "");
        if (stepId.isEmpty()) {
            Http.send(exchange, 400, "application/json",
                "{\"error\":\"invalid_event\",\"detail\":\"ogr-step-id is required: it is how the"
                    + " request half's placeholder mapping is found\"}");
            return;
        }
        String named = header(exchange, "ogr-llm-protocol", "");
        Protocol protocol = named.isEmpty() ? null : Protocols.byName(named);
        if (protocol == null) {
            // ⚠️ `canonical` lands here too, and must: it names the shape a reassembled
            // reply is REPORTED in, and there is no such thing as a canonical frame.
            Http.send(exchange, 400, "application/json",
                "{\"error\":\"invalid_event\",\"detail\":\"ogr-llm-protocol must name a frame"
                    + " dialect: openai.chat, openai.responses or anthropic.messages\"}");
            return;
        }

        StepGuard step = steps.peek(stepId);
        if (step == null) {
            step = guard.resumeStep(stepId, identity(exchange),
                header(exchange, "ogr-session-hint", ""), header(exchange, "ogr-connection", ""),
                header(exchange, "ogr-llm-endpoint", ""), header(exchange, "ogr-initiator", ""));
        }
        // The frames are what is being decoded, so the header names the dialect even for a
        // remembered step; the model the request half established is kept.
        step.adoptProtocol(protocol, step.model());
        Map<String, String> supplied = placeholders(exchange);
        if (!supplied.isEmpty()) {
            step.adoptPlaceholders(supplied);
        }

        if (verdictOnly(exchange)) {
            recordOnly(exchange, step, protocol, stepId);
        } else {
            guarded(exchange, step, protocol, stepId);
        }
    }

    /**
     * The enforcing lane: the bounded head goes out live, the rest is held, and what the
     * caller forwards to its client is what comes back here.
     */
    private void guarded(HttpExchange exchange, StepGuard step, Protocol protocol, String stepId)
        throws IOException {
        // ⚠️ `started_at` is NOT known here: the provider call was made in the caller's
        // process. The timing this door can honestly report is the stream as it saw it.
        StreamGuard stream = new StreamGuard(step, headBytes(exchange), null);

        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache, no-transform");
        exchange.getResponseHeaders().set("x-ogr-step-id", stepId);
        exchange.sendResponseHeaders(200, 0);
        OutputStream out = exchange.getResponseBody();

        byte[] buffer = new byte[16 * 1024];
        try (InputStream in = exchange.getRequestBody()) {
            int n;
            while ((n = in.read(buffer)) > 0) {
                String release = stream.feed(buffer, n);
                if (!release.isEmpty()) {
                    out.write(release.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
            }
        }
        /*
         * One comment line as the judge starts — not a timer. An SSE comment is ignored by
         * every parser by definition, and it restarts the client's idle timer at the one
         * moment this lane goes quiet: the evaluate round trip, which is bounded by
         * OGR_TIMEOUT_MS and is the whole of the pause.
         */
        out.write(": keepalive\n\n".getBytes(StandardCharsets.UTF_8));
        out.flush();

        String tail = stream.finish();
        StreamOutcome outcome = stream.outcome();
        out.write(tail.getBytes(StandardCharsets.UTF_8));
        out.write(trailer(outcome, stream, protocol, stepId).getBytes(StandardCharsets.UTF_8));
        out.flush();
        out.close();
    }

    /**
     * The RECORD lane ({@code ?verdict_only=true}): the stream is read, reassembled and
     * judged, and the answer is an ordinary JSON verdict.
     *
     * <p>⚠️ No body comes back and none could: the caller relayed its own frames to its
     * client as they arrived, so there is nothing left to rewrite. This lane reports; it
     * does not enforce. It is here because a caller that cannot put this process between
     * itself and its client can still make the model's whole output side visible — the
     * failure a connector that only reported non-streamed replies left behind as a
     * 230:21 request-to-response ratio in the event store.
     */
    private void recordOnly(HttpExchange exchange, StepGuard step, Protocol protocol, String stepId)
        throws IOException {
        // ⚠️ An unbounded head, because nothing is written: a hold would accumulate the
        // whole reply in memory to serve a tail no one will read.
        StreamGuard stream = new StreamGuard(step, Integer.MAX_VALUE, null);
        byte[] buffer = new byte[16 * 1024];
        try (InputStream in = exchange.getRequestBody()) {
            int n;
            while ((n = in.read(buffer)) > 0) {
                stream.feed(buffer, n);
            }
        }
        stream.finish();
        Http.send(exchange, 200, "application/json",
            Json.write(verdictFields(stream.outcome(), stream, protocol, stepId)));
    }

    /**
     * The verdict, on the last line, as an SSE COMMENT.
     *
     * <p>⚠️ A comment because the stream's frames belong to the client's SDK: anything
     * this door needs to say to the SERVICE relaying them has to be invisible to the
     * parser at the other end, and {@code :} is the one line every SSE implementation is
     * required to ignore.
     */
    private String trailer(StreamOutcome outcome, StreamGuard stream, Protocol protocol,
                           String stepId) {
        return ": ogr " + Json.write(verdictFields(outcome, stream, protocol, stepId)) + "\n\n";
    }

    private Map<String, Object> verdictFields(StreamOutcome outcome, StreamGuard stream,
                                              Protocol protocol, String stepId) {
        Map<String, Object> v = Json.obj(
            "decision", outcome.allowed ? "allow" : "block",
            "step_id", stepId,
            "event_id", outcome.eventId,
            "llm_protocol", protocol.name());
        if (outcome.degraded) {
            // ⚠️ Said out loud: a policy block and an outage that read alike leave an
            // operator unable to tell "we are refusing traffic" from "the decision point
            // is down", which are opposite problems with opposite remedies.
            v.put("degraded", Boolean.TRUE);
        }
        if (!outcome.unjudged.isEmpty()) {
            v.put("unjudged", outcome.unjudged);
        }
        if (stream.unreadable()) {
            v.put("unreadable", Boolean.TRUE);
        }
        return v;
    }

    // ------------------------------------------------------------------- headers

    private Identity identity(HttpExchange exchange) {
        return GuardApiHandler.identityOf(
            header(exchange, "ogr-agent-id", ""),
            header(exchange, "ogr-agent-type", ""),
            header(exchange, "ogr-agent-workspace", ""),
            header(exchange, "ogr-agent-user", ""),
            settings.identity);
    }

    /**
     * The token→plaintext map, when the caller carries it itself.
     *
     * <p>⚠️ Unparseable is EMPTY, never an error: the cost of ignoring it is a
     * placeholder reaching the client, and the cost of refusing the stream over it is the
     * whole reply. A caller that sent nonsense here has a bug that its next unrestored
     * reply will show it.
     */
    private Map<String, String> placeholders(HttpExchange exchange) {
        Map<String, String> mapping = new LinkedHashMap<String, String>();
        String raw = header(exchange, "ogr-placeholders", "");
        if (raw.isEmpty()) {
            return mapping;
        }
        Object parsed = Json.parseOrNull(raw);
        if (!(parsed instanceof Map)) {
            return mapping;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> pairs = (Map<String, Object>) parsed;
        for (Map.Entry<String, Object> e : pairs.entrySet()) {
            if (e.getValue() instanceof String) {
                mapping.put(e.getKey(), (String) e.getValue());
            }
        }
        return mapping;
    }

    private int headBytes(HttpExchange exchange) {
        String raw = header(exchange, "ogr-head-release-bytes", "");
        if (raw.isEmpty()) {
            return settings.streamHeadReleaseBytes;
        }
        try {
            return Math.max(0, Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            // ⚠️ The CONFIGURED default, not an unbounded one: a typo must not silently
            // turn the exposure bound off.
            return settings.streamHeadReleaseBytes;
        }
    }

    /**
     * {@code ?verdict_only=true} asks for the verdict ALONE; by default the answer is the
     * guarded frames.
     *
     * <p>⚠️ The guarded frames are the default because they are what this door is FOR —
     * the streamed counterpart of the body the JSON call hands back. The opt-out is
     * spelled for what it does rather than borrowed from the runtime's own
     * {@code ?payload}, which this bridge does not use and must not be confused with.
     */
    private boolean verdictOnly(HttpExchange exchange) {
        String query = exchange.getRequestURI().getRawQuery();
        if (query == null) {
            return false;
        }
        for (String part : query.split("&")) {
            if (part.startsWith("verdict_only=")) {
                String v = part.substring("verdict_only=".length()).toLowerCase(java.util.Locale.ROOT);
                return !("false".equals(v) || "0".equals(v) || "no".equals(v));
            }
        }
        return false;
    }

    private static String header(HttpExchange exchange, String name, String fallback) {
        String v = exchange.getRequestHeaders().getFirst(name);
        return (v == null || v.trim().isEmpty()) ? fallback : v.trim();
    }
}
