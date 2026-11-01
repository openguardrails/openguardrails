package com.openguardrails.ogr.protocol;

import java.util.List;
import java.util.Map;

/**
 * One LLM wire format. Every method is a pure function of its inputs.
 *
 * <h2>Why this is an interface and not a normalizer</h2>
 *
 * The obvious build RENDERS {@code anthropic.messages} and {@code openai.responses}
 * into the {@code openai.chat} shape and lets one reader consume the result. That is
 * the wrong seam, for three reasons that show up together:
 *
 * <ul>
 *   <li><b>It privileges one protocol.</b> {@code openai.chat} is the oldest of the
 *       three and the one OpenAI itself is moving off; making it the internal truth
 *       means every new protocol is measured by how well it impersonates a format on
 *       its way out.
 *   <li><b>It is lossy in a way nothing reports.</b> A thinking block, a tool result
 *       marked {@code is_error}, an interleaved text/tool_use sequence — each has to be
 *       flattened into a shape with no field for it, and the flattening is invisible
 *       downstream. A guardrail cannot then tell "the model said nothing" from "the
 *       renderer dropped it".
 *   <li><b>It is unmaintainable by anyone but the author</b>, which for an open
 *       integration is the binding constraint: adding a protocol means editing a
 *       renderer every other protocol also goes through, so the blast radius of a
 *       contribution is the whole file.
 * </ul>
 *
 * <p>A neutral model is not the same as a privileged one. No protocol's field names
 * appear in {@link Output}.
 *
 * <h2>Adding a protocol</h2>
 *
 * One file: implement this interface, register it in {@link Protocols}, add a row to
 * the conformance test. Use {@link Protocols#registerFallback} only if your body shape
 * is a SUPERSET of another's.
 */
public interface Protocol {

    /** The OGR {@code llm_protocol} enum value. Adding one means changing the schema in the same change. */
    String name();

    /** Whether a request path belongs to this protocol. */
    Claim claim(String path);

    /**
     * Recognise this protocol from the body alone, for a deployment that mounts a
     * completion API under a path we do not know.
     */
    boolean matchBody(Object body);

    /** The model name and whether the caller asked for SSE. */
    RequestFacts requestFacts(Object body);

    /**
     * Read a buffered reply.
     *
     * <p>⚠️ Tolerant: a block type this build does not know is DROPPED, not failed on — a
     * guardrail that reads 90% of a turn is worth more than one that reads none of it
     * because the vendor added a field.
     */
    Output parseResponse(Object body);

    /** A reader for this protocol's SSE. */
    StreamDecoder newDecoder(Map<String, String> restoreMapping);

    /**
     * Put plaintext back into a buffered REPLY.
     *
     * <p>⚠️ Not symmetric with masking failing. If a value is masked and never restored,
     * the caller receives {@code ${OGR_EMAIL_1}} where its own data belongs — the
     * placeholder escapes into the customer's application, and on the next turn their
     * client sends it back to us as content.
     *
     * <p>⚠️ Tool-call ARGUMENTS are the half that matters. An unrestored line of prose is
     * a cosmetic defect a reader can see; an unrestored {@code {"to":"${OGR_EMAIL_1}"}}
     * is an agent acting on a value that names nothing, and nothing in the reply says so.
     */
    String restore(String body, Map<String, String> mapping);

    /**
     * A refusal as a complete reply in this protocol's own shape.
     *
     * <p>⚠️ Per protocol, not one shared body. A refused {@code /v1/messages} caller handed
     * an OpenAI {@code choices[]} document gets a parse error from its SDK, which its
     * user reads as the proxy being broken rather than as a policy decision — and many
     * agent harnesses RETRY a malformed reply, turning one refusal into a storm.
     *
     * <p>⚠️ Rendered under HTTP 200, not a 4xx: every client renders an assistant message,
     * while a 4xx surfaces as a generic transport failure that explains nothing to the
     * person who typed the prompt.
     */
    String refuse(String model, String reason);

    /** {@link #refuse} in SSE frames, for a caller that asked for a stream. */
    String refuseStream(String model, String reason);

    /**
     * End a passthrough stream whose final judgement refused it. The text is already on
     * the caller's screen; this is the frame that tells a client to take it back.
     */
    String retract(String model);

    /**
     * {@link #retract} with the reason delivered INSIDE the message already open — for a
     * stream where only the provider's opening frames went out, so a fresh refusal
     * stream would open the message a second time.
     */
    String retractWithReason(String model, String reason);

    /**
     * The refusal as an ORDINARY completed reply carrying the notice as the assistant's
     * text — a normal stop, not a content filter.
     *
     * <p>⚠️ Same refusal, different token. {@code content_filter} / {@code stop_reason:
     * "refusal"} is what every agent harness treats as terminal, so a refused tool call
     * ends the whole session instead of the one action. The WHY moves to the
     * {@code x_ogr} body key, which nothing branches on.
     */
    String softRefuse(String model, String notice);

    /** {@link #softRefuse} in SSE frames, ending on this protocol's normal completion. */
    String softRefuseStream(String model, String notice);

    /**
     * Remove the named tool calls from a complete reply, append the notice, and correct
     * the finish reason to match what SURVIVED.
     *
     * <p>It is the only rendering that lets an agent loop keep running: the calls the
     * policy allowed still execute, and the model reads why the others did not.
     *
     * <p>{@code paths} are body paths with the {@code payload.} prefix already stripped,
     * naming whole array ELEMENTS — a call is refused whole, because blanking its
     * arguments would leave the agent a call it can still issue.
     *
     * <p>⚠️⚠️ Returns {@code null} when ANY path fails to resolve, and the caller MUST then
     * fall back to a hard refusal. A partial drop forwards refused calls under a notice
     * claiming they were refused.
     */
    String dropCalls(String body, List<String> paths, String notice);

    /**
     * End a stream that has ALREADY released bytes, on this protocol's normal completion,
     * delivering the notice where the protocol allows it.
     *
     * <p>⚠️⚠️ Only reachable when NO tool-call bytes have been released. With a partial call
     * in the client's hands, a normal completion invites it to run a call with truncated
     * arguments.
     */
    String retractSoft(String model, String notice);
}
