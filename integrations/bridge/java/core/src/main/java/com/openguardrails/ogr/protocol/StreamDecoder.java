package com.openguardrails.ogr.protocol;

/**
 * Reassembles one protocol's streamed reply, and restores placeholders in the frames
 * on their way to the caller.
 *
 * <p>Reassembly is not a nicety: a streaming reply is the ordinary shape of chat
 * traffic, and a proxy that only reports non-streaming replies makes the model's whole
 * output side invisible. A previous connector did exactly that and left a 230:21
 * request-to-response ratio in the event store.
 *
 * <p>All three protocols stream {@code data: <json>} lines, so the byte-level work is
 * shared ({@link SseFrames}). What the JSON MEANS is not remotely shared — they do not
 * have a single field name in common — which is why this is an interface each protocol
 * implements rather than one reader with three branches. Feeding one protocol's stream
 * to another's decoder accumulates nothing and reports the model as having said
 * nothing: a failure indistinguishable from a silent model.
 */
public interface StreamDecoder {

    /**
     * Handles one complete SSE frame and reports what to forward in its place, plus the
     * two facts the streaming hold needs about it.
     *
     * <p>⚠️ A frame this decoder does not recognise must be returned UNCHANGED. A decoder
     * that drops what it does not understand corrupts the stream for the client, which
     * is worse than not reading it.
     */
    FrameResult frame(String frame);

    /**
     * Whatever a restorer is still holding, rendered as complete extra frames, or "".
     *
     * <p>⚠️ Frames, not bare bytes: a client parses frames, and text written outside one
     * is a protocol error rather than part of the answer.
     */
    String flush();

    /**
     * The reply reassembled so far.
     *
     * <p>⚠️ The text is AS PRODUCED — still carrying placeholders — because detecting on
     * the restored text would find the very values we removed and block our own
     * restoration.
     */
    Output output();

    /**
     * The model name the FRAMES themselves carried, or {@code ""}.
     *
     * <p>⚠️ It exists for the half this process may never have judged. A streamed reply
     * that arrives at the message door carries no request half to have learned the model
     * from, and every refusal document has to be rendered under SOME model name for the
     * caller's SDK to read it — all three protocols name the model in their own opening
     * frame, so the frames can always say.
     */
    String model();

    /**
     * Data frames this decoder RECOGNISED as its own protocol's.
     *
     * <p>⚠️ It splits an empty reassembly's two very different causes: a well-formed
     * stream whose answer was genuinely empty (frames recognised — a reportable reply),
     * and bytes this decoder could not read at all (zero — a wrong dialect, a compressed
     * body, garbage), which is the real "unreadable".
     */
    int recognizedFrames();
}
