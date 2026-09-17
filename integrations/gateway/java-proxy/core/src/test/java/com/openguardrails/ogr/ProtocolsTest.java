package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.Protocols;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProtocolsTest {

    /**
     * ⚠️ {@code openai.chat}'s body test is "has a messages array", which every Anthropic
     * body also passes. Registered as a peer rather than a fallback it swallows every
     * Anthropic request whose path we do not recognise — and the symptom is a
     * correctly-parsed-LOOKING conversation with the system prompt missing and every
     * tool_use block dropped.
     */
    @Test
    void chatDoesNotSwallowAnthropicBodies() {
        String anthropic = "{\"model\":\"claude\",\"max_tokens\":8,\"system\":\"s\","
            + "\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}";
        Protocol p = Protocols.detect("/some/unknown/mount", Json.parseOrNull(anthropic));
        assertEquals("anthropic.messages", p.name());
    }

    /**
     * ⚠️ count_tokens is REJECTED outright, not merely ignored: its body is a valid
     * messages body, so falling through to shape matching would report a turn that never
     * reached a model.
     */
    @Test
    void countTokensStopsDetectionOutright() {
        String body = "{\"model\":\"claude\",\"max_tokens\":8,\"messages\":[]}";
        assertNull(Protocols.detect("/v1/messages/count_tokens", Json.parseOrNull(body)));
        assertFalse(Protocols.isCompletionPath("/v1/messages/count_tokens"));
        assertTrue(Protocols.isCompletionPath("/v1/messages"));
    }

    /** A deployment may mount these under a prefix, so matching is by suffix. */
    @Test
    void recognisesPrefixedMounts() {
        assertEquals("openai.chat", Protocols.detect("/openai/v1/chat/completions?x=1", null).name());
        assertEquals("anthropic.messages", Protocols.detect("/api/v1/messages/", null).name());
        assertEquals("openai.responses", Protocols.detect("/proxy/v1/responses", null).name());
    }

    /**
     * ⚠️ Returns null rather than guessing. Reporting a protocol we did not establish is
     * how a deployment ends up with hundreds of thousands of events all stamped
     * {@code openai.chat} and no way to tell whether any of them were — at which point
     * the field has stopped being evidence.
     */
    @Test
    void anUnrecognisableRequestIsNotGuessedAt() {
        // The legacy completions shape: no `messages`, no `input`, nothing to key on.
        assertNull(Protocols.detect("/v1/completions", Json.parseOrNull("{\"prompt\":\"x\",\"model\":\"m\"}")));
        assertNull(Protocols.detect("/health", Json.parseOrNull("{\"ok\":true}")));
        assertNull(Protocols.detect(null, null));
    }

    @Test
    void injectsStreamUsageOnlyWhereItIsMissing() {
        assertNull(com.openguardrails.ogr.protocol.OpenAiChat.ensureStreamUsage(
            "{\"stream\":false}"), "not a stream");
        assertNull(com.openguardrails.ogr.protocol.OpenAiChat.ensureStreamUsage(
            "{\"stream\":true,\"stream_options\":{\"include_usage\":true}}"), "the client asked");
        String out = com.openguardrails.ogr.protocol.OpenAiChat.ensureStreamUsage(
            "{\"model\":\"m\",\"stream\":true}");
        assertTrue(Json.getBool(Json.parseOrNull(out), "stream_options.include_usage"));
        String merged = com.openguardrails.ogr.protocol.OpenAiChat.ensureStreamUsage(
            "{\"stream\":true,\"stream_options\":{\"other\":1}}");
        assertTrue(Json.getBool(Json.parseOrNull(merged), "stream_options.include_usage"));
        assertEquals(1, Json.getLong(Json.parseOrNull(merged), "stream_options.other", 0));
    }
}
