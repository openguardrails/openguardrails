package com.openguardrails.ogr;

/**
 * Whether this proxy ACTS on verdicts.
 *
 * <p>{@link #OBSERVE} reports and never enforces: events are still sent and still
 * recorded — that is the observation channel — but no request is refused, no span is
 * applied and no stream is held. It is how a deployment is rolled out, and it is the
 * only mode in which the guard adds no latency to the model call, because the evaluate
 * calls are dispatched without being waited on.
 *
 * <p>⚠️ Observe is not "enforce with the blocks turned off". In observe the caller is
 * never held, so a verdict that arrives after the model has already answered is still
 * a correct record and a useless control. Do not read an observe deployment's clean
 * traffic as evidence that enforcement would have been transparent — read its
 * would-be blocks in the console instead.
 */
public enum Mode {
    OBSERVE,
    ENFORCE;

    public static Mode of(String s) {
        return "enforce".equalsIgnoreCase(s) ? ENFORCE : OBSERVE;
    }

    public boolean enforces() {
        return this == ENFORCE;
    }
}
