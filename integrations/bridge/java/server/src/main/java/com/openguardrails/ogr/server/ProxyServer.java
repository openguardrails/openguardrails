package com.openguardrails.ogr.server;

import com.openguardrails.ogr.FailMode;
import com.openguardrails.ogr.Identity;
import com.openguardrails.ogr.Mode;
import com.openguardrails.ogr.OgrConfig;
import com.openguardrails.ogr.OgrGuard;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.Executors;

/**
 * A runnable LLM proxy with the complete OGR integration wrapped around both directions.
 *
 * <pre>
 *    client ──HTTP──▶ ProxyServer ──▶ OpenAI / Anthropic
 *                         │
 *                         └── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict
 * </pre>
 *
 * <p>This class is the runnable BRIDGE: a standalone process a service the
 * organization already runs posts messages to. Two doors, and they are not
 * interchangeable:
 *
 * <ul>
 *   <li><b>The message door</b> ({@code /guard/v1/step/request},
 *       {@code /guard/v1/step/response}) — the deployment shape of a bridge. The
 *       caller keeps its own provider connection, posts each body and gets the
 *       decision and the rewritten body back; the placeholder map travels between the
 *       two calls. A streamed reply arrives on the same response door as a different
 *       TRANSPORT ({@code Content-Type: text/event-stream}, fields in {@code ogr-*}
 *       headers) and the guarded frames come back with the bounded head released live;
 *       see {@link GuardApiHandler} and {@link GuardStreamHandler}.
 *   <li><b>Inline</b> ({@code /v1/chat/completions}, {@code /v1/responses},
 *       {@code /v1/messages}) — this process in the byte path, applying spans and
 *       refusing before the model sees anything, streaming included. Kept as the
 *       offline test bed for {@code ogr-bridge-core}'s streaming and span code and as
 *       documentation that runs — NOT as a gateway to deploy: a standalone process
 *       that takes the {@code base_url} is one more gateway, which is the job the
 *       products under {@code integrations/gateway/} already do.
 * </ul>
 */
public final class ProxyServer {

    /** Everything this server reads out of the environment. */
    public static final class Settings {
        public final Identity identity;
        public final boolean callerFallback;
        public final int streamHeadReleaseBytes;
        public final Duration upstreamTimeout;
        public final String upstreamOpenAi;
        public final String upstreamAnthropic;

        Settings(Identity identity, boolean callerFallback, int streamHeadReleaseBytes,
                 Duration upstreamTimeout, String upstreamOpenAi, String upstreamAnthropic) {
            this.identity = identity;
            this.callerFallback = callerFallback;
            this.streamHeadReleaseBytes = streamHeadReleaseBytes;
            this.upstreamTimeout = upstreamTimeout;
            this.upstreamOpenAi = upstreamOpenAi;
            this.upstreamAnthropic = upstreamAnthropic;
        }

        String upstreamFor(String path) {
            return path.toLowerCase(Locale.ROOT).endsWith("/messages")
                ? upstreamAnthropic : upstreamOpenAi;
        }
    }

    private final HttpServer http;
    private final OgrGuard guard;

    public ProxyServer(int port, OgrConfig config, Settings settings) throws IOException {
        this.guard = new OgrGuard(config).startHeartbeat();
        HttpClient upstream = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
        StepStore steps = new StepStore(Duration.ofMinutes(10).toMillis(), 10_000);

        this.http = HttpServer.create(new InetSocketAddress(port), 0);
        InlineHandler inline = new InlineHandler(guard, settings, upstream);
        GuardApiHandler api = new GuardApiHandler(guard, settings, steps);
        // The inline lane is mounted at the ROOT: a client pointed here must be able to
        // reach every provider path it uses, and anything this proxy cannot read is
        // relayed untouched rather than refused.
        http.createContext("/", inline);
        http.createContext(GuardApiHandler.REQUEST_PATH, api);
        http.createContext(GuardApiHandler.RESPONSE_PATH, api);
        http.createContext("/healthz", new com.sun.net.httpserver.HttpHandler() {
            @Override
            public void handle(com.sun.net.httpserver.HttpExchange exchange) throws IOException {
                Http.send(exchange, 200, "application/json", "{\"status\":\"ok\"}");
                exchange.close();
            }
        });
        http.setExecutor(Executors.newCachedThreadPool());
    }

    public void start() {
        http.start();
    }

    public int port() {
        return http.getAddress().getPort();
    }

    public void stop() {
        http.stop(0);
        guard.close();
    }

    public OgrGuard guard() {
        return guard;
    }

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(env("OGR_PROXY_PORT", "8800"));
        OgrConfig config = OgrConfig.builder()
            .baseUrl(env("OGR_URL", "http://localhost:3000"))
            .basePath(env("OGR_BASE_PATH", ""))
            .apiKey(env("OGR_API_KEY", ""))
            .mode(Mode.of(env("OGR_MODE", "observe")))
            .failMode(FailMode.of(env("OGR_FAIL_MODE", "open")))
            .timeout(Duration.ofMillis(Long.parseLong(env("OGR_TIMEOUT_MS", "5000"))))
            .streamHeadReleaseBytes(Integer.parseInt(env("OGR_STREAM_HEAD_RELEASE_BYTES", "32")))
            .payloadFromRuntime(!"false".equalsIgnoreCase(env("OGR_PAYLOAD_FROM_RUNTIME", "true")))
            .integrationName(env("OGR_INTEGRATION_NAME", OgrConfig.DEFAULT_INTEGRATION_NAME))
            .defaultIdentity(new Identity(
                env("OGR_AGENT_ID", ""), env("OGR_AGENT_TYPE", ""),
                env("OGR_AGENT_WORKSPACE", ""), ""))
            .build();
        Settings settings = new Settings(
            config.defaultIdentity(),
            !"false".equalsIgnoreCase(env("OGR_CALLER_FALLBACK", "true")),
            config.streamHeadReleaseBytes(),
            Duration.ofMillis(Long.parseLong(env("OGR_UPSTREAM_TIMEOUT_MS", "300000"))),
            trimSlash(env("OGR_UPSTREAM_OPENAI", "https://api.openai.com")),
            trimSlash(env("OGR_UPSTREAM_ANTHROPIC", "https://api.anthropic.com")));

        ProxyServer server = new ProxyServer(port, config, settings);
        server.start();
        System.out.println("[OGR-CONFIG] " + config.integrationId()
            + " instance=" + config.instanceId()
            + " runtime=" + config.endpoint("/v1/evaluate")
            + " mode=" + config.mode()
            + " fail_mode=" + config.failMode()
            + " stream_head_release_bytes=" + config.streamHeadReleaseBytes()
            + " listening=:" + server.port());
        // ⚠️ No request or response body is ever printed, at any level. A guard that logs
        // the traffic it judges puts the user's prompt, the tool schema and the model's
        // reply into the container log — twice per model call, since a step has two halves.
    }

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return (v == null || v.isEmpty()) ? fallback : v;
    }

    private static String trimSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}
