package com.openguardrails.ogr.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * A mock runtime and a mock provider, both stdlib, so the whole test runs offline with
 * the REAL proxy between them — which is the only way the streamed byte path gets tested
 * as a client actually sees it.
 *
 * <p>⚠️ Both are RECONFIGURABLE rather than built per test, and that is not tidiness.
 * Creating and stopping a listener per test recycles ephemeral ports two dozen times a
 * run, and {@code HttpServer.stop(0)} returns before the socket is gone — so the next
 * listener can land on a port that is still being torn down and the proxy's upstream
 * call fails to connect. It shows up as a 502 on whichever test happened to be next,
 * which reads as a bug in that test and is a bug in this harness. One pair per class,
 * reset between tests.
 */
final class MockServers {

    private MockServers() {}

    /** Answers {@code /v1/evaluate} with canned verdicts, in order, and records every event. */
    static final class Runtime {
        final HttpServer http;
        final List<String> events = Collections.synchronizedList(new ArrayList<String>());
        /**
         * Every evaluate URI, verbatim.
         *
         * <p>⚠️ Recorded so a test can pin that the bridge asks the CANONICAL question and
         * nothing else — {@code /v1/evaluate}, no query string. Everything a verdict asks
         * for is the bridge's own work, so it must keep working against a runtime that
         * implements only what the specification requires.
         */
        final List<String> uris = Collections.synchronizedList(new ArrayList<String>());
        final List<String> verdicts = Collections.synchronizedList(new ArrayList<String>());
        private int at;

        /** Re-arms the canned verdicts and forgets every event seen so far. */
        synchronized void reset(String... verdicts) {
            this.events.clear();
            this.uris.clear();
            this.verdicts.clear();
            Collections.addAll(this.verdicts, verdicts);
            this.at = 0;
        }

        Runtime(String... verdicts) throws IOException {
            Collections.addAll(this.verdicts, verdicts);
            http = HttpServer.create(new InetSocketAddress(0), 0);
            http.createContext("/v1/evaluate", new HttpHandler() {
                @Override
                public void handle(HttpExchange exchange) throws IOException {
                    String body = read(exchange.getRequestBody());
                    events.add(body);
                    uris.add(exchange.getRequestURI().toString());
                    String verdict;
                    synchronized (Runtime.this) {
                        verdict = at < Runtime.this.verdicts.size()
                            ? Runtime.this.verdicts.get(at++)
                            : "{\"event_id\":\"auto\",\"provider\":\"mock\",\"decision\":\"allow\"}";
                    }
                    send(exchange, 200, "application/json", verdict);
                }
            });
            http.createContext("/v1/heartbeat", new HttpHandler() {
                @Override
                public void handle(HttpExchange exchange) throws IOException {
                    send(exchange, 200, "application/json", "{\"ok\":true}");
                }
            });
            http.setExecutor(Executors.newCachedThreadPool());
            http.start();
        }

        String url() {
            return "http://localhost:" + http.getAddress().getPort();
        }

        void stop() {
            http.stop(0);
        }
    }

    /** Answers a completion path with a canned buffered body or a canned SSE stream. */
    static final class Provider {
        final HttpServer http;
        final List<String> received = Collections.synchronizedList(new ArrayList<String>());
        volatile String body;
        volatile boolean sse;
        volatile int status = 200;

        /** Re-arms the canned reply and forgets every request seen so far. */
        void reset(String body, boolean sse) {
            this.received.clear();
            this.body = body;
            this.sse = sse;
            this.status = 200;
        }

        Provider(String body, boolean sse) throws IOException {
            this.body = body;
            this.sse = sse;
            http = HttpServer.create(new InetSocketAddress(0), 0);
            http.createContext("/", new HttpHandler() {
                @Override
                public void handle(HttpExchange exchange) throws IOException {
                    received.add(read(exchange.getRequestBody()));
                    if (Provider.this.sse) {
                        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
                        exchange.sendResponseHeaders(Provider.this.status, 0);
                        OutputStream out = exchange.getResponseBody();
                        // Written in pieces, so the proxy's framing sees split chunks the
                        // way a real network delivers them.
                        byte[] bytes = Provider.this.body.getBytes(StandardCharsets.UTF_8);
                        int chunk = Math.max(1, bytes.length / 5);
                        for (int i = 0; i < bytes.length; i += chunk) {
                            out.write(bytes, i, Math.min(chunk, bytes.length - i));
                            out.flush();
                        }
                        out.close();
                    } else {
                        send(exchange, Provider.this.status, "application/json", Provider.this.body);
                    }
                    exchange.close();
                }
            });
            http.setExecutor(Executors.newCachedThreadPool());
            http.start();
        }

        String url() {
            return "http://localhost:" + http.getAddress().getPort();
        }

        void stop() {
            http.stop(0);
        }
    }

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static void send(HttpExchange exchange, int status, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(status, bytes.length);
        OutputStream out = exchange.getResponseBody();
        out.write(bytes);
        out.close();
    }
}
