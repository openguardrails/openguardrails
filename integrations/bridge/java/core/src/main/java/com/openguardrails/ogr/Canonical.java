package com.openguardrails.ogr;

import com.openguardrails.ogr.json.Json;
import com.openguardrails.ogr.protocol.Action;
import com.openguardrails.ogr.protocol.Output;
import com.openguardrails.ogr.protocol.Usage;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The canonical response payload — what a step's {@code step/response} carries when
 * there is no single raw body to forward.
 *
 * <p>That is exactly one case here: a STREAMED reply. The frames are the body, and no
 * one of them is the answer, so the reply is reassembled and reported in the shape the
 * specification defines, with {@code llm_protocol} still naming the protocol the client
 * spoke. (A buffered reply is forwarded verbatim and never comes through here.)
 */
public final class Canonical {

    private Canonical() {}

    /**
     * ⚠️ {@code arguments} is the argument OBJECT, not a JSON string of it. The runtime
     * reads {@code arguments.command} to recover the bare command a shell action carries,
     * and a string here hands the judge {@code "{\"command\":\"rm -rf /\"}"} where it was
     * trained on {@code rm -rf /}. The raw argument text is reused verbatim, so the
     * runtime reads the same bytes the model produced — and degrades to a JSON string
     * when the stream was cut mid-argument, which must not be able to break the event.
     */
    public static String responsePayload(Output output, String model, Instant startedAt,
                                         Instant firstTokenAt, Instant completedAt) {
        Map<String, Object> payload = Json.obj();
        if (!output.text.isEmpty()) {
            payload.put("text", output.text);
        }
        if (!output.reasoning.isEmpty()) {
            payload.put("reasoning", output.reasoning);
        }
        if (!output.actions.isEmpty()) {
            List<Object> calls = new ArrayList<Object>(output.actions.size());
            for (Action a : output.actions) {
                Map<String, Object> call = Json.obj("name", a.name);
                if (!a.id.isEmpty()) {
                    call.put("id", a.id);
                }
                if (!a.arguments.isEmpty()) {
                    call.put("arguments", Json.raw(a.arguments));
                }
                calls.add(call);
            }
            payload.put("tool_calls", calls);
        }
        if (model != null && !model.isEmpty()) {
            payload.put("model", model);
        }
        if (output.usage != null) {
            payload.put("usage", usage(output.usage));
        }
        Map<String, Object> timing = GuardEvent.timingMap(startedAt, firstTokenAt, completedAt);
        if (!timing.isEmpty()) {
            payload.put("timing", timing);
        }
        return Json.write(payload);
    }

    /**
     * The provider's counters under the canonical names.
     *
     * <p>{@code input}/{@code output} stay present at 0 when the provider reported a
     * usage object at all; the detail counters are omitted at 0 because most providers
     * never report them, and a reported zero and an unreported one are different facts.
     */
    private static Map<String, Object> usage(Usage u) {
        Map<String, Object> m = Json.obj(
            "input_tokens", Long.valueOf(u.inputTokens),
            "output_tokens", Long.valueOf(u.outputTokens));
        if (u.reasoningTokens > 0) {
            m.put("reasoning_tokens", Long.valueOf(u.reasoningTokens));
        }
        if (u.cacheReadTokens > 0) {
            m.put("cache_read_tokens", Long.valueOf(u.cacheReadTokens));
        }
        if (u.cacheWriteTokens > 0) {
            m.put("cache_write_tokens", Long.valueOf(u.cacheWriteTokens));
        }
        return m;
    }
}
