package com.openguardrails.ogr.server;

import com.sun.net.httpserver.HttpExchange;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/** Small HTTP helpers shared by the two doors. */
final class Http {

    /** Headers that describe one hop and must not be relayed to the next. */
    private static final List<String> HOP_BY_HOP = Arrays.asList(
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade");

    private Http() {}

    static boolean isHopByHop(String lowerName) {
        return HOP_BY_HOP.contains(lowerName);
    }

    /**
     * Whether a body is an SSE STREAM rather than a document.
     *
     * <p>The one switch between the message door's two transports, and the same one the
     * runtime's own streamed evaluate uses. Prefix match, because a content type may
     * carry parameters ({@code text/event-stream; charset=utf-8}).
     */
    static boolean isEventStream(String contentType) {
        return contentType != null
            && contentType.trim().toLowerCase(Locale.ROOT).startsWith("text/event-stream");
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    static void send(HttpExchange exchange, int status, String contentType, String body)
        throws IOException {
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        if (contentType != null && !contentType.isEmpty()) {
            exchange.getResponseHeaders().set("Content-Type", contentType);
        }
        // ⚠️ HttpServer reads a length of 0 as "chunked, length unknown" and -1 as "no
        // body at all". Passing 0 for an empty body leaves the caller waiting on a
        // chunked stream that never gets a chunk.
        exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        OutputStream out = exchange.getResponseBody();
        out.write(bytes);
        out.close();
    }

    static void trySend(HttpExchange exchange, int status, String body) {
        try {
            send(exchange, status, "application/json", body);
        } catch (IOException ignored) {
            // The caller is already gone; there is nothing left to tell it.
        }
    }
}
