package com.openguardrails.ogr.protocol;

import com.openguardrails.ogr.Spans;
import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Anthropic Messages — {@code llm_protocol: "anthropic.messages"}. */
public final class AnthropicMessages implements Protocol {

    @Override
    public String name() {
        return "anthropic.messages";
    }

    @Override
    public Claim claim(String path) {
        /*
         * ⚠️ count_tokens is REJECTED, not ignored. Its body is a valid messages body, so
         * falling through to shape matching would read it as a conversation and report a
         * turn that never happened — and a turn reported for a request that never reached
         * a model is a record nobody can reconcile.
         */
        if (Protocols.hasSuffix(path, "/messages/count_tokens")) {
            return Claim.REJECT;
        }
        return Protocols.hasSuffix(path, "/messages") ? Claim.SERVE : Claim.IGNORE;
    }

    @Override
    public boolean matchBody(Object body) {
        // `system` or `max_tokens` beside `messages` is what tells this apart from an
        // openai.chat body, whose test ("has a messages array") this body also passes.
        return Json.getList(body, "messages") != null
            && (Json.get(body, "system") != null || Json.get(body, "max_tokens") != null);
    }

    @Override
    public RequestFacts requestFacts(Object body) {
        return new RequestFacts(Json.str(body, "model"), Json.getBool(body, "stream"));
    }

    // ------------------------------------------------------------------ reading

    @Override
    public Output parseResponse(Object body) {
        StringBuilder text = new StringBuilder();
        StringBuilder thinking = new StringBuilder();
        List<Action> actions = new ArrayList<Action>();
        List<Object> blocks = Json.getList(body, "content");
        if (blocks != null) {
            for (Object b : blocks) {
                String type = Json.str(b, "type");
                if ("text".equals(type)) {
                    text.append(Json.str(b, "text"));
                } else if ("thinking".equals(type)) {
                    thinking.append(Json.str(b, "thinking"));
                } else if ("tool_use".equals(type)) {
                    // ⚠️ This protocol carries arguments as a real OBJECT, which is why its
                    // verdict spans keep their offsets where openai.chat's cannot: the
                    // judged string is a verbatim leaf of the transported body.
                    Object input = Json.get(b, "input");
                    actions.add(new Action(Json.str(b, "id"), Json.str(b, "name"),
                        input == null ? "" : Json.write(input)));
                }
                // A block type this build does not know is DROPPED, not failed on.
            }
        }
        return new Output(text.toString(), thinking.toString(), actions, usageOf(Json.get(body, "usage")));
    }

    static Usage usageOf(Object u) {
        if (!(u instanceof Map)) {
            return null;
        }
        return new Usage(
            Json.getLong(u, "input_tokens", 0),
            Json.getLong(u, "output_tokens", 0),
            0,
            Json.getLong(u, "cache_read_input_tokens", 0),
            Json.getLong(u, "cache_creation_input_tokens", 0));
    }

    // -------------------------------------------------------------- restoration

    @Override
    public String restore(String body, Map<String, String> mapping) {
        if (mapping == null || mapping.isEmpty()) {
            return body;
        }
        String out = body;
        int blocks = RawJson.arrayLength(out, "content");
        for (int i = 0; i < blocks; i++) {
            String path = "content." + i;
            String type = RawJson.stringAt(out, path + ".type");
            if ("text".equals(type)) {
                out = Spans.restoreAt(out, path + ".text", mapping);
            } else if ("thinking".equals(type)) {
                out = Spans.restoreAt(out, path + ".thinking", mapping);
            } else if ("tool_use".equals(type)) {
                out = Spans.restoreRawAt(out, path + ".input", mapping);
            }
        }
        return out;
    }

    // ----------------------------------------------------------------- refusals

    @Override
    public String refuse(String model, String reason) {
        return message(model, reason, "refusal", null);
    }

    @Override
    public String refuseStream(String model, String reason) {
        return openStream(model)
            + SseFrames.event("content_block_delta", Json.write(Json.obj(
                "type", "content_block_delta", "index", Integer.valueOf(0),
                "delta", Json.obj("type", "text_delta", "text", reason))))
            + SseFrames.event("content_block_stop", Json.write(Json.obj(
                "type", "content_block_stop", "index", Integer.valueOf(0))))
            + endStream("refusal");
    }

    @Override
    public String retract(String model) {
        return endStream("refusal");
    }

    @Override
    public String softRefuse(String model, String notice) {
        return message(model, notice, "end_turn", Refusals.xOgr(com.openguardrails.ogr.Continuation.ANSWER));
    }

    @Override
    public String softRefuseStream(String model, String notice) {
        return openStream(model)
            + SseFrames.event("content_block_delta", Json.write(Json.obj(
                "type", "content_block_delta", "index", Integer.valueOf(0),
                "delta", Json.obj("type", "text_delta", "text", notice))))
            + SseFrames.event("content_block_stop", Json.write(Json.obj(
                "type", "content_block_stop", "index", Integer.valueOf(0))))
            + endStream("end_turn");
    }

    @Override
    public String retractSoft(String model, String notice) {
        /*
         * A stream already in flight has open content blocks at indexes this proxy does
         * not track from the outside, so the notice goes in a FRESH block at a high index
         * rather than into whichever one happens to be open. Closing a block that was
         * never opened is a protocol error the client surfaces as a broken stream.
         */
        int index = 99;
        return SseFrames.event("content_block_start", Json.write(Json.obj(
                "type", "content_block_start", "index", Integer.valueOf(index),
                "content_block", Json.obj("type", "text", "text", ""))))
            + SseFrames.event("content_block_delta", Json.write(Json.obj(
                "type", "content_block_delta", "index", Integer.valueOf(index),
                "delta", Json.obj("type", "text_delta", "text", "\n\n" + notice))))
            + SseFrames.event("content_block_stop", Json.write(Json.obj(
                "type", "content_block_stop", "index", Integer.valueOf(index))))
            + endStream("end_turn");
    }

    @Override
    public String dropCalls(String body, List<String> paths, String notice) {
        Map<String, List<Integer>> groups = Refusals.dropGroups(paths);
        if (groups == null) {
            return null;
        }
        String out = body;
        for (Map.Entry<String, List<Integer>> g : groups.entrySet()) {
            String next = RawJson.removeArrayElements(out, g.getKey(), g.getValue());
            if (next == null) {
                return null;
            }
            out = next;
        }
        int blocks = RawJson.arrayLength(out, "content");
        if (blocks < 0) {
            return null;
        }
        boolean toolsRemain = false;
        for (int i = 0; i < blocks; i++) {
            if ("tool_use".equals(RawJson.stringAt(out, "content." + i + ".type"))) {
                toolsRemain = true;
                break;
            }
        }
        // The notice is its own text block, APPENDED: this protocol's content is a LIST,
        // so there is no single prose field to extend and inventing one would change what
        // the client renders. ⚠️ Appended by byte insertion, so every surviving block —
        // the model's own output — reaches the client exactly as the provider wrote it.
        String next = RawJson.appendArrayElement(out, "content",
            Json.write(Json.obj("type", "text", "text", notice)));
        if (next == null) {
            return null;
        }
        out = next;
        next = RawJson.putMember(out, "", "stop_reason", Json.write(toolsRemain ? "tool_use" : "end_turn"));
        if (next != null) {
            out = next;
        }
        next = RawJson.putMember(out, "", "x_ogr", Refusals.xOgr(com.openguardrails.ogr.Continuation.DROP_CALLS));
        return next == null ? out : next;
    }

    private static String message(String model, String text, String stopReason, String xOgr) {
        List<Object> content = new ArrayList<Object>();
        content.add(Json.obj("type", "text", "text", text));
        Map<String, Object> body = Json.obj(
            "id", "msg_ogr_refusal",
            "type", "message",
            "role", "assistant",
            "model", model,
            "content", content,
            "stop_reason", stopReason,
            "usage", Json.obj("input_tokens", Integer.valueOf(0), "output_tokens", Integer.valueOf(0)));
        if (xOgr != null) {
            body.put("x_ogr", Json.raw(xOgr));
        }
        return Json.write(body);
    }

    private static String openStream(String model) {
        return SseFrames.event("message_start", Json.write(Json.obj(
                "type", "message_start",
                "message", Json.obj("id", "msg_ogr_refusal", "type", "message", "role", "assistant",
                    "model", model, "content", new ArrayList<Object>(),
                    "usage", Json.obj("input_tokens", Integer.valueOf(0), "output_tokens", Integer.valueOf(0))))))
            + SseFrames.event("content_block_start", Json.write(Json.obj(
                "type", "content_block_start", "index", Integer.valueOf(0),
                "content_block", Json.obj("type", "text", "text", ""))));
    }

    private static String endStream(String stopReason) {
        return SseFrames.event("message_delta", Json.write(Json.obj(
                "type", "message_delta",
                "delta", Json.obj("stop_reason", stopReason),
                "usage", Json.obj("output_tokens", Integer.valueOf(0)))))
            + SseFrames.event("message_stop", Json.write(Json.obj("type", "message_stop")));
    }

    // ---------------------------------------------------------------- streaming

    @Override
    public StreamDecoder newDecoder(Map<String, String> restoreMapping) {
        return new MessagesDecoder(restoreMapping);
    }

    private static final class Block {
        String type = "";
        String id = "";
        String name = "";
        final StringBuilder buffer = new StringBuilder();
        Restorer restorer;
    }

    private static final class MessagesDecoder implements StreamDecoder {
        private final Map<String, String> mapping;
        private final Map<Integer, Block> blocks = new TreeMap<Integer, Block>();
        private int frames;
        private long inputTokens;
        private long outputTokens;
        private long cacheRead;
        private long cacheWrite;
        private boolean sawUsage;

        MessagesDecoder(Map<String, String> mapping) {
            this.mapping = mapping;
        }

        @Override
        public FrameResult frame(String frame) {
            String data = SseFrames.dataOf(frame);
            if (data == null) {
                return FrameResult.passthrough(frame);
            }
            Object parsed = Json.parseOrNull(data);
            if (parsed == null) {
                return FrameResult.passthrough(frame);
            }
            String type = Json.str(parsed, "type");
            if (type.isEmpty()) {
                return FrameResult.passthrough(frame);
            }
            frames++;

            if ("message_start".equals(type)) {
                Object u = Json.get(parsed, "message.usage");
                if (u instanceof Map) {
                    sawUsage = true;
                    inputTokens = Json.getLong(u, "input_tokens", 0);
                    cacheRead = Json.getLong(u, "cache_read_input_tokens", 0);
                    cacheWrite = Json.getLong(u, "cache_creation_input_tokens", 0);
                }
                return FrameResult.passthrough(frame);
            }
            if ("message_delta".equals(type)) {
                Object u = Json.get(parsed, "usage");
                if (u instanceof Map) {
                    sawUsage = true;
                    outputTokens = Json.getLong(u, "output_tokens", outputTokens);
                }
                return FrameResult.passthrough(frame);
            }
            if ("content_block_start".equals(type)) {
                int index = (int) Json.getLong(parsed, "index", 0);
                Block b = new Block();
                b.type = Json.str(parsed, "content_block.type");
                b.id = Json.str(parsed, "content_block.id");
                b.name = Json.str(parsed, "content_block.name");
                b.restorer = new Restorer(mapping);
                blocks.put(Integer.valueOf(index), b);
                // A tool_use block ANNOUNCES a call before any argument byte arrives.
                return new FrameResult(frame, 0, "tool_use".equals(b.type));
            }
            if (!"content_block_delta".equals(type)) {
                return FrameResult.passthrough(frame);
            }

            int index = (int) Json.getLong(parsed, "index", 0);
            Block b = blocks.get(Integer.valueOf(index));
            if (b == null) {
                b = new Block();
                b.restorer = new Restorer(mapping);
                blocks.put(Integer.valueOf(index), b);
            }
            String deltaType = Json.str(parsed, "delta.type");
            String field;
            if ("text_delta".equals(deltaType)) {
                field = "text";
            } else if ("thinking_delta".equals(deltaType)) {
                field = "thinking";
            } else if ("input_json_delta".equals(deltaType)) {
                field = "partial_json";
            } else {
                // signature_delta and anything newer: carried through, counted as nothing.
                return FrameResult.passthrough(frame);
            }
            String piece = Json.str(parsed, "delta." + field);
            if (piece.isEmpty()) {
                return FrameResult.passthrough(frame);
            }
            b.buffer.append(piece);
            if (b.type.isEmpty()) {
                b.type = "text_delta".equals(deltaType) ? "text"
                    : "thinking_delta".equals(deltaType) ? "thinking" : "tool_use";
            }
            String emit = b.restorer.feed(piece);
            String rewritten = data;
            if (!emit.equals(piece)) {
                String next = RawJson.replaceStringValue(data, "delta." + field, emit);
                if (next != null) {
                    rewritten = next;
                }
            }
            boolean carriesCalls = "input_json_delta".equals(deltaType);
            int bytes = SseFrames.utf8Length(emit);
            String out = rewritten.equals(data) ? frame : SseFrames.event(type, rewritten);
            return new FrameResult(out, bytes, carriesCalls);
        }

        @Override
        public String flush() {
            StringBuilder out = new StringBuilder();
            for (Map.Entry<Integer, Block> e : blocks.entrySet()) {
                Block b = e.getValue();
                String rest = b.restorer == null ? "" : b.restorer.flush();
                if (rest.isEmpty()) {
                    continue;
                }
                String deltaType = "tool_use".equals(b.type) ? "input_json_delta"
                    : "thinking".equals(b.type) ? "thinking_delta" : "text_delta";
                String field = "tool_use".equals(b.type) ? "partial_json"
                    : "thinking".equals(b.type) ? "thinking" : "text";
                out.append(SseFrames.event("content_block_delta", Json.write(Json.obj(
                    "type", "content_block_delta", "index", e.getKey(),
                    "delta", Json.obj("type", deltaType, field, rest)))));
            }
            return out.toString();
        }

        @Override
        public Output output() {
            StringBuilder text = new StringBuilder();
            StringBuilder thinking = new StringBuilder();
            List<Action> actions = new ArrayList<Action>();
            for (Block b : blocks.values()) {
                if ("tool_use".equals(b.type)) {
                    actions.add(new Action(b.id, b.name, b.buffer.toString()));
                } else if ("thinking".equals(b.type)) {
                    thinking.append(b.buffer);
                } else {
                    text.append(b.buffer);
                }
            }
            Usage usage = sawUsage
                ? new Usage(inputTokens, outputTokens, 0, cacheRead, cacheWrite)
                : null;
            return new Output(text.toString(), thinking.toString(), actions, usage);
        }

        @Override
        public int recognizedFrames() {
            return frames;
        }
    }
}
