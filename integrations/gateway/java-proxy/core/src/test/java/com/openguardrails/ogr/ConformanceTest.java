package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.protocol.FrameResult;
import com.openguardrails.ogr.protocol.Output;
import com.openguardrails.ogr.protocol.Protocol;
import com.openguardrails.ogr.protocol.Protocols;
import com.openguardrails.ogr.protocol.SseFrames;
import com.openguardrails.ogr.protocol.StreamDecoder;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ONE conversation, written three times — the same assertions against every protocol.
 *
 * <p>Adding a protocol means adding a row here. That single row checks detection from a
 * path and from a body, buffered reading, streamed reassembly, every refusal shape, the
 * drop-calls continuation and placeholder restoration — which is most of what an adapter
 * can get wrong.
 */
class ConformanceTest {

    // --- the same conversation, three times -----------------------------------

    private static final String CHAT_REQUEST = "{\"model\":\"gpt-5\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}";
    private static final String CHAT_RESPONSE = "{\"id\":\"chatcmpl-1\",\"object\":\"chat.completion\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Hello\",\"reasoning_content\":\"think\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\": \\\"ls /srv/reports\\\"}\"}},{\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\": \\\"rm -rf /\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}";
    private static final String CHAT_FRAMES = "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"think\"}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\": \"}}]}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"ls /srv/reports\\\"}\"}}]}}]}\n\ndata: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n";

    private static final String ANTHROPIC_REQUEST = "{\"model\":\"claude-sonnet-4-5\",\"max_tokens\":64,\"system\":\"be good\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}";
    private static final String ANTHROPIC_RESPONSE = "{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"think\"},{\"type\":\"text\",\"text\":\"Hello\"},{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"bash\",\"input\":{\"cmd\":\"ls /srv/reports\"}},{\"type\":\"tool_use\",\"id\":\"toolu_2\",\"name\":\"bash\",\"input\":{\"cmd\":\"rm -rf /\"}}],\"stop_reason\":\"tool_use\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}";
    private static final String ANTHROPIC_FRAMES = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"think\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"bash\",\"input\":{}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\": \"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"ls /srv/reports\\\"}\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    private static final String RESPONSES_REQUEST = "{\"model\":\"gpt-5\",\"input\":\"hi\",\"instructions\":\"be good\"}";
    private static final String RESPONSES_RESPONSE = "{\"id\":\"resp_1\",\"object\":\"response\",\"model\":\"gpt-5\",\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"think\"}]},{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\",\"annotations\":[]}]},{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\": \\\"ls /srv/reports\\\"}\"},{\"type\":\"function_call\",\"id\":\"fc_2\",\"call_id\":\"call_2\",\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\": \\\"rm -rf /\\\"}\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}";
    private static final String RESPONSES_FRAMES = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"model\":\"gpt-5\",\"status\":\"in_progress\"}}\n\nevent: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"summary_index\":0,\"delta\":\"think\"}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":1,\"content_index\":0,\"delta\":\"Hel\"}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":1,\"content_index\":0,\"delta\":\"lo\"}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"bash\",\"arguments\":\"\"}}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":2,\"delta\":\"{\\\"cmd\\\": \"}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":2,\"delta\":\"\\\"ls /srv/reports\\\"}\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n\n";

    /** The whole argument of the first tool call, and the value a redaction would mask. */
    private static final String ARGUMENTS = "{\"cmd\": \"ls /srv/reports\"}";
    private static final String SECRET = "/srv/reports";

    private static final class Case {
        final String protocol;
        final String path;
        final String request;
        final String response;
        final String frames;
        /** Where the SECOND tool call sits in this protocol's response body. */
        final String secondCallPath;

        Case(String protocol, String path, String request, String response, String frames,
             String secondCallPath) {
            this.protocol = protocol;
            this.path = path;
            this.request = request;
            this.response = response;
            this.frames = frames;
            this.secondCallPath = secondCallPath;
        }
    }

    private static List<Case> cases() {
        return Arrays.asList(
            new Case("openai.chat", "/v1/chat/completions",
                CHAT_REQUEST, CHAT_RESPONSE, CHAT_FRAMES, "choices.0.message.tool_calls.1"),
            new Case("anthropic.messages", "/v1/messages",
                ANTHROPIC_REQUEST, ANTHROPIC_RESPONSE, ANTHROPIC_FRAMES, "content.3"),
            new Case("openai.responses", "/v1/responses",
                RESPONSES_REQUEST, RESPONSES_RESPONSE, RESPONSES_FRAMES, "output.3"));
    }

    @Test
    void detectsFromThePathAndFromTheBody() {
        for (Case c : cases()) {
            Protocol byPath = Protocols.detect(c.path, null);
            assertNotNull(byPath, c.protocol + ": path");
            assertEquals(c.protocol, byPath.name(), c.protocol + ": path");

            Protocol byBody = Protocols.detect("/some/unknown/mount", Json.parseOrNull(c.request));
            assertNotNull(byBody, c.protocol + ": body");
            assertEquals(c.protocol, byBody.name(), c.protocol + ": body");
        }
    }

    @Test
    void readsABufferedReply() {
        for (Case c : cases()) {
            Protocol p = Protocols.byName(c.protocol);
            Output out = p.parseResponse(Json.parseOrNull(c.response));
            assertEquals("Hello", out.text, c.protocol);
            assertEquals("think", out.reasoning, c.protocol);
            assertEquals(2, out.actions.size(), c.protocol);
            assertEquals("bash", out.actions.get(0).name, c.protocol);
            assertTrue(out.actions.get(0).arguments.contains(SECRET), c.protocol);
            assertNotNull(out.usage, c.protocol);
            assertEquals(10, out.usage.inputTokens, c.protocol);
            assertEquals(5, out.usage.outputTokens, c.protocol);
            assertFalse(out.isEmpty(), c.protocol);
        }
    }

    /** The streamed reply must reassemble to what the buffered one says, field for field. */
    @Test
    void reassemblesAStreamedReply() {
        for (Case c : cases()) {
            Protocol p = Protocols.byName(c.protocol);
            StreamDecoder decoder = p.newDecoder(Collections.<String, String>emptyMap());
            int frames = 0;
            for (String frame : split(c.frames)) {
                FrameResult r = decoder.frame(frame);
                assertEquals(frame, r.out,
                    c.protocol + ": an unrewritten frame must pass through byte for byte");
                frames++;
            }
            assertTrue(frames > 3, c.protocol);
            Output out = decoder.output();
            assertEquals("Hello", out.text, c.protocol);
            assertEquals("think", out.reasoning, c.protocol);
            assertEquals(1, out.actions.size(), c.protocol);
            assertEquals("bash", out.actions.get(0).name, c.protocol);
            assertEquals(ARGUMENTS, out.actions.get(0).arguments, c.protocol);
            assertTrue(decoder.recognizedFrames() > 0, c.protocol);
            assertEquals("", decoder.flush(), c.protocol + ": nothing to restore, nothing held");
        }
    }

    /**
     * ⚠️ A refused caller handed ANOTHER protocol's document sees a broken proxy, not a
     * policy decision — and many agent harnesses retry a malformed reply, turning one
     * refusal into a storm. So every refusal shape must round-trip through the parser of
     * the protocol that asked for it.
     */
    @Test
    void aRefusalIsReadableByTheProtocolThatAskedForIt() {
        for (Case c : cases()) {
            Protocol p = Protocols.byName(c.protocol);

            Output hard = p.parseResponse(Json.parseOrNull(p.refuse("m", "refused")));
            assertEquals("refused", hard.text, c.protocol + ": hard refusal");

            Output soft = p.parseResponse(Json.parseOrNull(p.softRefuse("m", "notice")));
            assertEquals("notice", soft.text, c.protocol + ": soft refusal");

            assertEquals("refused", decode(p, p.refuseStream("m", "refused")).text,
                c.protocol + ": hard refusal stream");
            assertEquals("notice", decode(p, p.softRefuseStream("m", "notice")).text,
                c.protocol + ": soft refusal stream");
            assertFalse(p.retract("m").isEmpty(), c.protocol);
            assertTrue(decode(p, p.retractSoft("m", "notice")).text.contains("notice"), c.protocol);
        }
    }

    /**
     * ⚠️⚠️ ALL OR NOTHING. A partial drop forwards some refused calls under a notice saying
     * they were refused — the failure that is worse than either honest answer, because it
     * looks like it worked.
     */
    @Test
    void dropsTheNamedCallAndKeepsTheOthers() {
        for (Case c : cases()) {
            Protocol p = Protocols.byName(c.protocol);

            String dropped = p.dropCalls(c.response,
                Collections.singletonList(c.secondCallPath), "that action was refused");
            assertNotNull(dropped, c.protocol + ": drop_calls must resolve");
            Output out = p.parseResponse(Json.parseOrNull(dropped));
            assertEquals(1, out.actions.size(), c.protocol);
            assertTrue(out.actions.get(0).arguments.contains(SECRET),
                c.protocol + ": the surviving call is the one the policy allowed");
            assertFalse(dropped.contains("rm -rf"), c.protocol + ": the refused call is gone");
            assertTrue(out.text.contains("that action was refused"),
                c.protocol + ": the notice must reach the model");
            assertTrue(out.text.startsWith("Hello"),
                c.protocol + ": the model's own words stay first");
            assertTrue(dropped.contains("x_ogr"), c.protocol);

            assertNull(p.dropCalls(c.response, Collections.singletonList(c.secondCallPath + "9"), "n"),
                c.protocol + ": an unresolvable path must refuse the whole reply");
            assertNull(p.dropCalls(c.response, Collections.singletonList("not-an-index"), "n"),
                c.protocol);
        }
    }

    /** A value masked in the request comes back through the reply, arguments included. */
    @Test
    void restoresPlaceholdersInAReply() {
        Map<String, String> mapping = new LinkedHashMap<String, String>();
        mapping.put("OGRKR0000001", SECRET);
        for (Case c : cases()) {
            Protocol p = Protocols.byName(c.protocol);
            String masked = c.response.replace("Hello", "Reading OGRKR0000001")
                .replace(SECRET, "OGRKR0000001");
            String restored = p.restore(masked, mapping);
            Output out = p.parseResponse(Json.parseOrNull(restored));
            assertEquals("Reading " + SECRET, out.text, c.protocol);
            assertTrue(out.actions.get(0).arguments.contains(SECRET),
                c.protocol + ": tool arguments are the half that matters");
            assertFalse(restored.contains("OGRKR0000001"), c.protocol);
        }
    }

    private static Output decode(Protocol p, String sse) {
        StreamDecoder d = p.newDecoder(Collections.<String, String>emptyMap());
        for (String frame : split(sse)) {
            d.frame(frame);
        }
        return d.output();
    }

    static List<String> split(String sse) {
        SseFrames frames = new SseFrames();
        byte[] bytes = sse.getBytes(StandardCharsets.UTF_8);
        List<String> out = new ArrayList<String>(frames.feed(bytes, bytes.length));
        String rest = frames.remainder();
        if (!rest.isEmpty()) {
            out.add(rest);
        }
        return out;
    }
}
