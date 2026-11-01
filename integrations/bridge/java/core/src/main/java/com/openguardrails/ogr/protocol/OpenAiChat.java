package com.openguardrails.ogr.protocol;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.json.RawJson;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** OpenAI Chat Completions — {@code llm_protocol: "openai.chat"}. */
public final class OpenAiChat implements Protocol {

    /**
     * ⚠️⚠️ ONE LIST, EVERY READER: the parse, the stream accumulator, the buffered
     * restore and the streamed restore all walk this.
     *
     * <p>A reasoning model's thinking arrives under {@code reasoning_content} (DeepSeek,
     * vLLM) or under {@code reasoning} (OpenRouter's normalisation, the qwen family) — a
     * vendor sends ONE — and a reader that knows only one spelling reads a pure-reasoning
     * reply as EMPTY. That counts the whole response half unreadable on an observe
     * deployment and REFUSES it under fail-closed, and the placeholders in it are never
     * restored, so a redacted value comes back to the user as {@code ${OGR_PHONE_1}} in
     * the thinking pane. Both halves of that failure came from one missed spelling in
     * one {@code if}.
     */
    static final String[] REASONING_FIELDS = {"reasoning_content", "reasoning"};

    @Override
    public String name() {
        return "openai.chat";
    }

    @Override
    public Claim claim(String path) {
        return Protocols.hasSuffix(path, "/chat/completions") ? Claim.SERVE : Claim.IGNORE;
    }

    @Override
    public boolean matchBody(Object body) {
        return Json.getList(body, "messages") != null;
    }

    @Override
    public RequestFacts requestFacts(Object body) {
        return new RequestFacts(Json.str(body, "model"), Json.getBool(body, "stream"));
    }

    // ------------------------------------------------------------------ reading

    @Override
    public Output parseResponse(Object body) {
        Object msg = Json.get(body, "choices.0.message");
        if (msg == null) {
            return new Output("", "", null, usageOf(Json.get(body, "usage")));
        }
        String reasoning = "";
        for (String field : REASONING_FIELDS) {
            String v = Json.str(msg, field);
            if (!v.isEmpty()) {
                reasoning = v;
                break;
            }
        }
        List<Action> actions = new ArrayList<Action>();
        List<Object> calls = Json.getList(msg, "tool_calls");
        if (calls != null) {
            for (Object c : calls) {
                actions.add(new Action(
                    Json.str(c, "id"),
                    Json.str(c, "function.name"),
                    // ⚠️ `arguments` is transported JSON-ENCODED in this protocol, so the
                    // raw value here is the STRING the model produced, not an object.
                    Json.str(c, "function.arguments")));
            }
        }
        return new Output(Json.str(msg, "content"), reasoning, actions, usageOf(Json.get(body, "usage")));
    }

    /**
     * Transcribes the usage object. {@code usage: null} — what every streamed chunk
     * before the final one carries under {@code include_usage} — is not an object and
     * correctly reads as "nothing reported".
     */
    static Usage usageOf(Object u) {
        if (!(u instanceof Map)) {
            return null;
        }
        return new Usage(
            Json.getLong(u, "prompt_tokens", 0),
            Json.getLong(u, "completion_tokens", 0),
            Json.getLong(u, "completion_tokens_details.reasoning_tokens", 0),
            Json.getLong(u, "prompt_tokens_details.cached_tokens", 0),
            0);
    }

    /**
     * Opts a streaming request into usage reporting.
     *
     * <p>This is the one protocol of the three that OMITS token counts from a stream
     * unless the REQUEST asked. Returns {@code null} when nothing was changed — the
     * request is not a stream, or the client already opted in. A non-null answer means
     * THIS PROXY injected the opt-in, and the extra usage-only frame is then ours to
     * swallow rather than the client's to parse.
     */
    public static String ensureStreamUsage(String body) {
        Object parsed = Json.parseOrNull(body);
        if (parsed == null || !Json.getBool(parsed, "stream")) {
            return null;
        }
        if (Json.getBool(parsed, "stream_options.include_usage")) {
            return null;
        }
        if (Json.get(parsed, "stream_options") instanceof Map) {
            return RawJson.putMember(body, "stream_options", "include_usage", "true");
        }
        return RawJson.putMember(body, "", "stream_options", "{\"include_usage\":true}");
    }

    // -------------------------------------------------------------- restoration

    @Override
    public String restore(String body, Map<String, String> mapping) {
        if (mapping == null || mapping.isEmpty()) {
            return body;
        }
        String out = body;
        int choices = Math.max(1, RawJson.arrayLength(out, "choices"));
        for (int c = 0; c < choices; c++) {
            String msg = "choices." + c + ".message";
            out = com.openguardrails.ogr.Spans.restoreAt(out, msg + ".content", mapping);
            for (String field : REASONING_FIELDS) {
                out = com.openguardrails.ogr.Spans.restoreAt(out, msg + "." + field, mapping);
            }
            // ⚠️ The arguments are not an afterthought, they are the half that MATTERS. An
            // unrestored line of prose is a cosmetic defect the reader can see; an
            // unrestored {"to": "${OGR_EMAIL_1}"} is an agent acting on a value that
            // names nothing — mailing a placeholder, looking up a customer who does not
            // exist — and nothing in the reply says so.
            int calls = RawJson.arrayLength(out, msg + ".tool_calls");
            for (int i = 0; i < calls; i++) {
                out = com.openguardrails.ogr.Spans.restoreAt(
                    out, msg + ".tool_calls." + i + ".function.arguments", mapping);
            }
        }
        return out;
    }

    // ----------------------------------------------------------------- refusals

    @Override
    public String refuse(String model, String reason) {
        return completion(model, reason, "content_filter", null);
    }

    @Override
    public String refuseStream(String model, String reason) {
        return SseFrames.frame(chunk(model, Json.obj("role", "assistant", "content", reason), null))
            + retract(model);
    }

    /**
     * ⚠️ {@code content_filter}, not {@code stop}. The finish reason states WHY the turn
     * ended, and a client that logs or retries on it must be able to tell a refusal from
     * a completed reply.
     */
    @Override
    public String retract(String model) {
        return SseFrames.frame(chunk(model, Json.obj(), "content_filter")) + "data: [DONE]\n\n";
    }

    @Override
    public String retractWithReason(String model, String reason) {
        return SseFrames.frame(chunk(model, Json.obj("role", "assistant", "content", reason), null)) + retract(model);
    }

    @Override
    public String softRefuse(String model, String notice) {
        return completion(model, notice, "stop", Refusals.xOgr(com.openguardrails.ogr.Continuation.ANSWER));
    }

    @Override
    public String softRefuseStream(String model, String notice) {
        return SseFrames.frame(chunk(model, Json.obj("role", "assistant", "content", notice), null))
            + SseFrames.frame(chunk(model, Json.obj(), "stop"))
            + "data: [DONE]\n\n";
    }

    @Override
    public String retractSoft(String model, String notice) {
        return SseFrames.frame(chunk(model, Json.obj("content", "\n\n" + notice), null))
            + SseFrames.frame(chunk(model, Json.obj(), "stop"))
            + "data: [DONE]\n\n";
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
        int choices = Math.max(1, RawJson.arrayLength(out, "choices"));
        for (int c = 0; c < choices; c++) {
            String msg = "choices." + c + ".message";
            if (RawJson.locate(out, msg) == null) {
                continue;
            }
            /*
             * ⚠️ What SURVIVED decides the finish reason, and getting it wrong breaks the
             * loop in whichever direction it is wrong: `tool_calls` with an empty array
             * leaves a harness waiting for calls that will never arrive, and `stop` while
             * calls remain makes it discard work the policy allowed.
             */
            int remaining = RawJson.arrayLength(out, msg + ".tool_calls");
            String finish = remaining > 0 ? "tool_calls" : "stop";
            if (remaining == 0) {
                // An empty array is not the same as no array to every client; the model
                // asked for nothing that survived, so say exactly that.
                out = RawJson.removeMember(out, msg, "tool_calls");
            }
            String existing = RawJson.stringAt(out, msg + ".content");
            String withNotice = Refusals.withNotice(existing == null ? "" : existing, notice);
            String next = RawJson.putMember(out, msg, "content", Json.write(withNotice));
            if (next == null) {
                return null;
            }
            out = next;
            next = RawJson.putMember(out, "choices." + c, "finish_reason", Json.write(finish));
            if (next != null) {
                out = next;
            }
        }
        String tagged = RawJson.putMember(out, "", "x_ogr",
            Refusals.xOgr(com.openguardrails.ogr.Continuation.DROP_CALLS));
        return tagged == null ? out : tagged;
    }

    private static String completion(String model, String content, String finish, String xOgr) {
        Map<String, Object> choice = Json.obj(
            "index", Integer.valueOf(0),
            "message", Json.obj("role", "assistant", "content", content),
            "finish_reason", finish);
        List<Object> choices = new ArrayList<Object>();
        choices.add(choice);
        Map<String, Object> body = Json.obj(
            "id", "chatcmpl-ogr-refusal",
            "object", "chat.completion",
            "model", model,
            "choices", choices);
        if (xOgr != null) {
            body.put("x_ogr", Json.raw(xOgr));
        }
        return Json.write(body);
    }

    private static String chunk(String model, Map<String, Object> delta, String finish) {
        Map<String, Object> choice = Json.obj("index", Integer.valueOf(0), "delta", delta);
        if (finish != null) {
            choice.put("finish_reason", finish);
        }
        List<Object> choices = new ArrayList<Object>();
        choices.add(choice);
        return Json.write(Json.obj(
            "id", "chatcmpl-ogr",
            "object", "chat.completion.chunk",
            "model", model,
            "choices", choices));
    }

    // ---------------------------------------------------------------- streaming

    @Override
    public StreamDecoder newDecoder(Map<String, String> restoreMapping) {
        return new ChatDecoder(restoreMapping);
    }

    /** Accumulates one tool call's deltas, which concatenate by index. */
    private static final class StreamCall {
        String id = "";
        String name = "";
        final StringBuilder args = new StringBuilder();
        Restorer restorer;
    }

    private static final class ChatDecoder implements StreamDecoder {
        private final Map<String, String> mapping;
        private final StringBuilder text = new StringBuilder();
        private final StringBuilder reasoning = new StringBuilder();
        private final Map<Integer, StreamCall> calls = new TreeMap<Integer, StreamCall>();
        private final Restorer textRestorer;
        private final Map<String, Restorer> reasoningRestorers = new LinkedHashMap<String, Restorer>();
        private Usage usage;
        private int frames;
        private String model = "";

        ChatDecoder(Map<String, String> mapping) {
            this.mapping = mapping;
            this.textRestorer = new Restorer(mapping);
        }

        @Override
        public FrameResult frame(String frame) {
            String data = SseFrames.dataOf(frame);
            if (data == null) {
                return FrameResult.passthrough(frame);
            }
            if ("[DONE]".equals(data.trim())) {
                frames++;
                return FrameResult.passthrough(frame);
            }
            Object parsed = Json.parseOrNull(data);
            if (parsed == null) {
                return FrameResult.passthrough(frame);
            }
            boolean mine = Json.getList(parsed, "choices") != null || Json.get(parsed, "usage") instanceof Map;
            if (!mine) {
                return FrameResult.passthrough(frame);
            }
            frames++;
            if (model.isEmpty()) {
                model = Json.str(parsed, "model");
            }
            Usage u = usageOf(Json.get(parsed, "usage"));
            if (u != null) {
                usage = u;
            }

            String rewritten = data;
            int contentBytes = 0;
            boolean carriesCalls = false;

            List<Object> choices = Json.getList(parsed, "choices");
            if (choices != null) {
                for (int ci = 0; ci < choices.size(); ci++) {
                    Object choice = choices.get(ci);
                    String deltaPath = "choices." + ci + ".delta";

                    String piece = Json.str(choice, "delta.content");
                    if (!piece.isEmpty()) {
                        text.append(piece);
                        String emit = textRestorer.feed(piece);
                        contentBytes += SseFrames.utf8Length(emit);
                        rewritten = set(rewritten, deltaPath + ".content", emit);
                    }

                    for (String field : REASONING_FIELDS) {
                        String r = Json.str(choice, "delta." + field);
                        if (r.isEmpty()) {
                            continue;
                        }
                        reasoning.append(r);
                        Restorer restorer = reasoningRestorers.get(field);
                        if (restorer == null) {
                            restorer = new Restorer(mapping);
                            reasoningRestorers.put(field, restorer);
                        }
                        String emit = restorer.feed(r);
                        contentBytes += SseFrames.utf8Length(emit);
                        rewritten = set(rewritten, deltaPath + "." + field, emit);
                    }

                    List<Object> toolCalls = Json.getList(choice, "delta.tool_calls");
                    if (toolCalls == null) {
                        continue;
                    }
                    for (int ti = 0; ti < toolCalls.size(); ti++) {
                        Object tc = toolCalls.get(ti);
                        int index = (int) Json.getLong(tc, "index", ti);
                        StreamCall call = calls.get(Integer.valueOf(index));
                        if (call == null) {
                            call = new StreamCall();
                            call.restorer = new Restorer(mapping);
                            calls.put(Integer.valueOf(index), call);
                        }
                        String id = Json.str(tc, "id");
                        if (!id.isEmpty()) {
                            call.id = id;
                        }
                        String fname = Json.str(tc, "function.name");
                        if (!fname.isEmpty()) {
                            call.name = fname;
                            carriesCalls = true;
                        }
                        String args = Json.str(tc, "function.arguments");
                        if (!args.isEmpty()) {
                            call.args.append(args);
                            carriesCalls = true;
                            String emit = call.restorer.feed(args);
                            contentBytes += SseFrames.utf8Length(emit);
                            rewritten = set(rewritten, deltaPath + ".tool_calls." + ti + ".function.arguments", emit);
                        }
                    }
                }
            }
            if (rewritten.equals(data)) {
                return new FrameResult(frame, contentBytes, carriesCalls);
            }
            return new FrameResult(SseFrames.frame(rewritten), contentBytes, carriesCalls);
        }

        private static String set(String json, String path, String value) {
            String next = RawJson.replaceStringValue(json, path, value);
            return next == null ? json : next;
        }

        @Override
        public String flush() {
            StringBuilder out = new StringBuilder();
            String tail = textRestorer.flush();
            if (!tail.isEmpty()) {
                out.append(SseFrames.frame(chunk(model, Json.obj("content", tail), null)));
            }
            for (Map.Entry<String, Restorer> e : reasoningRestorers.entrySet()) {
                String r = e.getValue().flush();
                if (!r.isEmpty()) {
                    // ⚠️ Under the spelling this stream actually used. A held tail emitted
                    // as `reasoning_content` into a client reading `reasoning` is the very
                    // loss the flush exists to prevent, wearing the right field's clothes.
                    out.append(SseFrames.frame(chunk(model, Json.obj(e.getKey(), r), null)));
                }
            }
            for (Map.Entry<Integer, StreamCall> e : calls.entrySet()) {
                String rest = e.getValue().restorer.flush();
                if (rest.isEmpty()) {
                    continue;
                }
                List<Object> tc = new ArrayList<Object>();
                tc.add(Json.obj("index", e.getKey(),
                    "function", Json.obj("arguments", rest)));
                out.append(SseFrames.frame(chunk(model, Json.obj("tool_calls", tc), null)));
            }
            return out.toString();
        }

        @Override
        public Output output() {
            List<Action> actions = new ArrayList<Action>(calls.size());
            for (StreamCall c : calls.values()) {
                actions.add(new Action(c.id, c.name, c.args.toString()));
            }
            return new Output(text.toString(), reasoning.toString(), actions, usage);
        }

        @Override
        public String model() {
            return model;
        }

        @Override
        public int recognizedFrames() {
            return frames;
        }
    }
}
