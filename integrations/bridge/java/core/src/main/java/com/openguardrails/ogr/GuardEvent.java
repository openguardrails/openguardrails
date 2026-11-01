package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;

import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One GuardEvent — the only unit on the OGR wire.
 *
 * <p>A proxied model call is one STEP, reported as TWO events bound by one
 * {@code step_id}:
 *
 * <pre>
 *   step/request    the provider request body, untouched, before the model sees it
 *   step/response   the provider response body (or the canonical shape reassembled
 *                   from an SSE stream), before the caller acts on it
 * </pre>
 *
 * <h2>Eight required fields, three optional, and nothing else</h2>
 *
 * The schema is {@code additionalProperties: false}, so an unknown key is a 400 — and
 * that strictness is what lets the two ends roll forward independently: an ADDITIVE
 * OPTIONAL key keeps every proxy in the field validating, while a required one would
 * have 400'd the entire installed base. The four identity fields are required WITH the
 * empty string as the explicit "no assertion"; omitting one is a schema violation, not
 * a shorter event.
 *
 * <h2>⚠️⚠️ The payload is the body's own bytes</h2>
 *
 * {@code payload} carries the provider body VERBATIM. A verdict's span offsets index
 * the payload as transported, so parsing and re-encoding it — which reorders keys and
 * re-escapes strings — would put every offset into different characters than the
 * runtime counted. The one permitted edit is inserting a top-level {@code timing} key
 * by byte insertion right after the opening brace, which leaves every original
 * character where it was ({@link RawJson#spliceTopLevel}).
 *
 * <p>This proxy declares NO other coordinates. It sees one stateless call at a time;
 * session, turn and step numbering are the runtime's to derive, and pretending
 * otherwise is how two implementations of one algorithm drift apart.
 */
public final class GuardEvent {

    public static final String STEP_REQUEST = "step/request";
    public static final String STEP_RESPONSE = "step/response";

    private final String kind;
    private final String stepId;
    private final Identity identity;
    private final String llmProtocol;
    private final String payloadJson;
    private final String integration;
    private final String connection;
    private final String sessionHint;
    private final String initiator;
    private final String llmEndpoint;
    private final Transport transport;

    private GuardEvent(Builder b) {
        this.kind = b.kind;
        this.stepId = b.stepId;
        this.identity = b.identity == null ? Identity.NONE : b.identity;
        this.llmProtocol = b.llmProtocol;
        this.payloadJson = b.payloadJson;
        this.integration = b.integration;
        this.connection = b.connection;
        this.sessionHint = b.sessionHint;
        this.initiator = b.initiator;
        this.llmEndpoint = b.llmEndpoint;
        this.transport = b.transport;
    }

    public String kind() {
        return kind;
    }

    public String stepId() {
        return stepId;
    }

    public String payloadJson() {
        return payloadJson;
    }

    /**
     * The event as it goes on the wire.
     *
     * <p>Assembled by hand rather than by a mapper, for one reason that has bitten
     * before: {@code payload} must be written RAW. Every other value goes through
     * {@link Json#escape}, so no field this proxy reads off a header can inject into
     * the document.
     */
    public String toJson() {
        StringBuilder sb = new StringBuilder(payloadJson.length() + 512);
        sb.append('{');
        field(sb, "kind", kind, true);
        field(sb, "step_id", stepId, false);
        // ⚠️ No omit-if-empty on the four: "" is itself the assertion.
        field(sb, "agent_id", identity.agentId, false);
        field(sb, "agent_type", identity.agentType, false);
        field(sb, "agent_workspace", identity.agentWorkspace, false);
        field(sb, "agent_user", identity.agentUser, false);
        field(sb, "llm_protocol", llmProtocol, false);
        sb.append(",\"payload\":").append(payloadJson.isEmpty() ? "{}" : payloadJson);
        optional(sb, "integration", integration);
        optional(sb, "connection", connection);
        optional(sb, "session_hint", sessionHint);
        optional(sb, "initiator", initiator);
        optional(sb, "llm_endpoint", llmEndpoint);
        if (transport != null) {
            String t = transport.toJson();
            if (t != null) {
                sb.append(",\"transport\":").append(t);
            }
        }
        sb.append('}');
        return sb.toString();
    }

    private static void field(StringBuilder sb, String key, String value, boolean first) {
        if (!first) {
            sb.append(',');
        }
        Json.escape(sb, key);
        sb.append(':');
        Json.escape(sb, value == null ? "" : value);
    }

    private static void optional(StringBuilder sb, String key, String value) {
        if (value == null || value.isEmpty()) {
            return;
        }
        sb.append(',');
        Json.escape(sb, key);
        sb.append(':');
        Json.escape(sb, value);
    }

    public static Builder builder() {
        return new Builder();
    }

    // ------------------------------------------------------------------ timing

    private static final DateTimeFormatter RFC3339 = DateTimeFormatter.ISO_INSTANT;

    /**
     * Splices the one wall-clock fact a REQUEST half can honestly carry —
     * {@code timing.received_at}, when this proxy saw the request.
     *
     * <p>⚠️ This is NOT the event's timestamp, and the wire deliberately has no such
     * field. It is one END of a duration whose other end — the PREVIOUS step's
     * {@code timing.completed_at} — the same process stamped, so the pair measures the
     * agent's tool-execution gap with the clock skew cancelled out. A runtime that
     * ORDERED events by it would be ordering by a clock it cannot audit, which is why
     * it must not.
     */
    public static String spliceReceivedAt(String payloadJson, Instant receivedAt) {
        Map<String, Object> t = new LinkedHashMap<String, Object>();
        t.put("received_at", RFC3339.format(receivedAt));
        return RawJson.spliceTopLevel(payloadJson, "timing", Json.write(t));
    }

    /** Splices the observed timing of a completed reply into a buffered response body. */
    public static String spliceTiming(String payloadJson, Instant startedAt, Instant firstTokenAt, Instant completedAt) {
        Map<String, Object> t = new LinkedHashMap<String, Object>();
        if (startedAt != null) {
            t.put("started_at", RFC3339.format(startedAt));
        }
        if (firstTokenAt != null) {
            t.put("first_token_at", RFC3339.format(firstTokenAt));
        }
        if (completedAt != null) {
            t.put("completed_at", RFC3339.format(completedAt));
        }
        if (t.isEmpty()) {
            return payloadJson;
        }
        return RawJson.spliceTopLevel(payloadJson, "timing", Json.write(t));
    }

    public static Map<String, Object> timingMap(Instant startedAt, Instant firstTokenAt, Instant completedAt) {
        Map<String, Object> t = new LinkedHashMap<String, Object>();
        if (startedAt != null) {
            t.put("started_at", RFC3339.format(startedAt));
        }
        if (firstTokenAt != null) {
            t.put("first_token_at", RFC3339.format(firstTokenAt));
        }
        if (completedAt != null) {
            t.put("completed_at", RFC3339.format(completedAt));
        }
        return t;
    }

    // --------------------------------------------------------------- transport

    /**
     * Where the time went on the way to a verdict (OGR 1.8) — so a first-token
     * regression is attributable to a LAYER instead of argued about.
     *
     * <p>⚠️⚠️ EVERY VALUE IS A DURATION MEASURED INSIDE ONE CLOCK. The obvious build —
     * stamp timestamps at both ends and subtract the neighbours — produces a number
     * spanning two machines' clocks, and it is not a small error: this platform once
     * read a steady 2.1 SECONDS of fiction that way, on 2,997 of 3,000 events, from a
     * lab box whose clock matched its host to under a second.
     *
     * <p>{@code netMs} is the exception that proves the rule: it is the round trip THIS
     * process timed minus the handler duration the runtime reported for the same call —
     * two same-clock differences subtracted, which is the NTP delay formula and needs
     * no synchronised clocks. ⚠️ It does not split into outbound and inbound, and
     * halving it would be an assumption wearing a measurement's name.
     *
     * <p>⚠️ An unmeasured hop is an ABSENT key, never 0. A zero that means "instant"
     * and a zero that means "not measured" must not be the same bytes.
     */
    public static final class Transport {
        public final long gwMs;
        public final long pluginMs;
        public final long netMs;
        public final long skewMs;

        public Transport(long gwMs, long pluginMs, long netMs, long skewMs) {
            this.gwMs = gwMs;
            this.pluginMs = pluginMs;
            this.netMs = netMs;
            this.skewMs = skewMs;
        }

        /** {@code null} when nothing was measured — an absent object, never one full of zeros. */
        public String toJson() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            if (gwMs > 0) {
                m.put("gw_ms", Long.valueOf(gwMs));
            }
            if (pluginMs > 0) {
                m.put("plugin_ms", Long.valueOf(pluginMs));
            }
            if (netMs > 0) {
                m.put("net_ms", Long.valueOf(netMs));
            }
            if (skewMs != 0) {
                m.put("skew_ms", Long.valueOf(skewMs));
            }
            return m.isEmpty() ? null : Json.write(m);
        }
    }

    // ----------------------------------------------------------------- builder

    public static final class Builder {
        private String kind = STEP_REQUEST;
        private String stepId = "";
        private Identity identity = Identity.NONE;
        private String llmProtocol = "";
        private String payloadJson = "{}";
        private String integration;
        private String connection;
        private String sessionHint;
        private String initiator;
        private String llmEndpoint;
        private Transport transport;

        public Builder kind(String v) {
            this.kind = v;
            return this;
        }

        public Builder stepId(String v) {
            this.stepId = v;
            return this;
        }

        public Builder identity(Identity v) {
            this.identity = v;
            return this;
        }

        public Builder llmProtocol(String v) {
            this.llmProtocol = v;
            return this;
        }

        public Builder payloadJson(String v) {
            this.payloadJson = (v == null || v.isEmpty()) ? "{}" : v;
            return this;
        }

        public Builder integration(String v) {
            this.integration = v;
            return this;
        }

        public Builder connection(String v) {
            this.connection = v;
            return this;
        }

        public Builder sessionHint(String v) {
            this.sessionHint = v;
            return this;
        }

        /**
         * WHO STARTED the work this step belongs to: {@code scheduled} or
         * {@code spawned}, and ABSENT in every other case.
         *
         * <p>⚠️ There is deliberately no {@code human} value — nothing can prove a
         * person is there, so a runtime would have to ignore it. ⚠️ A proxy never emits
         * {@code spawned}: it sees one request, not the session tree that would say who
         * spawned whom.
         */
        public Builder initiator(String v) {
            this.initiator = "scheduled".equals(v) ? v : null;
            return this;
        }

        public Builder llmEndpoint(String v) {
            this.llmEndpoint = v;
            return this;
        }

        public Builder transport(Transport v) {
            this.transport = v;
            return this;
        }

        public GuardEvent build() {
            return new GuardEvent(this);
        }
    }
}
