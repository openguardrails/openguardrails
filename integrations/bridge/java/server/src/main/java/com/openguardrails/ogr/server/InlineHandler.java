package com.openguardrails.ogr.server;

import com.openguardrails.ogr.Identity;
import com.openguardrails.ogr.OgrGuard;
import com.openguardrails.ogr.RequestOutcome;
import com.openguardrails.ogr.ResponseOutcome;
import com.openguardrails.ogr.StepGuard;
import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.Protocols;
import com.openguardrails.ogr.stream.StreamGuard;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The inline lane: a client points its provider base URL here, and this handler is in the
 * byte path for both halves of every model call.
 *
 * <p>Being in the path is what lets it do the two things an out-of-band integration
 * cannot — carry out redaction spans in full (the runtime returns offsets and never
 * plaintext, so only the process holding the body can apply them) and refuse a request
 * before the model sees it, streaming included.
 */
final class InlineHandler implements HttpHandler {

    private final OgrGuard guard;
    private final ProxyServer.Settings settings;
    private final HttpClient upstream;

    InlineHandler(OgrGuard guard, ProxyServer.Settings settings, HttpClient upstream) {
        this.guard = guard;
        this.settings = settings;
        this.upstream = upstream;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        Instant hostSaw = Instant.now();
        try {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                Http.send(exchange, 405, "application/json", "{\"error\":\"method_not_allowed\"}");
                return;
            }
            String path = exchange.getRequestURI().getPath();
            byte[] body = Http.readAll(exchange.getRequestBody());
            String rawBody = new String(body, StandardCharsets.UTF_8);
            Object parsed = Json.parseOrNull(rawBody);

            Protocol protocol = Protocols.detect(path, parsed);
            if (protocol == null) {
                /*
                 * ⚠️ Not a completion we can read. Proxied UNTOUCHED rather than refused:
                 * a client's /v1/models or /v1/embeddings call is not this guard's
                 * business, and answering 4xx to traffic we merely do not understand
                 * turns a guardrail into an outage.
                 */
                passthrough(exchange, path, body, null);
                return;
            }

            Identity identity = Headers.resolve(new ExchangeLookup(exchange),
                settings.identity, settings.callerFallback);
            StepGuard step = guard.newStep(identity,
                exchange.getRequestHeaders().getFirst("x-ogr-session-hint"),
                connectionId(exchange),
                llmEndpoint(exchange),
                exchange.getRequestHeaders().getFirst("x-ogr-initiator"));
            step.hostLatency(java.time.Duration.between(hostSaw, Instant.now()));

            RequestOutcome request = step.guardRequest(protocol, rawBody);
            if (!request.forwards()) {
                guardedRefusal(exchange, request);
                return;
            }
            passthrough(exchange, path, request.body.getBytes(StandardCharsets.UTF_8), step);
        } catch (IOException e) {
            Http.trySend(exchange, 502, "{\"error\":\"proxy_error\"}");
        } catch (RuntimeException e) {
            Http.trySend(exchange, 500, "{\"error\":\"proxy_error\"}");
        } finally {
            exchange.close();
        }
    }

    /** A refusal is HTTP 200 in the CALLER's own protocol — see {@code Protocol#refuse}. */
    private void guardedRefusal(HttpExchange exchange, RequestOutcome request) throws IOException {
        exchange.getResponseHeaders().add("x-ogr-decision", "block");
        if (!request.eventId.isEmpty()) {
            exchange.getResponseHeaders().add("x-ogr-event-id", request.eventId);
        }
        if (request.degraded) {
            // ⚠️ Said out loud: a policy block and an outage answered identically leaves an
            // operator unable to tell "we are refusing traffic" from "the decision point is
            // down", which are opposite problems with opposite remedies.
            exchange.getResponseHeaders().add("x-ogr-degraded", "true");
        }
        String type = request.refusalIsStream ? "text/event-stream" : "application/json";
        Http.send(exchange, 200, type, request.refusal);
    }

    // ------------------------------------------------------------------ upstream

    private void passthrough(HttpExchange exchange, String path, byte[] body, StepGuard step)
        throws IOException {
        Instant sentAt = Instant.now();
        HttpRequest.Builder out = HttpRequest.newBuilder()
            .uri(URI.create(settings.upstreamFor(path) + path
                + (exchange.getRequestURI().getRawQuery() == null
                    ? "" : "?" + exchange.getRequestURI().getRawQuery())))
            .timeout(settings.upstreamTimeout)
            .POST(HttpRequest.BodyPublishers.ofByteArray(body));
        copyRequestHeaders(exchange, out);

        HttpResponse<InputStream> response;
        try {
            response = upstream.send(out.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Http.send(exchange, 502, "application/json", "{\"error\":\"upstream_unavailable\"}");
            return;
        } catch (IOException e) {
            Http.send(exchange, 502, "application/json", "{\"error\":\"upstream_unavailable\"}");
            return;
        }

        String contentType = header(response, "content-type").toLowerCase(Locale.ROOT);
        boolean sse = contentType.contains("text/event-stream");
        if (step == null || response.statusCode() != 200) {
            // Nothing to judge: an upstream error body is the provider's answer, not the
            // model's, and the caller needs it verbatim to know what happened.
            relayVerbatim(exchange, response);
            return;
        }
        if (sse) {
            streamed(exchange, response, step, sentAt);
        } else {
            buffered(exchange, response, step, sentAt);
        }
    }

    private void buffered(HttpExchange exchange, HttpResponse<InputStream> response,
                          StepGuard step, Instant sentAt) throws IOException {
        byte[] bytes = Http.readAll(response.body());
        String raw = new String(bytes, StandardCharsets.UTF_8);
        ResponseOutcome outcome = step.guardBufferedResponse(raw, sentAt, Instant.now());
        copyResponseHeaders(exchange, response);
        if (!outcome.eventId.isEmpty()) {
            exchange.getResponseHeaders().add("x-ogr-event-id", outcome.eventId);
        }
        if (outcome.delivers()) {
            Http.send(exchange, 200, header(response, "content-type"), outcome.body);
            return;
        }
        exchange.getResponseHeaders().add("x-ogr-decision", "block");
        Http.send(exchange, 200, "application/json", outcome.refusal);
    }

    /**
     * The streaming lane: decode frames, release at most the head budget, hold the rest,
     * judge the reassembled whole once at end of stream.
     *
     * <p>The mechanism is {@link StreamGuard}, shared with the message door's streamed
     * transport — the same four parts in the same order, so the two lanes cannot drift
     * on what a head budget buys or on what a refusal looks like after bytes are gone.
     * What differs here is only the transport: a provider socket in, the client's own
     * connection out, and no trailing verdict line because the recipient is the client's
     * SDK rather than a service that asked us a question.
     */
    private void streamed(HttpExchange exchange, HttpResponse<InputStream> response,
                          StepGuard step, Instant sentAt) throws IOException {
        StreamGuard stream = new StreamGuard(step, settings.streamHeadReleaseBytes, sentAt);

        copyResponseHeaders(exchange, response);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        exchange.sendResponseHeaders(200, 0);
        OutputStream client = exchange.getResponseBody();

        byte[] buffer = new byte[16 * 1024];
        try (InputStream in = response.body()) {
            int n;
            while ((n = in.read(buffer)) > 0) {
                String release = stream.feed(buffer, n);
                if (!release.isEmpty()) {
                    client.write(release.getBytes(StandardCharsets.UTF_8));
                    client.flush();
                }
            }
        }
        client.write(stream.finish().getBytes(StandardCharsets.UTF_8));
        client.flush();
        client.close();
    }

    private void relayVerbatim(HttpExchange exchange, HttpResponse<InputStream> response)
        throws IOException {
        byte[] bytes = Http.readAll(response.body());
        copyResponseHeaders(exchange, response);
        exchange.sendResponseHeaders(response.statusCode(), bytes.length);
        OutputStream out = exchange.getResponseBody();
        out.write(bytes);
        out.close();
    }

    // ------------------------------------------------------------------- headers

    /**
     * ⚠️ The client's OWN provider credential is forwarded untouched — this proxy holds no
     * upstream key. Hop-by-hop headers and anything only this proxy may assert are
     * dropped.
     */
    private void copyRequestHeaders(HttpExchange exchange, HttpRequest.Builder out) {
        for (Map.Entry<String, List<String>> e : exchange.getRequestHeaders().entrySet()) {
            String name = e.getKey().toLowerCase(Locale.ROOT);
            if (Http.isHopByHop(name) || "host".equals(name) || "content-length".equals(name)) {
                continue;
            }
            if (Headers.isGatewayAsserted(name)) {
                continue;
            }
            for (String v : e.getValue()) {
                try {
                    out.header(name, v);
                } catch (IllegalArgumentException ignored) {
                    // The JDK client restricts a few header names; dropping one is better
                    // than failing the whole proxied call over it.
                }
            }
        }
    }

    private void copyResponseHeaders(HttpExchange exchange, HttpResponse<InputStream> response) {
        for (Map.Entry<String, List<String>> e : response.headers().map().entrySet()) {
            String name = e.getKey().toLowerCase(Locale.ROOT);
            if (Http.isHopByHop(name) || "content-length".equals(name) || "content-type".equals(name)) {
                continue;
            }
            for (String v : e.getValue()) {
                exchange.getResponseHeaders().add(e.getKey(), v);
            }
        }
    }

    private static String header(HttpResponse<?> response, String name) {
        return response.headers().firstValue(name).orElse("");
    }

    /**
     * WHERE THE CLIENT DIALLED — the authority it addressed, before this proxy's own
     * routing. That is what the field asks; who finally served the request is a different
     * question and not this one.
     */
    private static String llmEndpoint(HttpExchange exchange) {
        String host = exchange.getRequestHeaders().getFirst("Host");
        return host == null ? "" : host.toLowerCase(Locale.ROOT);
    }

    /**
     * WHICH DOWNSTREAM CONNECTION carried this request.
     *
     * <p>The one session signal a client cannot strip: consecutive requests of one client
     * process ride one keep-alive connection even when the body carries no session field
     * at all. ⚠️ Attribution only — a connection names a PROCESS, which may hold several
     * concurrent conversations.
     */
    private String connectionId(HttpExchange exchange) {
        return guard.config().instanceId() + "#" + exchange.getRemoteAddress();
    }

    private static final class ExchangeLookup implements Headers.Lookup {
        private final HttpExchange exchange;

        ExchangeLookup(HttpExchange exchange) {
            this.exchange = exchange;
        }

        @Override
        public String get(String name) {
            return exchange.getRequestHeaders().getFirst(name);
        }
    }
}
