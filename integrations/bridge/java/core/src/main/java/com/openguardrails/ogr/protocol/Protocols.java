package com.openguardrails.ogr.protocol;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The protocol registry, and the one function that answers "what is this request
 * speaking?".
 */
public final class Protocols {

    private static final List<Protocol> SPECIFIC = new ArrayList<Protocol>();
    private static final List<Protocol> FALLBACK = new ArrayList<Protocol>();

    static {
        register(new AnthropicMessages());
        register(new OpenAiResponses());
        // ⚠️ openai.chat LAST, as a fallback: its body test is "has a `messages` array",
        // which every anthropic.messages body also passes. Registered normally it would
        // swallow every Anthropic request whose path we did not recognise, and the
        // symptom would be a correctly-parsed-LOOKING conversation with the system prompt
        // missing and every tool_use block dropped.
        registerFallback(new OpenAiChat());
    }

    private Protocols() {}

    public static void register(Protocol p) {
        SPECIFIC.add(p);
    }

    /** For a protocol whose body shape is a SUPERSET of another's. */
    public static void registerFallback(Protocol p) {
        FALLBACK.add(p);
    }

    public static List<Protocol> all() {
        List<Protocol> out = new ArrayList<Protocol>(SPECIFIC.size() + FALLBACK.size());
        out.addAll(SPECIFIC);
        out.addAll(FALLBACK);
        return Collections.unmodifiableList(out);
    }

    public static Protocol byName(String name) {
        for (Protocol p : all()) {
            if (p.name().equals(name)) {
                return p;
            }
        }
        return null;
    }

    /**
     * Resolves the protocol a request is speaking: the PATH first, because that is the
     * same signal a translating proxy keys on, then the body shape.
     *
     * <p>⚠️ Returns {@code null} rather than guessing. Reporting a protocol we did not
     * establish is how a deployment ends up with hundreds of thousands of events all
     * stamped {@code openai.chat} and no way to tell whether any of them were — at which
     * point the field has stopped being evidence, which is worse than it being empty.
     *
     * @param path the request path, may be {@code null} when only a body is in hand
     * @param body the parsed request body, may be {@code null}
     */
    public static Protocol detect(String path, Object body) {
        if (path != null) {
            String clean = cleanPath(path);
            for (Protocol p : all()) {
                Claim claim = p.claim(clean);
                if (claim == Claim.REJECT) {
                    return null;
                }
                if (claim == Claim.SERVE) {
                    return p;
                }
            }
        }
        if (body == null) {
            return null;
        }
        for (Protocol p : all()) {
            if (p.matchBody(body)) {
                return p;
            }
        }
        return null;
    }

    /**
     * Whether a path is a completion endpoint at all — i.e. whether a filter opens the
     * body.
     *
     * <p>⚠️ This used to be {@code path.contains("/chat/completions")} in an earlier
     * gateway, and that single line was the whole reason an Anthropic client got ZERO
     * guardrail coverage while every observable signal — HTTP 200, no warning, no error,
     * no counter — said healthy. The body was never opened, so nothing downstream could
     * notice.
     */
    public static boolean isCompletionPath(String path) {
        String clean = cleanPath(path);
        for (Protocol p : all()) {
            Claim claim = p.claim(clean);
            if (claim == Claim.REJECT) {
                return false;
            }
            if (claim == Claim.SERVE) {
                return true;
            }
        }
        return false;
    }

    /** Strips the query and any trailing slash, so suffix matching means what it looks like. */
    public static String cleanPath(String path) {
        if (path == null) {
            return "";
        }
        int q = path.indexOf('?');
        String p = q >= 0 ? path.substring(0, q) : path;
        return p.endsWith("/") ? p.substring(0, p.length() - 1) : p;
    }

    /**
     * Suffix matching, on purpose: a deployment may mount these under a prefix
     * ({@code /api/v1/messages}, {@code /openai/v1/chat/completions}).
     */
    public static boolean hasSuffix(String path, String suffix) {
        return path.endsWith(suffix);
    }
}
