package com.openguardrails.ogr.protocol;

/**
 * The provider's OWN token accounting for one reply, normalized to the counter names
 * the OGR canonical payload uses.
 *
 * <p>⚠️ A proxy holds no tokenizer, so this is TRANSCRIPTION, never estimation.
 * {@code null} means the provider reported nothing, and null is the honest answer then
 * — an invented count is read downstream as a measurement.
 */
public final class Usage {

    public final long inputTokens;
    public final long outputTokens;
    public final long reasoningTokens;
    public final long cacheReadTokens;
    public final long cacheWriteTokens;

    public Usage(long inputTokens, long outputTokens, long reasoningTokens,
                 long cacheReadTokens, long cacheWriteTokens) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.reasoningTokens = reasoningTokens;
        this.cacheReadTokens = cacheReadTokens;
        this.cacheWriteTokens = cacheWriteTokens;
    }
}
