package com.openguardrails.ogr.server;

import com.openguardrails.ogr.Identity;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Reading the identity four-tuple off a proxied request, and keeping the proxy's own
 * headers out of the caller's reach.
 *
 * <h2>⚠️⚠️ Who gets to say what</h2>
 *
 * The GATEWAY owns {@code agent_id} and {@code agent_workspace} — they name a party and
 * select a POLICY SET. The CLIENT owns {@code agent_type} and {@code agent_user}, which
 * resolve no configuration.
 *
 * <p>So {@link #stripClientAsserted} must run BEFORE this proxy's own authentication
 * writes anything: an enforcement point cannot distinguish a header its own gateway wrote
 * from one a client sent, and authenticators do not generally overwrite a caller-supplied
 * consumer header. A valid credential plus a forged {@code x-ogr-agent-workspace} chooses
 * which policy set judges the traffic — measured, on a real deployment, as a forged
 * consumer header being attributed to the forgery.
 */
public final class Headers {

    public static final List<String> AGENT_ID_CHAIN =
        Arrays.asList("x-ogr-agent-id", "x-mse-consumer");
    public static final List<String> AGENT_WORKSPACE_CHAIN =
        Arrays.asList("x-ogr-agent-workspace", "x-mse-consumer-group");
    public static final String AGENT_TYPE_HEADER = "x-ogr-agent-type";
    public static final String AGENT_USER_HEADER = "x-ogr-agent-user";

    /** Which headers may carry the client's own credential, first non-empty wins. */
    public static final List<String> CREDENTIAL_HEADERS =
        Arrays.asList("authorization", "x-api-key", "api-key");

    /**
     * The headers a client must never be able to set for itself.
     *
     * <p>⚠️ The type and user spellings are NOT here on purpose: those two are the
     * client's to assert, and stripping them would throw away the only thing the client
     * can honestly say about itself.
     */
    public static final List<String> GATEWAY_ASSERTED =
        Arrays.asList("x-ogr-agent-id", "x-ogr-agent-workspace", "x-mse-consumer", "x-mse-consumer-group");

    private static final String CALLER_PREFIX = "caller-";

    /** 12 hex characters = 48 bits. See {@link #fingerprint}. */
    private static final int CALLER_HEX = 12;

    private Headers() {}

    /** A header lookup that is case-insensitive and answers "" rather than null. */
    public interface Lookup {
        String get(String name);
    }

    /**
     * Resolves the four-tuple.
     *
     * @param fallback         static values for a route that fronts exactly one agent;
     *                         there is deliberately no static {@code agent_user} — a
     *                         constant user is already what the identity floor gives you
     * @param callerFallback   when nothing names the agent, fingerprint the CLIENT's own
     *                         credential rather than letting every consumer behind this
     *                         proxy collapse into one agent
     */
    public static Identity resolve(Lookup headers, Identity fallback, boolean callerFallback) {
        String id = first(headers, AGENT_ID_CHAIN);
        if (id.isEmpty()) {
            id = fallback.agentId;
        }
        if (id.isEmpty() && callerFallback) {
            /*
             * ⚠️ NOT the runtime API key. That key authenticates the SENDER — this proxy —
             * so using it as the agent identity files every consumer behind one proxy into
             * a single inventory row: one agent, one policy resolution, one owner for
             * everyone's traffic, and one "move this agent" click that moves all of them.
             * Measured at 82.3% of 556k events misattributed on one deployment. The
             * credential the CLIENT presented is the finest distinction a proxy without
             * caller authentication actually holds.
             */
            String fp = fingerprint(first(headers, CREDENTIAL_HEADERS));
            if (!fp.isEmpty()) {
                id = CALLER_PREFIX + fp;
            }
        }
        String workspace = first(headers, AGENT_WORKSPACE_CHAIN);
        if (workspace.isEmpty()) {
            workspace = fallback.agentWorkspace;
        }
        String type = nz(headers.get(AGENT_TYPE_HEADER));
        if (type.isEmpty()) {
            type = fallback.agentType;
        }
        return new Identity(id, type, workspace, nz(headers.get(AGENT_USER_HEADER)));
    }

    /** Whether a header is one only this proxy may assert. */
    public static boolean isGatewayAsserted(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String h : GATEWAY_ASSERTED) {
            if (h.equals(lower)) {
                return true;
            }
        }
        return false;
    }

    /**
     * ⚠️ A truncated hash, never the credential. 48 bits keeps collisions negligible at
     * any real consumer count — and a collision would silently merge two people's
     * traffic, which is the very failure this exists to prevent, so the extra bytes are
     * not cosmetic.
     *
     * <p>Two honest limits, both of which caller authentication removes: a credential
     * SHARED by a team is one caller here, correctly and unhelpfully; and ROTATING a
     * credential mints a new agent row, because from this side a new secret is a new
     * caller.
     */
    public static String fingerprint(String credential) {
        String value = credentialValue(credential);
        if (value.isEmpty()) {
            return "";
        }
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] digest = sha.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(CALLER_HEX);
            for (int i = 0; sb.length() < CALLER_HEX; i++) {
                sb.append(String.format("%02x", digest[i] & 0xff));
            }
            return sb.substring(0, CALLER_HEX);
        } catch (NoSuchAlgorithmException e) {
            return "";
        }
    }

    /**
     * The credential itself, with any {@code Bearer } scheme removed.
     *
     * <p>⚠️ "Bearer sk-…" in one header and a bare "sk-…" in another must fingerprint
     * IDENTICALLY, or the same caller changes identity by moving their key between
     * headers. ⚠️ And a header of exactly "Bearer" has no secret in it at all: without the
     * second branch the word itself gets fingerprinted, and every credential-less request
     * in the deployment shares one invented agent — the collapse this path exists to
     * remove, wearing a plausible id.
     */
    static String credentialValue(String raw) {
        String cred = nz(raw).trim();
        int space = cred.indexOf(' ');
        if (space > 0 && "bearer".equalsIgnoreCase(cred.substring(0, space))) {
            return cred.substring(space + 1).trim();
        }
        if ("bearer".equalsIgnoreCase(cred)) {
            return "";
        }
        return cred;
    }

    private static String first(Lookup headers, List<String> names) {
        for (String name : names) {
            String v = nz(headers.get(name)).trim();
            if (!v.isEmpty()) {
                return v;
            }
        }
        return "";
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
