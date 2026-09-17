package com.openguardrails.ogr.server;

import com.openguardrails.ogr.FailMode;
import com.openguardrails.ogr.Identity;
import com.openguardrails.ogr.Mode;
import com.openguardrails.ogr.OgrConfig;
import com.openguardrails.ogr.json.Json;
import org.junit.jupiter.api.Test;

import java.io.IOException;
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

    private static final String ALLOW =
        "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\"}";
    private static final String BLOCK =
        "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"block\"}";

    private static final HttpClient CLIENT = HttpClient.newHttpClient();

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

    // ---------------------------------------------------------------- buffered

    @Test
    void anAllowedCallReachesTheProviderAndComesBackVerbatim() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, ALLOW);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
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
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    @Test
    void aBlockedRequestNeverReachesTheProvider() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(BLOCK);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
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
            provider.stop();
            runtime.stop();
        }
    }

    /** ⚠️ The tool calls held here are the only copy of an action anyone can still refuse. */
    @Test
    void aBlockedReplyIsRefusedBeforeTheCallerCanActOnItsToolCalls() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, BLOCK);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertEquals(200, response.statusCode());
            assertFalse(response.body().contains("rm -rf"), "the refused action must not reach the caller");
            assertEquals("content_filter",
                Json.str(Json.parseOrNull(response.body()), "choices.0.finish_reason"));
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    /** The whole round trip of a redaction: masked on the way out, restored on the way home. */
    @Test
    void spansAreAppliedOnTheWayOutAndRestoredOnTheWayBack() throws Exception {
        String redacting = "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\","
            + "\"modifications\":{\"spans\":[{\"path\":\"payload.messages.0.content\","
            + "\"start\":5,\"end\":16,\"replacement\":\"${OGR_EMAIL_1}\"}]}}";
        MockServers.Runtime runtime = new MockServers.Runtime(redacting, ALLOW);
        MockServers.Provider provider = new MockServers.Provider(
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
            provider.stop();
            runtime.stop();
        }
    }

    /** ⚠️ Traffic this proxy cannot read is relayed untouched, never refused. */
    @Test
    void anUnrecognisedPathIsProxiedAndNotJudged() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime();
        MockServers.Provider provider = new MockServers.Provider("{\"data\":[]}", false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/embeddings", "{\"input\":\"x\"}");
            assertEquals(200, response.statusCode());
            assertEquals("{\"data\":[]}", response.body());
            assertEquals(0, runtime.events.size());
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    // ---------------------------------------------------------------- streaming

    @Test
    void anAllowedStreamArrivesWhole() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, ALLOW);
        MockServers.Provider provider = new MockServers.Provider(STREAM, true);
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
            provider.stop();
            runtime.stop();
        }
    }

    /**
     * ⚠️⚠️ The head bound is the EXPOSURE bound. At 0 nothing client-visible goes out before
     * the verdict, so a block is a CLEAN refusal rather than a retraction of an answer the
     * user already read.
     */
    @Test
    void aBlockedStreamAtZeroHeadNeverShowsTheAnswer() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, BLOCK);
        MockServers.Provider provider = new MockServers.Provider(STREAM, true);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 0);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST_STREAM);
            assertEquals(200, response.statusCode());
            assertFalse(response.body().contains("secret plan"),
                "not one byte of the refused answer may reach the caller");
            assertTrue(response.body().contains("content_filter"));
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    /**
     * With a generous head the answer is delivered and can only be RETRACTED — which is
     * exactly what the bound exists to bound.
     */
    @Test
    void aGenerousHeadTurnsABlockIntoARetraction() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, BLOCK);
        MockServers.Provider provider = new MockServers.Provider(STREAM, true);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 100000);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST_STREAM);
            assertTrue(response.body().contains("The secret plan is"),
                "the head was released before there was anything to judge");
            assertTrue(response.body().contains("content_filter"), "and then retracted");
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    // ------------------------------------------------------------- out of band

    @Test
    void theOutOfBandDoorJudgesBothHalvesAndKeepsTheBodyVerbatim() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, BLOCK);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
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
            assertEquals("mail ada@acme.io", Json.str(answer, "body.messages.0.content"));

            String second = "{\"step_id\":\"" + stepId + "\",\"body\":" + REPLY + "}";
            HttpResponse<String> reply = post(server, "/guard/v1/step/response", second);
            Object refused = Json.parseOrNull(reply.body());
            assertEquals("block", Json.str(refused, "decision"));
            assertNotNull(Json.get(refused, "refusal"));
            assertFalse(reply.body().contains("rm -rf"));

            assertEquals(2, runtime.events.size());
            assertEquals(Json.str(Json.parseOrNull(runtime.events.get(0)), "step_id"),
                Json.str(Json.parseOrNull(runtime.events.get(1)), "step_id"),
                "the caller's own step_id binds both halves even out of band");
            assertEquals("line-a-bot", Json.str(Json.parseOrNull(runtime.events.get(0)), "agent_id"));
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    /** A caller that carries the mapping itself needs nothing from this process's memory. */
    @Test
    void theOutOfBandDoorAcceptsThePlaceholderMappingBack() throws Exception {
        String redacting = "{\"event_id\":\"e\",\"provider\":\"mock\",\"decision\":\"allow\","
            + "\"modifications\":{\"spans\":[{\"path\":\"payload.messages.0.content\","
            + "\"start\":5,\"end\":16,\"replacement\":\"${OGR_EMAIL_1}\"}]}}";
        MockServers.Runtime runtime = new MockServers.Runtime(redacting, ALLOW);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.ENFORCE, FailMode.OPEN, 32);
        try {
            String envelope = "{\"llm_protocol\":\"openai.chat\",\"body\":" + REQUEST + "}";
            Object first = Json.parseOrNull(post(server, "/guard/v1/step/request", envelope).body());
            assertEquals("ada@acme.io", Json.str(first, "placeholders.${OGR_EMAIL_1}"));

            // A DIFFERENT step id, as if the reply landed on another replica.
            String echoed = REPLY.replace("here you go", "sent to ${OGR_EMAIL_1}");
            String second = "{\"step_id\":\"other-replica-step\",\"llm_protocol\":\"openai.chat\","
                + "\"placeholders\":{\"${OGR_EMAIL_1}\":\"ada@acme.io\"},\"body\":" + echoed + "}";
            Object reply = Json.parseOrNull(post(server, "/guard/v1/step/response", second).body());
            assertEquals("allow", Json.str(reply, "decision"));
            assertEquals("sent to ada@acme.io", Json.str(reply, "body.choices.0.message.content"));
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }

    // ----------------------------------------------------------------- identity

    /**
     * ⚠️⚠️ A client must not be able to choose which policy set judges it. The
     * gateway-asserted headers are stripped from the inbound request and resolved by this
     * proxy, so a forged workspace changes nothing.
     */
    @Test
    void aClientCannotForgeItsOwnWorkspace() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(ALLOW, ALLOW);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
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
            provider.stop();
            runtime.stop();
        }
    }

    /** ⚠️ Observe reports and never enforces — the roll-out posture. */
    @Test
    void observeModeReportsAndNeverRefuses() throws Exception {
        MockServers.Runtime runtime = new MockServers.Runtime(BLOCK, BLOCK);
        MockServers.Provider provider = new MockServers.Provider(REPLY, false);
        ProxyServer server = proxy(runtime, provider, Mode.OBSERVE, FailMode.CLOSED, 32);
        try {
            HttpResponse<String> response = post(server, "/v1/chat/completions", REQUEST);
            assertEquals(REPLY, response.body());
            assertEquals(1, provider.received.size());
        } finally {
            server.stop();
            provider.stop();
            runtime.stop();
        }
    }
}
