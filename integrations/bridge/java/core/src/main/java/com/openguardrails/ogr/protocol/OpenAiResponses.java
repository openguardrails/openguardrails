package com.openguardrails.ogr.protocol;

import com.openguardrails.ogr.Spans;
import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** OpenAI Responses — {@code llm_protocol: "openai.responses"}. */
public final class OpenAiResponses implements Protocol {

    @Override
    public String name() {
        return "openai.responses";
    }

    @Override
    public Claim claim(String path) {
        return Protocols.hasSuffix(path, "/responses") ? Claim.SERVE : Claim.IGNORE;
    }

    /**
     * ⚠️ Deliberately STRICTER than "has an {@code input}", because an embeddings request
     * has one too — {@code {"model":…,"input":"…"} } is a valid body of both APIs, and a
     * proxy that claims it reports a model turn for a call that never made one.
     *
     * <p>So a body matches only on something only this protocol has: {@code instructions},
     * {@code previous_response_id}, {@code max_output_tokens}, or an {@code input} ARRAY
     * of conversation ITEMS (embeddings batches an array of plain strings).
     *
     * <p>⚠️ The cost is real and accepted: a bare {@code {"model","input":"a string"}}
     * Responses call under a path this build does not recognise is declined and relayed
     * UNJUDGED rather than guessed at. The path {@code /v1/responses} covers every ordinary
     * mount; body matching is the fallback, and a fallback that guesses wrong files real
     * traffic under a protocol it is not.
     */
    @Override
    public boolean matchBody(Object body) {
        if (Json.getList(body, "messages") != null) {
            return false;
        }
        if (Json.get(body, "instructions") != null
            || Json.get(body, "previous_response_id") != null
            || Json.get(body, "max_output_tokens") != null) {
            return true;
        }
        List<Object> items = Json.getList(body, "input");
        return items != null && !items.isEmpty() && items.get(0) instanceof Map;
    }

    @Override
    public RequestFacts requestFacts(Object body) {
        return new RequestFacts(Json.str(body, "model"), Json.getBool(body, "stream"));
    }

    // ------------------------------------------------------------------ reading

    @Override
    public Output parseResponse(Object body) {
        StringBuilder text = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        List<Action> actions = new ArrayList<Action>();
        List<Object> items = Json.getList(body, "output");
        if (items != null) {
            for (Object item : items) {
                String type = Json.str(item, "type");
                if ("message".equals(type)) {
                    List<Object> parts = Json.getList(item, "content");
                    if (parts != null) {
                        for (Object part : parts) {
                            if ("output_text".equals(Json.str(part, "type"))) {
                                text.append(Json.str(part, "text"));
                            }
                        }
                    }
                } else if ("reasoning".equals(type)) {
                    List<Object> summary = Json.getList(item, "summary");
                    if (summary != null) {
                        for (Object s : summary) {
                            reasoning.append(Json.str(s, "text"));
                        }
                    }
                } else if ("function_call".equals(type)) {
                    actions.add(new Action(
                        Json.str(item, "call_id"),
                        Json.str(item, "name"),
                        Json.str(item, "arguments")));
                }
            }
        }
        return new Output(text.toString(), reasoning.toString(), actions, usageOf(Json.get(body, "usage")));
    }

    static Usage usageOf(Object u) {
        if (!(u instanceof Map)) {
            return null;
        }
        return new Usage(
            Json.getLong(u, "input_tokens", 0),
            Json.getLong(u, "output_tokens", 0),
            Json.getLong(u, "output_tokens_details.reasoning_tokens", 0),
            Json.getLong(u, "input_tokens_details.cached_tokens", 0),
            0);
    }

    // -------------------------------------------------------------- restoration

    @Override
    public String restore(String body, Map<String, String> mapping) {
        if (mapping == null || mapping.isEmpty()) {
            return body;
        }
        String out = body;
        int items = RawJson.arrayLength(out, "output");
        for (int i = 0; i < items; i++) {
            String item = "output." + i;
            String type = RawJson.stringAt(out, item + ".type");
            if ("message".equals(type)) {
                int parts = RawJson.arrayLength(out, item + ".content");
                for (int p = 0; p < parts; p++) {
                    out = Spans.restoreAt(out, item + ".content." + p + ".text", mapping);
                }
            } else if ("reasoning".equals(type)) {
                int parts = RawJson.arrayLength(out, item + ".summary");
                for (int p = 0; p < parts; p++) {
                    out = Spans.restoreAt(out, item + ".summary." + p + ".text", mapping);
                }
            } else if ("function_call".equals(type)) {
                out = Spans.restoreAt(out, item + ".arguments", mapping);
            }
        }
        return out;
    }

    // ----------------------------------------------------------------- refusals

    @Override
    public String refuse(String model, String reason) {
        Map<String, Object> body = response(model, reason, "incomplete", null);
        body.put("incomplete_details", Json.obj("reason", "content_filter"));
        return Json.write(body);
    }

    @Override
    public String refuseStream(String model, String reason) {
        return textStream(model, reason, "incomplete", null);
    }

    @Override
    public String retract(String model) {
        // Nothing more can be said about a response already in flight than that it ended
        // incomplete; the client's own state machine closes on `response.completed`.
        return SseFrames.event("response.incomplete", Json.write(Json.obj(
            "type", "response.incomplete",
            "response", Json.obj("id", "resp_ogr", "object", "response", "status", "incomplete",
                "incomplete_details", Json.obj("reason", "content_filter")))));
    }

    @Override
    public String softRefuse(String model, String notice) {
        return Json.write(response(model, notice, "completed",
            Refusals.xOgr(com.openguardrails.ogr.Continuation.ANSWER)));
    }

    @Override
    public String softRefuseStream(String model, String notice) {
        return textStream(model, notice, "completed",
            Refusals.xOgr(com.openguardrails.ogr.Continuation.ANSWER));
    }

    @Override
    public String retractSoft(String model, String notice) {
        return SseFrames.event("response.output_text.delta", Json.write(Json.obj(
                "type", "response.output_text.delta",
                "item_id", "msg_ogr", "output_index", Integer.valueOf(0),
                "content_index", Integer.valueOf(0), "delta", "\n\n" + notice)))
            + SseFrames.event("response.completed", Json.write(Json.obj(
                "type", "response.completed",
                "response", Json.obj("id", "resp_ogr", "object", "response", "status", "completed"))));
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
        // ⚠️ Appended by byte insertion: every surviving item is the model's own output and
        // reaches the client exactly as the provider wrote it.
        List<Object> content = new ArrayList<Object>();
        content.add(Json.obj("type", "output_text", "text", notice, "annotations", new ArrayList<Object>()));
        String next = RawJson.appendArrayElement(out, "output",
            Json.write(Json.obj("type", "message", "id", "msg_ogr_notice", "role", "assistant",
                "status", "completed", "content", content)));
        if (next == null) {
            return null;
        }
        out = next;
        next = RawJson.putMember(out, "", "x_ogr", Refusals.xOgr(com.openguardrails.ogr.Continuation.DROP_CALLS));
        return next == null ? out : next;
    }

    private static Map<String, Object> response(String model, String text, String status, String xOgr) {
        List<Object> content = new ArrayList<Object>();
        content.add(Json.obj("type", "output_text", "text", text, "annotations", new ArrayList<Object>()));
        List<Object> output = new ArrayList<Object>();
        output.add(Json.obj("type", "message", "id", "msg_ogr_refusal", "role", "assistant",
            "status", "completed", "content", content));
        Map<String, Object> body = Json.obj(
            "id", "resp_ogr_refusal",
            "object", "response",
            "model", model,
            "status", status,
            "output", output,
            "usage", Json.obj("input_tokens", Integer.valueOf(0), "output_tokens", Integer.valueOf(0)));
        if (xOgr != null) {
            body.put("x_ogr", Json.raw(xOgr));
        }
        return body;
    }

    private static String textStream(String model, String text, String status, String xOgr) {
        Map<String, Object> finalResponse = response(model, text, status, xOgr);
        StringBuilder sb = new StringBuilder();
        sb.append(SseFrames.event("response.created", Json.write(Json.obj(
            "type", "response.created",
            "response", Json.obj("id", "resp_ogr_refusal", "object", "response",
                "model", model, "status", "in_progress")))));
        sb.append(SseFrames.event("response.output_item.added", Json.write(Json.obj(
            "type", "response.output_item.added", "output_index", Integer.valueOf(0),
            "item", Json.obj("type", "message", "id", "msg_ogr_refusal", "role", "assistant",
                "status", "in_progress", "content", new ArrayList<Object>())))));
        sb.append(SseFrames.event("response.output_text.delta", Json.write(Json.obj(
            "type", "response.output_text.delta", "item_id", "msg_ogr_refusal",
            "output_index", Integer.valueOf(0), "content_index", Integer.valueOf(0),
            "delta", text))));
        sb.append(SseFrames.event("response.output_text.done", Json.write(Json.obj(
            "type", "response.output_text.done", "item_id", "msg_ogr_refusal",
            "output_index", Integer.valueOf(0), "content_index", Integer.valueOf(0),
            "text", text))));
        String terminal = "completed".equals(status) ? "response.completed" : "response.incomplete";
        sb.append(SseFrames.event(terminal, Json.write(Json.obj(
            "type", terminal, "response", finalResponse))));
        return sb.toString();
    }

    // ---------------------------------------------------------------- streaming

    @Override
    public StreamDecoder newDecoder(Map<String, String> restoreMapping) {
        return new ResponsesDecoder(restoreMapping);
    }

    private static final class Item {
        String type = "";
        String callId = "";
        String name = "";
        final StringBuilder arguments = new StringBuilder();
        Restorer restorer;
    }

    private static final class ResponsesDecoder implements StreamDecoder {
        private final Map<String, String> mapping;
        private final StringBuilder text = new StringBuilder();
        private final StringBuilder reasoning = new StringBuilder();
        private final Map<Integer, Item> items = new TreeMap<Integer, Item>();
        private final Restorer textRestorer;
        private final Restorer reasoningRestorer;
        private Usage usage;
        private int frames;

        ResponsesDecoder(Map<String, String> mapping) {
            this.mapping = mapping;
            this.textRestorer = new Restorer(mapping);
            this.reasoningRestorer = new Restorer(mapping);
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
            if (!type.startsWith("response.")) {
                return FrameResult.passthrough(frame);
            }
            frames++;

            if ("response.completed".equals(type) || "response.incomplete".equals(type)) {
                Usage u = usageOf(Json.get(parsed, "response.usage"));
                if (u != null) {
                    usage = u;
                }
                return FrameResult.passthrough(frame);
            }
            if ("response.output_item.added".equals(type)) {
                int index = (int) Json.getLong(parsed, "output_index", 0);
                Item item = new Item();
                item.type = Json.str(parsed, "item.type");
                item.callId = Json.str(parsed, "item.call_id");
                item.name = Json.str(parsed, "item.name");
                item.restorer = new Restorer(mapping);
                items.put(Integer.valueOf(index), item);
                return new FrameResult(frame, 0, "function_call".equals(item.type));
            }

            String field;
            boolean isCall = false;
            if ("response.output_text.delta".equals(type)) {
                field = "delta";
            } else if ("response.reasoning_summary_text.delta".equals(type)
                || "response.reasoning_text.delta".equals(type)) {
                field = "delta";
            } else if ("response.function_call_arguments.delta".equals(type)) {
                field = "delta";
                isCall = true;
            } else {
                return FrameResult.passthrough(frame);
            }

            String piece = Json.str(parsed, field);
            if (piece.isEmpty()) {
                return FrameResult.passthrough(frame);
            }
            Restorer restorer;
            if (isCall) {
                int index = (int) Json.getLong(parsed, "output_index", 0);
                Item item = items.get(Integer.valueOf(index));
                if (item == null) {
                    item = new Item();
                    item.type = "function_call";
                    item.restorer = new Restorer(mapping);
                    items.put(Integer.valueOf(index), item);
                }
                item.arguments.append(piece);
                restorer = item.restorer;
            } else if ("response.output_text.delta".equals(type)) {
                text.append(piece);
                restorer = textRestorer;
            } else {
                reasoning.append(piece);
                restorer = reasoningRestorer;
            }

            String emit = restorer.feed(piece);
            String out = frame;
            if (!emit.equals(piece)) {
                String next = RawJson.replaceStringValue(data, field, emit);
                if (next != null) {
                    out = SseFrames.event(type, next);
                }
            }
            return new FrameResult(out, SseFrames.utf8Length(emit), isCall);
        }

        @Override
        public String flush() {
            StringBuilder out = new StringBuilder();
            String tail = textRestorer.flush();
            if (!tail.isEmpty()) {
                out.append(SseFrames.event("response.output_text.delta", Json.write(Json.obj(
                    "type", "response.output_text.delta", "item_id", "msg_ogr",
                    "output_index", Integer.valueOf(0), "content_index", Integer.valueOf(0),
                    "delta", tail))));
            }
            String r = reasoningRestorer.flush();
            if (!r.isEmpty()) {
                out.append(SseFrames.event("response.reasoning_summary_text.delta", Json.write(Json.obj(
                    "type", "response.reasoning_summary_text.delta",
                    "output_index", Integer.valueOf(0), "summary_index", Integer.valueOf(0),
                    "delta", r))));
            }
            for (Map.Entry<Integer, Item> e : items.entrySet()) {
                Item item = e.getValue();
                String rest = item.restorer == null ? "" : item.restorer.flush();
                if (rest.isEmpty()) {
                    continue;
                }
                out.append(SseFrames.event("response.function_call_arguments.delta", Json.write(Json.obj(
                    "type", "response.function_call_arguments.delta",
                    "output_index", e.getKey(), "delta", rest))));
            }
            return out.toString();
        }

        @Override
        public Output output() {
            List<Action> actions = new ArrayList<Action>();
            for (Item item : items.values()) {
                if ("function_call".equals(item.type)) {
                    actions.add(new Action(item.callId, item.name, item.arguments.toString()));
                }
            }
            return new Output(text.toString(), reasoning.toString(), actions, usage);
        }

        @Override
        public int recognizedFrames() {
            return frames;
        }
    }
}
