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
 */
final class MockServers {

    private MockServers() {}

    /** Answers {@code /v1/evaluate} with canned verdicts, in order, and records every event. */
    static final class Runtime {
        final HttpServer http;
        final List<String> events = Collections.synchronizedList(new ArrayList<String>());
        final List<String> verdicts = Collections.synchronizedList(new ArrayList<String>());
        private int at;

        Runtime(String... verdicts) throws IOException {
            Collections.addAll(this.verdicts, verdicts);
            http = HttpServer.create(new InetSocketAddress(0), 0);
            http.createContext("/v1/evaluate", new HttpHandler() {
                @Override
                public void handle(HttpExchange exchange) throws IOException {
                    String body = read(exchange.getRequestBody());
                    events.add(body);
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
