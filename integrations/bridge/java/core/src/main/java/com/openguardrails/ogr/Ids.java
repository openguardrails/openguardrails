package com.openguardrails.ogr;

import java.security.SecureRandom;

/** Opaque id minting. */
public final class Ids {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Ids() {}

    /**
     * A fresh random id, 32 hex characters.
     *
     * <p>This is what mints a {@code step_id} — the ONE coordinate the wire kept,
     * because concurrency makes pairing a call's two halves underivable. It is
     * per-model-call and never reused: a collision merges two different model calls
     * into one step, silently, and a step id is also the runtime's guard binding.
     *
     * <p>⚠️ {@link SecureRandom}, not a counter and not a timestamp. A per-process
     * counter resets on restart, which is exactly when several processes are minting
     * at once.
     */
    public static String stepId() {
        return mint("");
    }

    public static String mint(String prefix) {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(prefix.length() + 32);
        sb.append(prefix);
        for (byte b : bytes) {
            sb.append(HEX[(b >> 4) & 0xf]).append(HEX[b & 0xf]);
        }
        return sb.toString();
    }
}
