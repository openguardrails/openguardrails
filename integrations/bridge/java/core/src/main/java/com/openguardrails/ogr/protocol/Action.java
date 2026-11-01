package com.openguardrails.ogr.protocol;

/** One tool invocation the model asked for. */
public final class Action {

    public final String id;
    public final String name;

    /**
     * The argument object as RAW JSON TEXT, exactly as the wire carried it.
     *
     * <p>⚠️ Raw rather than re-marshalled, on purpose. Re-encoding reorders keys and
     * changes spacing, so a judge would read a different string than the model was
     * handed and a verdict's offsets would index text that was never sent. Protocols
     * that carry arguments as an object (Anthropic's {@code input}) and protocols that
     * carry them as a JSON string (OpenAI's {@code arguments}) both land here as the
     * raw object text.
     */
    public final String arguments;

    public Action(String id, String name, String arguments) {
        this.id = id == null ? "" : id;
        this.name = name == null ? "" : name;
        this.arguments = arguments == null ? "" : arguments;
    }
}
