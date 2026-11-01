package com.openguardrails.ogr;

/**
 * The identity FOUR-TUPLE, required on every GuardEvent.
 *
 * <p>All four fields are always present on the wire, with the empty string as the
 * explicit "no assertion" — an integrator answers the identity question rather than
 * falling into the API-key floor by omission. The four are not four spellings of one
 * thing:
 *
 * <ul>
 *   <li>{@code agentId} — WHICH agent. Unique in the organization; policy resolution
 *       and the inventory key on it. At a proxy this is the AUTHENTICATED CALLER:
 *       one consumer credential, one agent row.
 *   <li>{@code agentType} — what KIND. The harness or product name. A label; it
 *       selects no configuration.
 *   <li>{@code agentWorkspace} — the agent GROUP, i.e. ONE POLICY SET. This is the
 *       field that decides which rules judge the traffic.
 *   <li>{@code agentUser} — who is USING the agent right now. An attribute, never a
 *       policy boundary.
 * </ul>
 *
 * <h2>Who gets to say what</h2>
 *
 * ⚠️⚠️ {@code agentId} and {@code agentWorkspace} are the PROXY's to assert, because
 * they name a party and select a policy set. {@code agentType} and {@code agentUser}
 * are the client's, because they resolve no configuration. A proxy that reads all four
 * off inbound headers must <b>strip the two gateway-asserted ones from the client
 * request before its own authentication runs</b> — an enforcement point cannot tell a
 * header it wrote from one a client sent, so a valid credential plus a forged
 * {@code x-ogr-agent-workspace} chooses which policy judges the traffic.
 */
public final class Identity {

    /** Every field unasserted — the API key is then the identity floor. */
    public static final Identity NONE = new Identity("", "", "", "");

    public final String agentId;
    public final String agentType;
    public final String agentWorkspace;
    public final String agentUser;

    public Identity(String agentId, String agentType, String agentWorkspace, String agentUser) {
        this.agentId = nz(agentId);
        this.agentType = nz(agentType);
        this.agentWorkspace = nz(agentWorkspace);
        this.agentUser = nz(agentUser);
    }

    public Identity withAgentId(String id) {
        return new Identity(id, agentType, agentWorkspace, agentUser);
    }

    public Identity withAgentUser(String user) {
        return new Identity(agentId, agentType, agentWorkspace, user);
    }

    public Identity withAgentType(String type) {
        return new Identity(agentId, type, agentWorkspace, agentUser);
    }

    public Identity withAgentWorkspace(String workspace) {
        return new Identity(agentId, agentType, workspace, agentUser);
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    @Override
    public String toString() {
        return "Identity[" + agentId + "/" + agentType + "/" + agentWorkspace + "/" + agentUser + "]";
    }
}
