package com.openguardrails.ogr.protocol;

/**
 * The two things a raw-forwarding proxy must read out of a REQUEST body.
 *
 * <p>⚠️ Deliberately not a parsed conversation. Since v0.8 an integration forwards the
 * body untouched and the RUNTIME classifies it, so parsing the request here would be a
 * second implementation of the runtime's own job — and two implementations of one
 * algorithm drift. What is genuinely needed locally is smaller than a conversation:
 * whether to arm the streaming hold, and which model name a refusal must be rendered
 * under so the caller's SDK can parse it.
 */
public final class RequestFacts {

    public final String model;
    public final boolean stream;

    public RequestFacts(String model, boolean stream) {
        this.model = model == null ? "" : model;
        this.stream = stream;
    }
}
