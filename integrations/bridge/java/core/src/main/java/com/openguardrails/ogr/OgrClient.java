package com.openguardrails.ogr;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.Executor;

/**
 * The whole protocol, client side: {@code POST /v1/evaluate} and
 * {@code POST /v1/heartbeat}.
 *
 * <p>There is no SDK layer in OGR and this is not one — it is an HTTP call with a
 * bearer token. It is a class only so that the two things a caller must not get wrong
 * live in one place: what counts as "no verdict", and how the transport timings are
 * computed.
 */
public class OgrClient {

    private final OgrConfig config;
    private final HttpClient http;

    public OgrClient(OgrConfig config) {
        this(config, HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build());
    }

    public OgrClient(OgrConfig config, HttpClient http) {
        this.config = config;
        this.http = http;
    }

    /** What one evaluate call produced, including what it says about the path to the runtime. */
    public static final class EvaluateResult {
        /** Never null; {@link Verdict#usable()} is false when no verdict arrived. */
        public final Verdict verdict;
        public final int status;
        public final String error;
        /** The round trip, both directions, with the runtime's own handler time removed. 0 = not measured. */
        public final long netMs;
        /** This proxy's clock MINUS the runtime's, signed. A DIAGNOSTIC — never a correction. */
        public final long skewMs;

        EvaluateResult(Verdict verdict, int status, String error, long netMs, long skewMs) {
            this.verdict = verdict;
            this.status = status;
            this.error = error;
            this.netMs = netMs;
            this.skewMs = skewMs;
        }

        /** Whether a usable verdict came back. False routes the caller into its fail mode. */
        public boolean answered() {
            return verdict.usable();
        }
    }

    /**
     * Judges one event.
     *
     * <p>Never throws: every failure — timeout, 429, 5xx, socket error, a 200 that is
     * not a verdict — comes back as an {@link EvaluateResult} that does not
     * {@link EvaluateResult#answered()}. The caller applies its
     * {@link FailMode}, which is the one decision this class must not make for it.
     */
    public EvaluateResult evaluate(GuardEvent event) {
        String body = event.toJson();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(config.endpoint("/v1/evaluate") + (config.payloadFromRuntime() ? "?payload=true" : "")))
            .timeout(config.timeout())
            .header("content-type", "application/json")
            .header("authorization", "Bearer " + config.apiKey())
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();

        Instant sentAt = Instant.now();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            Instant recvAt = Instant.now();
            if (response.statusCode() != 200) {
                return new EvaluateResult(Verdict.none(), response.statusCode(),
                    "http " + response.statusCode(), 0, 0);
            }
            Verdict v = Verdict.parse(response.body());
            long[] hops = observe(sentAt, recvAt, v);
            return new EvaluateResult(v, 200, v.usable() ? null : "not a verdict", hops[0], hops[1]);
        } catch (IOException e) {
            return new EvaluateResult(Verdict.none(), 0, e.toString(), 0, 0);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new EvaluateResult(Verdict.none(), 0, "interrupted", 0, 0);
        }
    }

    /** Fire and forget — the observe lane, where nothing waits on the answer. */
    public void evaluateAsync(GuardEvent event, Executor executor) {
        final GuardEvent e = event;
        executor.execute(new Runnable() {
            @Override
            public void run() {
                evaluate(e);
            }
        });
    }

    /**
     * What ONE completed evaluate says about the path between this proxy and the
     * runtime.
     *
     * <p>⚠️⚠️ THIS IS AN NTP EXCHANGE AND THE FORMULAS ARE NTP'S. Four instants: this
     * process dispatched at {@code sentAt} and received at {@code recvAt}; the runtime
     * received at {@code t3} and answered at {@code t4}. Neither pair may be subtracted
     * from the other — that is a clock offset wearing a duration's name — but two
     * same-clock differences subtracted give the round-trip wire time with the offset
     * cancelled:
     *
     * <pre>
     *   delay = (recvAt − sentAt) − (t4 − t3)
     *   skew  = ((sentAt − t3) + (recvAt − t4)) / 2
     * </pre>
     *
     * <p>⚠️ {@code skew} is written OURS MINUS THEIRS, which is NTP's offset negated,
     * because that is the direction the field is named in and the direction an operator
     * reads it in: POSITIVE means this proxy's clock is AHEAD of the runtime's.
     *
     * <p>⚠️ {@code delay} does NOT split into outbound and inbound. Halving it assumes a
     * symmetric path, which is an assumption and not a measurement.
     *
     * <p>⚠️ A NEGATIVE delay means the runtime reported spending longer than the whole
     * call took — a broken measurement on one side, never a fast network — and it
     * answers 0 = NOT MEASURED rather than a number somebody would plot.
     */
    static long[] observe(Instant sentAt, Instant recvAt, Verdict v) {
        Instant t3 = v.receivedAt();
        Instant t4 = v.respondedAt();
        if (t3 == null || t4 == null || sentAt == null || recvAt == null) {
            return new long[] {0, 0};
        }
        long roundTrip = Duration.between(sentAt, recvAt).toMillis();
        long handler = Duration.between(t3, t4).toMillis();
        long delay = roundTrip - handler;
        if (delay < 0) {
            return new long[] {0, 0};
        }
        long skew = (Duration.between(t3, sentAt).toMillis() + Duration.between(t4, recvAt).toMillis()) / 2;
        return new long[] {delay, skew};
    }

    /**
     * Integration liveness over the authenticated channel, so the runtime can tell
     * "agent idle" from "integration went dark".
     *
     * <p>A heartbeat is not a GuardEvent and carries no guarded action.
     */
    public boolean heartbeat(Counters counters) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"integration\":");
        com.openguardrails.ogr.json.Json.escape(sb, config.integrationId());
        sb.append(",\"instance_id\":");
        com.openguardrails.ogr.json.Json.escape(sb, config.instanceId());
        sb.append(",\"interval_s\":").append(config.heartbeatInterval().getSeconds());
        String agentId = config.defaultIdentity().agentId;
        if (!agentId.isEmpty()) {
            sb.append(",\"agent_id\":");
            com.openguardrails.ogr.json.Json.escape(sb, agentId);
        }
        sb.append(",\"counters\":").append(counters.toJson());
        sb.append('}');

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(config.endpoint("/v1/heartbeat")))
            .timeout(config.timeout())
            .header("content-type", "application/json")
            .header("authorization", "Bearer " + config.apiKey())
            .POST(HttpRequest.BodyPublishers.ofString(sb.toString(), StandardCharsets.UTF_8))
            .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return response.statusCode() == 200;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}
