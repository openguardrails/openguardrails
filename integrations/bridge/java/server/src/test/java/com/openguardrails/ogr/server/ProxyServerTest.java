package com.openguardrails.ogr.server;

import com.openguardrails.ogr.FailMode;
import com.openguardrails.ogr.Identity;
import com.openguardrails.ogr.Mode;
import com.openguardrails.ogr.OgrConfig;
import com.openguardrails.ogr.json.Json;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.SocketException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The real proxy, between a mock provider and a mock runtime, exercised by a real HTTP
 * client — so the streamed byte path is tested as a client actually sees it.
 */
class ProxyServerTest {

    private static final String REQUEST = "{\"model\":\"gpt-5\",\"messages\":[{\"role\":\"user\",\"content\":\"mail ada@acme.io\"}]}";
    private static final String REQUEST_STREAM = "{\"model\":\"gpt-5\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"stream\":true}";
    private static final String REPLY = "{\"id\":\"chatcmpl-1\",\"object\":\"chat.completion\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"here you go\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\": \\\"rm -rf /\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":4}}";
    private static final String STREAM = "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"The secret plan is\"}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" to do the thing\"}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

    /**
     * ⚠️ The placeholder arrives in TWO PIECES, which is the whole difficulty of restoring
     * a streamed reply: neither frame contains a token, so a per-frame replace restores
     * nothing and the caller's application receives {@code ${OGR_EMAIL_1}} as content.
     */
    private static final String STREAM_PLACEHOLDER =
        "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"sent to ${OGR_EMA\"}}]}\n\n"
            + "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"IL_1} ok\"}}]}\n\n"
            + "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
            + "data: [DONE]\n\n";

    private static final String ALLOW =
        "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\"}";
    private static final String BLOCK =
        "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"block\"}";

    private static final HttpClient CLIENT = HttpClient.newHttpClient();

    /**
     * ONE mock runtime and ONE mock provider for the whole class, re-armed per test —
     * see MockServers for why a listener per test is a flake and not a fixture.
     */
    private static MockServers.Runtime RUNTIME;
    private static MockServers.Provider PROVIDER;

    @BeforeAll
    static void bootMocks() throws IOException {
        RUNTIME = new MockServers.Runtime();
        PROVIDER = new MockServers.Provider("{}", false);
    }

    @AfterAll
    static void stopMocks() {
        RUNTIME.stop();
        PROVIDER.stop();
    }

    private static MockServers.Runtime runtime(String... verdicts) {
        RUNTIME.reset(verdicts);
        return RUNTIME;
    }

    private static MockServers.Provider provider(String body, boolean sse) {
        PROVIDER.reset(body, sse);
        return PROVIDER;
    }

    private static ProxyServer proxy(MockServers.Runtime runtime, MockServers.Provider provider,
                                     Mode mode, FailMode failMode, int head) throws IOException {
        OgrConfig config = OgrConfig.builder()
            .baseUrl(runtime.url())
            .apiKey("ogr_test")
            .mode(mode)
            .failMode(failMode)
            .streamHeadReleaseBytes(head)
            .timeout(Duration.ofSeconds(5))
            .heartbeatInterval(Duration.ofHours(1))
            .defaultIdentity(new Identity("onesec-proxy", "onesec", "line-a", ""))
            .build();
        ProxyServer.Settings settings = new ProxyServer.Settings(
            config.defaultIdentity(), true, head, Duration.ofSeconds(20),
            provider.url(), provider.url());
        ProxyServer server = new ProxyServer(0, config, settings);
        server.start();
        return server;
    }

    private static HttpResponse<String> post(ProxyServer server, String path, String body,
                                             String... headers) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder()
            .uri(URI.create("http://localhost:" + server.port() + path))
            .header("content-type", "application/json")
            .header("authorization", "Bearer sk-client-key")
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        for (int i = 0; i + 1 < headers.length; i += 2) {
            request.header(headers[i], headers[i + 1]);
        }
        return CLIENT.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    /** The streamed transport of the message door: the provider's SSE IS the body. */
    private static HttpResponse<String> postStream(ProxyServer server, String path, String body,
                                                   String... headers) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder()
            .uri(URI.create("http://localhost:" + server.port() + path))
            .header("content-type", "text/event-stream")
            .header("authorization", "Bearer sk-client-key")
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        for (int i = 0; i + 1 < headers.length; i += 2) {
            request.header(headers[i], headers[i + 1]);
        }
        return CLIENT.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    /** The verdict the streamed door rides on its last line — an SSE comment. */
    private static Object trailer(String stream) {
        int at = stream.lastIndexOf(": ogr ");
        assertTrue(at >= 0, "the streamed door always ends with its verdict line");
        String line = stream.substring(at + ": ogr ".length());
        int end = line.indexOf('\n');
        return Json.parseOrNull((end < 0 ? line : line.substring(0, end)).trim());
    }

    // ---------------------------------------------------------------- buffered

    @Test
    void anAllowedCallReachesTheProviderAndComesBackVerbatim() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertEquals(200, response.statusCode());
            assertEquals(REPLY, response.body());
            assertEquals(1, provider.received.size());
            assertEquals(REQUEST, provider.received.get(0), "an allow forwards the body byte for byte");

            assertEquals(2, runtime.events.size(), "one model call is TWO events");
            Object first = Json.parseOrNull(runtime.events.get(0));
            Object second = Json.parseOrNull(runtime.events.get(1));
            assertEquals("step/request", Json.str(first, "kind"));
            assertEquals("step/response", Json.str(second, "kind"));
            assertEquals(Json.str(first, "step_id"), Json.str(second, "step_id"));
            assertEquals("openai.chat", Json.str(first, "llm_protocol"));
            assertEquals("onesec-proxy", Json.str(first, "agent_id"));
            assertEquals("mail ada@acme.io", Json.str(first, "payload.messages.0.content"));
            assertEquals("here you go", Json.str(second, "payload.choices.0.message.content"));
            // ⚠️⚠️ THE CANONICAL QUESTION AND NOTHING ELSE. Every consequence of a verdict
            // is this bridge's own work, so it must never depend on an optional extension
            // of the decision path — no `?payload=true`, no query string at all.
            assertEquals("/v1/evaluate", runtime.uris.get(0));
            assertEquals("/v1/evaluate", runtime.uris.get(1));
        } finally {
            server.stop();
        }
    }

    @Test
    void aBlockedRequestNeverReachesTheProvider() throws Exception {
        MockServers.Runtime runtime = runtime(BLOCK);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertEquals(200, response.statusCode(), "a refusal is 200 in the caller's own protocol");
            assertEquals("block", response.headers().firstValue("x-ogr-decision").orElse(""));
            assertEquals(0, provider.received.size(), "the model was never called");
            assertEquals("content_filter",
                Json.str(Json.parseOrNull(response.body()), "choices.0.finish_reason"));
        } finally {
            server.stop();
        }
    }

    /** ⚠️ The tool calls held here are the only copy of an action anyone can still refuse. */
    @Test
    void aBlockedReplyIsRefusedBeforeTheCallerCanActOnItsToolCalls() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, BLOCK);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertEquals(200, response.statusCode());
            assertFalse(response.body().contains("rm -rf"), "the refused action must not reach the caller");
            assertEquals("content_filter",
                Json.str(Json.parseOrNull(response.body()), "choices.0.finish_reason"));
        } finally {
            server.stop();
        }
    }

    /** The whole round trip of a redaction: masked on the way out, restored on the way home. */
    @Test
    void spansAreAppliedOnTheWayOutAndRestoredOnTheWayBack() throws Exception {
        String redacting = "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\","
            + "\"modifications\":{\"spans\":[{\"path\":\"payload.messages.0.content\","
            + "\"start\":5,\"end\":16,\"replacement\":\"${OGR_EMAIL_1}\"}]}}";
        MockServers.Runtime runtime = runtime(redacting, ALLOW);
        MockServers.Provider provider = provider(
            REPLY.replace("here you go", "sent to ${OGR_EMAIL_1}"), false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertTrue(provider.received.get(0).contains("${OGR_EMAIL_1}"));
            assertFalse(provider.received.get(0).contains("ada@acme.io"),
                "the value must not reach the model");
            assertTrue(response.body().contains("sent to ada@acme.io"),
                "the caller receives its own data back, not our placeholder");
        } finally {
            server.stop();
        }
    }

    /** ⚠️ Traffic this proxy cannot read is relayed untouched, never refused. */
    @Test
    void anUnrecognisedPathIsProxiedAndNotJudged() throws Exception {
        MockServers.Runtime runtime = runtime();
        MockServers.Provider provider = provider("{\"data\":[]}", false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/embeddings", "{\"input\":\"x\"}");
            assertEquals(200, response.statusCode());
            assertEquals("{\"data\":[]}", response.body());
            assertEquals(0, runtime.events.size());
        } finally {
            server.stop();
        }
    }

    // ---------------------------------------------------------------- streaming

    @Test
    void anAllowedStreamArrivesWhole() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, ALLOW);
        MockServers.Provider provider = provider(STREAM, true);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST_STREAM);
            assertEquals(200, response.statusCode());
            assertTrue(response.body().contains("The secret plan is"));
            assertTrue(response.body().contains(" to do the thing"));
            assertTrue(response.body().contains("[DONE]"));

            Object reported = Json.parseOrNull(runtime.events.get(1));
            assertEquals("step/response", Json.str(reported, "kind"));
            // ⚠️ A stream has no single raw body, so it is reported in the CANONICAL shape.
            assertEquals("The secret plan is to do the thing", Json.str(reported, "payload.text"));
        } finally {
            server.stop();
        }
    }

    /**
     * ⚠️⚠️ The head bound is the EXPOSURE bound. At 0 nothing client-visible goes out before
     * the verdict, so a block is a CLEAN refusal rather than a retraction of an answer the
     * user already read.
     */
    @Test
    void aBlockedStreamAtZeroHeadNeverShowsTheAnswer() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, BLOCK);
        MockServers.Provider provider = provider(STREAM, true);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 0);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST_STREAM);
            assertEquals(200, response.statusCode());
            assertFalse(response.body().contains("secret plan"),
                "not one byte of the refused answer may reach the caller");
            assertTrue(response.body().contains("content_filter"));
        } finally {
            server.stop();
        }
    }

    /**
     * With a generous head the answer is delivered and can only be RETRACTED — which is
     * exactly what the bound exists to bound.
     */
    @Test
    void aGenerousHeadTurnsABlockIntoARetraction() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, BLOCK);
        MockServers.Provider provider = provider(STREAM, true);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 100000);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST_STREAM);
            assertTrue(response.body().contains("The secret plan is"),
                "the head was released before there was anything to judge");
            assertTrue(response.body().contains("content_filter"), "and then retracted");
        } finally {
            server.stop();
        }
    }

    // ------------------------------------------------------------- out of band

    @Test
    void theOutOfBandDoorJudgesBothHalvesAndKeepsTheBodyVerbatim() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, BLOCK);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            String envelope = "{\"llm_protocol\":\"openai.chat\",\"session_hint\":\"s-1\","
                + "\"agent_id\":\"line-a-bot\",\"body\":" + REQUEST + "}";
            HttpResponse<String> first = post(server, "/guard/v1/step/request", envelope);
            assertEquals(200, first.statusCode());
            Object answer = Json.parseOrNull(first.body());
            assertEquals("allow", Json.str(answer, "decision"));
            String stepId = Json.str(answer, "step_id");
            assertFalse(stepId.isEmpty());
            // Nothing changed, so nothing is echoed: the caller forwards its own copy.
            assertEquals("unchanged", Json.str(answer, "body"));

            String second = "{\"step_id\":\"" + stepId + "\",\"body\":" + REPLY + "}";
            HttpResponse<String> reply = post(server, "/guard/v1/step/response", second);
            Object refused = Json.parseOrNull(reply.body());
            assertEquals("block", Json.str(refused, "decision"));
            // The refusal IS the body, in the caller's own protocol, and there is no
            // continuation: answer the client with it.
            assertEquals("content_filter", Json.str(refused, "body.choices.0.finish_reason"));
            assertEquals("", Json.str(refused, "continuation"));
            assertFalse(reply.body().contains("rm -rf"));

            assertEquals(2, runtime.events.size());
            assertEquals(Json.str(Json.parseOrNull(runtime.events.get(0)), "step_id"),
                Json.str(Json.parseOrNull(runtime.events.get(1)), "step_id"),
                "the caller's own step_id binds both halves even out of band");
            assertEquals("line-a-bot", Json.str(Json.parseOrNull(runtime.events.get(0)), "agent_id"));
        } finally {
            server.stop();
        }
    }

    /** A caller that carries the mapping itself needs nothing from this process's memory. */
    @Test
    void theOutOfBandDoorAcceptsThePlaceholderMappingBack() throws Exception {
        String redacting = "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\","
            + "\"modifications\":{\"spans\":[{\"path\":\"payload.messages.0.content\","
            + "\"start\":5,\"end\":16,\"replacement\":\"${OGR_EMAIL_1}\"}]}}";
        MockServers.Runtime runtime = runtime(redacting, ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            String envelope = "{\"llm_protocol\":\"openai.chat\",\"body\":" + REQUEST + "}";
            Object first = Json.parseOrNull(post(server, "/guard/v1/step/request", envelope).body());
            // A rewritten body is a REDACTION, and the returned body is the one to forward.
            assertEquals("redacted", Json.str(first, "decision"));
            assertEquals("mail ${OGR_EMAIL_1}", Json.str(first, "body.messages.0.content"));
            assertEquals("ada@acme.io", Json.str(first, "placeholders.${OGR_EMAIL_1}"));

            // A DIFFERENT step id, as if the reply landed on another replica.
            String echoed = REPLY.replace("here you go", "sent to ${OGR_EMAIL_1}");
            String second = "{\"step_id\":\"other-replica-step\",\"llm_protocol\":\"openai.chat\","
                + "\"placeholders\":{\"${OGR_EMAIL_1}\":\"ada@acme.io\"},\"body\":" + echoed + "}";
            Object reply = Json.parseOrNull(post(server, "/guard/v1/step/response", second).body());
            // A restored reply is a REDACTION too: the caller delivers the returned one.
            assertEquals("redacted", Json.str(reply, "decision"));
            assertEquals("sent to ada@acme.io", Json.str(reply, "body.choices.0.message.content"));
        } finally {
            server.stop();
        }
    }

    /**
     * A continuation is a BLOCK the caller carries out, never a redaction: the decision
     * stays {@code block}, and {@code continuation} says the body is one to forward.
     */
    @Test
    void theOutOfBandDoorReportsAContinuedBodyAsABlock() throws Exception {
        String withholding = "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"block\","
            + "\"continuation\":{\"style\":\"withhold\",\"paths\":[\"payload.messages.0.content\"],"
            + "\"notice\":\"[withheld by policy]\"}}";
        MockServers.Runtime runtime = runtime(withholding, ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            String envelope = "{\"llm_protocol\":\"openai.chat\",\"body\":" + REQUEST + "}";
            Object answer = Json.parseOrNull(post(server, "/guard/v1/step/request", envelope).body());
            assertEquals("block", Json.str(answer, "decision"));
            assertEquals("withhold", Json.str(answer, "continuation"));
            assertEquals("[withheld by policy]", Json.str(answer, "body.messages.0.content"));
            assertEquals("", Json.str(answer, "placeholders.${OGR_EMAIL_1}"),
                "a withheld notice never enters the restore map");
        } finally {
            server.stop();
        }
    }

    // -------------------------------------------------- the streamed message door

    /**
     * The transport a JSON envelope cannot carry: the frames arrive as they arrive, the
     * guarded frames come back, and the verdict rides the last line as a comment every
     * SSE parser ignores.
     */
    @Test
    void theStreamedDoorGuardsTheFramesAndRidesTheVerdictOnATrailer() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = postStream(server, "/guard/v1/step/response", STREAM,
                "ogr-step-id", "step-abc", "ogr-llm-protocol", "openai.chat",
                "ogr-agent-id", "line-a-bot");
            assertEquals(200, response.statusCode());
            assertTrue(response.headers().firstValue("content-type").orElse("")
                .startsWith("text/event-stream"));
            assertTrue(response.body().contains("The secret plan is"));
            assertTrue(response.body().contains(" to do the thing"));
            assertTrue(response.body().contains("[DONE]"));

            Object verdict = trailer(response.body());
            assertEquals("allow", Json.str(verdict, "decision"));
            assertEquals("step-abc", Json.str(verdict, "step_id"));
            assertEquals("openai.chat", Json.str(verdict, "llm_protocol"));

            assertEquals(1, runtime.events.size(), "a stream is ONE event, judged once, at the end");
            Object event = Json.parseOrNull(runtime.events.get(0));
            assertEquals("step/response", Json.str(event, "kind"));
            assertEquals("step-abc", Json.str(event, "step_id"));
            assertEquals("line-a-bot", Json.str(event, "agent_id"));
            // ⚠️ No single raw body exists, so the reply is reported in the CANONICAL shape.
            assertEquals("The secret plan is to do the thing", Json.str(event, "payload.text"));
            assertEquals("/v1/evaluate", runtime.uris.get(0), "a stream asks the plain question too");
        } finally {
            server.stop();
        }
    }

    /**
     * ⚠️⚠️ What the lane is FOR. The caller relays what comes back, so at a head of 0 a
     * block is a clean refusal — the answer the runtime refused never reaches anyone.
     */
    @Test
    void theStreamedDoorAtZeroHeadNeverShowsTheRefusedAnswer() throws Exception {
        MockServers.Runtime runtime = runtime(BLOCK);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = postStream(server, "/guard/v1/step/response", STREAM,
                "ogr-step-id", "step-abc", "ogr-llm-protocol", "openai.chat",
                "ogr-head-release-bytes", "0");
            assertEquals(200, response.statusCode());
            assertFalse(response.body().contains("secret plan"),
                "not one byte of the refused answer may reach the caller");
            assertTrue(response.body().contains("content_filter"));
            assertEquals("block", Json.str(trailer(response.body()), "decision"));
        } finally {
            server.stop();
        }
    }

    /**
     * The two halves through the two transports of ONE door: the JSON request half learns
     * the mapping, the streamed response half restores it FRAME BY FRAME.
     */
    @Test
    void theStreamedDoorRestoresAPlaceholderSplitAcrossFrames() throws Exception {
        String redacting = "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\","
            + "\"modifications\":{\"spans\":[{\"path\":\"payload.messages.0.content\","
            + "\"start\":5,\"end\":16,\"replacement\":\"${OGR_EMAIL_1}\"}]}}";
        MockServers.Runtime runtime = runtime(redacting, ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            String envelope = "{\"llm_protocol\":\"openai.chat\",\"body\":" + REQUEST + "}";
            Object first = Json.parseOrNull(post(server, "/guard/v1/step/request", envelope).body());
            assertEquals("redacted", Json.str(first, "decision"));
            String stepId = Json.str(first, "step_id");

            HttpResponse<String> response = postStream(server, "/guard/v1/step/response",
                STREAM_PLACEHOLDER, "ogr-step-id", stepId, "ogr-llm-protocol", "openai.chat");
            assertTrue(response.body().contains("ada@acme.io"),
                "the token arrived in two pieces and still has to come back as the value");
            assertFalse(response.body().contains("OGR_EMAIL"),
                "a placeholder delivered to the client is the failure this exists to prevent");

            // ⚠️ What the JUDGE reads is the reply AS PRODUCED — still masked, or the
            // detectors would find the very values we removed.
            Object event = Json.parseOrNull(runtime.events.get(1));
            assertEquals("sent to ${OGR_EMAIL_1} ok", Json.str(event, "payload.text"));
        } finally {
            server.stop();
        }
    }

    /** A caller that carries the mapping itself needs nothing from this process's memory. */
    @Test
    void theStreamedDoorAcceptsThePlaceholderMappingAsAHeader() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = postStream(server, "/guard/v1/step/response",
                STREAM_PLACEHOLDER, "ogr-step-id", "landed-on-another-replica",
                "ogr-llm-protocol", "openai.chat",
                "ogr-placeholders", "{\"${OGR_EMAIL_1}\":\"ada@acme.io\"}");
            assertTrue(response.body().contains("ada@acme.io"));
            assertFalse(response.body().contains("OGR_EMAIL"));
        } finally {
            server.stop();
        }
    }

    /** {@code ?verdict_only=true}: the reply is judged and RECORDED, and no frames come back. */
    @Test
    void theStreamedDoorCanAnswerAPlainVerdictInstead() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = postStream(server,
                "/guard/v1/step/response?verdict_only=true", STREAM,
                "ogr-step-id", "step-abc", "ogr-llm-protocol", "openai.chat");
            assertEquals(200, response.statusCode());
            assertTrue(response.headers().firstValue("content-type").orElse("")
                .startsWith("application/json"));
            Object verdict = Json.parseOrNull(response.body());
            assertEquals("allow", Json.str(verdict, "decision"));
            assertEquals("step-abc", Json.str(verdict, "step_id"));
            assertFalse(response.body().contains("secret plan"),
                "the caller already delivered its own frames; there is nothing to hand back");
            assertEquals("The secret plan is to do the thing",
                Json.str(Json.parseOrNull(runtime.events.get(0)), "payload.text"));
        } finally {
            server.stop();
        }
    }

    /**
     * ⚠️ A REQUEST is one body: there is nothing to stream in front of the model, and the
     * step id is how a streamed reply finds the mapping that must be restored into it.
     */
    @Test
    void theStreamedDoorRefusesWhatItCannotCarry() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            assertEquals(400, postStream(server, "/guard/v1/step/request", STREAM,
                "ogr-step-id", "s", "ogr-llm-protocol", "openai.chat").statusCode());
            assertEquals(400, postStream(server, "/guard/v1/step/response", STREAM,
                "ogr-llm-protocol", "openai.chat").statusCode());
            assertEquals(400, postStream(server, "/guard/v1/step/response", STREAM,
                "ogr-step-id", "s", "ogr-llm-protocol", "canonical").statusCode());
            assertEquals(0, runtime.events.size(), "nothing refused at the door is reported");
        } finally {
            server.stop();
        }
    }

    /**
     * ⚠️⚠️ The head goes out WHILE THE REPLY IS STILL ARRIVING, and that is the difference
     * between this lane and "post the whole reply, then wait": a caller relaying what
     * comes back must be able to show its user the first tokens, or the guard has traded
     * every stream for a spinner. One frame is uploaded, and its guarded copy has to come
     * back before the rest of the stream is sent at all.
     *
     * <p>⚠️ Driven over a RAW SOCKET, and it has to be: the JDK's own HTTP client does not
     * surface a response until it has finished sending the request body, so a test
     * written with it cannot tell this lane apart from one that buffers everything.
     */
    @Test
    void theStreamedDoorReleasesTheHeadWhileTheStreamIsStillArriving() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        String[] frames = STREAM.split("\n\n");
        try {
            onceMoreIfReset(runtime, ALLOW, () -> liveHead(server, frames, runtime));
        } finally {
            server.stop();
        }
    }

    private static void liveHead(ProxyServer server, String[] frames, MockServers.Runtime runtime)
        throws Exception {
        try (Socket socket = new Socket("localhost", server.port())) {
            socket.setSoTimeout(5000);
            OutputStream out = socket.getOutputStream();
            out.write(("POST /guard/v1/step/response HTTP/1.1\r\n"
                + "Host: localhost:" + server.port() + "\r\n"
                + "Content-Type: text/event-stream\r\n"
                + "ogr-step-id: live-1\r\n"
                + "ogr-llm-protocol: openai.chat\r\n"
                + "Transfer-Encoding: chunked\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            chunk(out, frames[0] + "\n\n");

            InputStream in = socket.getInputStream();
            assertTrue(readUntil(in, "The secret plan is").contains("The secret plan is"),
                "the head is released against a stream that has not ended");
            assertTrue(runtime.events.isEmpty(), "and nothing has been judged yet");

            for (int i = 1; i < frames.length; i++) {
                chunk(out, frames[i] + "\n\n");
            }
            out.write("0\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();

            String rest = readUntil(in, ": ogr ") + readUntil(in, "\n\n");
            assertTrue(rest.contains("[DONE]"));
            assertEquals("allow", Json.str(trailer(rest), "decision"));
            assertEquals(1, runtime.events.size(), "one stream, one event, judged at the end");
        }
    }

    /**
     * ⚠️ OBSERVE HOLDS NOTHING, at any head budget. A hold buys the ability to refuse and
     * observe never refuses, so holding there would spend a stream's whole
     * time-to-first-token to reach a verdict nobody acts on — in the one mode that exists
     * to be rolled out without changing what anyone sees.
     */
    @Test
    void observeModeNeverHoldsAStream() throws Exception {
        MockServers.Runtime runtime = runtime(BLOCK);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.OBSERVE, FailMode.CLOSED, 0);
        String[] frames = STREAM.split("\n\n");
        try {
            onceMoreIfReset(runtime, BLOCK, () -> observedStream(server, frames));
        } finally {
            server.stop();
        }
    }

    private static void observedStream(ProxyServer server, String[] frames) throws Exception {
        try (Socket socket = new Socket("localhost", server.port())) {
            socket.setSoTimeout(5000);
            OutputStream out = socket.getOutputStream();
            out.write(("POST /guard/v1/step/response HTTP/1.1\r\n"
                + "Host: localhost:" + server.port() + "\r\n"
                + "Content-Type: text/event-stream\r\n"
                + "ogr-step-id: observed-1\r\n"
                + "ogr-llm-protocol: openai.chat\r\n"
                + "Transfer-Encoding: chunked\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            chunk(out, frames[0] + "\n\n");
            assertTrue(readUntil(socket.getInputStream(), "The secret plan is")
                    .contains("The secret plan is"),
                "a head budget of 0 still releases everything when nothing will be refused");

            for (int i = 1; i < frames.length; i++) {
                chunk(out, frames[i] + "\n\n");
            }
            out.write("0\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            String rest = readUntil(socket.getInputStream(), ": ogr ")
                + readUntil(socket.getInputStream(), "\n\n");
            assertEquals("allow", Json.str(trailer(rest), "decision"),
                "the runtime said block and observe still delivers — that is the mode");
        }
    }

    /**
     * Runs a raw-socket exchange, once more if the connection was RESET rather than
     * answered.
     *
     * <p>⚠️ Not papering over the door: a listener on a recycled ephemeral port can still
     * be tearing down when the next connect lands — the same hazard MockServers keeps one
     * server pair per class to avoid — and here it surfaces as a reset before the first
     * byte. A failed ASSERTION is never retried; only a reset is.
     */
    private static void onceMoreIfReset(MockServers.Runtime runtime, String verdict,
                                        SocketExchange exchange) throws Exception {
        for (int attempt = 0; ; attempt++) {
            try {
                exchange.run();
                return;
            } catch (SocketException e) {
                if (attempt > 0) {
                    throw e;
                }
                runtime.reset(verdict);
            }
        }
    }

    private interface SocketExchange {
        void run() throws Exception;
    }

    /** One HTTP/1.1 chunk, written and flushed on its own — a frame the server sees now. */
    private static void chunk(OutputStream out, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        out.write((Integer.toHexString(bytes.length) + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    /**
     * Raw bytes until the marker shows up — the socket's read timeout is the assertion
     * that the server did not simply wait for the whole upload.
     */
    private static String readUntil(InputStream in, String marker) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) {
            sb.append((char) c);
            if (sb.indexOf(marker) >= 0) {
                break;
            }
        }
        return sb.toString();
    }

    // ----------------------------------------------------------------- identity

    /**
     * ⚠️⚠️ A client must not be able to choose which policy set judges it. The
     * gateway-asserted headers are stripped from the inbound request and resolved by this
     * proxy, so a forged workspace changes nothing.
     */
    @Test
    void aClientCannotForgeItsOwnWorkspace() throws Exception {
        MockServers.Runtime runtime = runtime(ALLOW, ALLOW);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            post(server, "/v1/chat/completions", REQUEST,
                "x-ogr-agent-type", "some-harness", "x-ogr-agent-user", "u-9");
            Object event = Json.parseOrNull(runtime.events.get(0));
            assertEquals("line-a", Json.str(event, "agent_workspace"));
            assertEquals("some-harness", Json.str(event, "agent_type"), "the client's to assert");
            assertEquals("u-9", Json.str(event, "agent_user"), "the client's to assert");
            assertFalse(provider.received.isEmpty());
        } finally {
            server.stop();
        }
    }

    /** ⚠️ Observe reports and never enforces — the roll-out posture. */
    @Test
    void observeModeReportsAndNeverRefuses() throws Exception {
        MockServers.Runtime runtime = runtime(BLOCK, BLOCK);
        MockServers.Provider provider = provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.OBSERVE, FailMode.CLOSED, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertEquals(REPLY, response.body());
            assertEquals(1, provider.received.size());
        } finally {
            server.stop();
        }
    }
}
