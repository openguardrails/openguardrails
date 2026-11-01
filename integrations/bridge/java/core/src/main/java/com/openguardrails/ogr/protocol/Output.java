package com.openguardrails.ogr.protocol;

import java.util.Collections;
import java.util.List;

/** What the model produced in reply to one request. */
public final class Output {

    public final String text;

    /**
     * The model's own thinking, where the protocol exposes it.
     *
     * <p>⚠️ Kept SEPARATE from {@link #text} rather than concatenated. Reasoning is
     * content a guardrail should read — it is where a hijacked plan states itself before
     * any action exists — but it is not what the model said, and folding the two
     * together makes a verdict's offsets index a string that exists nowhere on the wire.
     */
    public final String reasoning;

    public final List<Action> actions;
    public final Usage usage;

    public Output(String text, String reasoning, List<Action> actions, Usage usage) {
        this.text = text == null ? "" : text;
        this.reasoning = reasoning == null ? "" : reasoning;
        this.actions = actions == null ? Collections.<Action>emptyList() : actions;
        this.usage = usage;
    }

    /**
     * Whether the model produced nothing readable. Usage alone does not count: a reply
     * that carried counters and no content still said nothing.
     *
     * <p>⚠️⚠️ REASONING COUNTS. A build that read it as nothing silently lost the response
     * half of every PURE-REASONING reply — the deepseek family emits
     * {@code reasoning_content} heavily and some harnesses parse their tool calls out of
     * it, so a reply that was all reasoning was a real answer the client acted on, while
     * the observe path counted it "unreadable" and the fail-closed path REFUSED it
     * outright. Measured at 9.5% of steps on one deployment.
     */
    public boolean isEmpty() {
        return text.isEmpty() && reasoning.isEmpty() && actions.isEmpty();
    }
}
