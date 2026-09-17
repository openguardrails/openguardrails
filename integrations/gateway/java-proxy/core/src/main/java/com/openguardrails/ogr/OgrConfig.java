package com.openguardrails.ogr;

import java.time.Duration;

/**
 * How this proxy talks to the runtime, and what it does with the answers.
 *
 * <p>Built through {@link #builder()}; every value has a default that is safe to ship
 * except {@code baseUrl} and {@code apiKey}.
 */
public final class OgrConfig {

    /** The name this integration reports as. Changing it mints a second integration record. */
    public static final String DEFAULT_INTEGRATION_NAME = "ogr-java-proxy";

    /** The build. Reported on every event AND on the heartbeat — see {@link #integrationId()}. */
    public static final String VERSION = "1.0.0";

    private final String baseUrl;
    private final String basePath;
    private final String apiKey;
    private final Mode mode;
    private final FailMode failMode;
    private final Duration timeout;
    private final int streamHeadReleaseBytes;
    private final String integrationName;
    private final String instanceId;
    private final Identity defaultIdentity;
    private final Duration heartbeatInterval;

    private OgrConfig(Builder b) {
        this.baseUrl = trimTrailingSlash(require(b.baseUrl, "baseUrl"));
        this.basePath = trimTrailingSlash(b.basePath == null ? "" : b.basePath);
        this.apiKey = b.apiKey == null ? "" : b.apiKey;
        this.mode = b.mode;
        this.failMode = b.failMode;
        this.timeout = b.timeout;
        this.streamHeadReleaseBytes = b.streamHeadReleaseBytes;
        this.integrationName = b.integrationName;
        this.instanceId = b.instanceId;
        this.defaultIdentity = b.defaultIdentity;
        this.heartbeatInterval = b.heartbeatInterval;
    }

    public String baseUrl() {
        return baseUrl;
    }

    /**
     * The canonical endpoint paths are rooted at {@code /v1/}; this is the mount prefix
     * they are joined onto. The reference runtime also serves them under
     * {@code /api/public/ogr}.
     *
     * <p>⚠️ Configuration, not discovery. A wrong prefix is loud — every evaluate comes
     * back non-200, which is fail-mode territory rather than silence.
     */
    public String basePath() {
        return basePath;
    }

    public String endpoint(String canonicalPath) {
        return baseUrl + basePath + canonicalPath;
    }

    public String apiKey() {
        return apiKey;
    }

    public Mode mode() {
        return mode;
    }

    public FailMode failMode() {
        return failMode;
    }

    /**
     * The evaluate budget.
     *
     * <p>⚠️ 5 seconds is a CEILING, not a target — what a person tolerates once, on a
     * bad request. And the budgets must be ORDERED, outermost longest: this one &gt;
     * the runtime's {@code OGR_MODEL_TIMEOUT_MS} &gt; the model gateway's own. Equal
     * budgets are a race, and when this one wins it nothing can name what was slow.
     * Order the chain by lowering the INNER budgets, never by raising this — that
     * spends the caller's patience, which is the one resource in the chain that is
     * not ours.
     */
    public Duration timeout() {
        return timeout;
    }

    /**
     * How much client-visible content a STREAMED answer may reach the caller before
     * the end-of-stream verdict — UTF-8 bytes of text, reasoning and tool-call
     * arguments, never SSE framing.
     *
     * <p>⚠️ Measured from the HEAD, and the direction is the whole design. A rule of
     * the form "withhold the last N bytes" guarantees only that N are withheld; what
     * reaches the caller is {@code total − N}, which grows without limit in the length
     * of the answer, so a long violating reply is delivered essentially whole and can
     * only be RETRACTED. Bounding the head makes the exposure a CONSTANT, independent
     * of both the answer's length and the judge's latency.
     *
     * <p>⚠️ A CEILING, not a floor: a frame that would carry the caller past it is held
     * whole. {@code 0} is a real value — release nothing, a spinner until the judged
     * answer arrives, and every block then a clean refusal rather than a retraction.
     */
    public int streamHeadReleaseBytes() {
        return streamHeadReleaseBytes;
    }

    public String integrationName() {
        return integrationName;
    }

    /**
     * {@code name/version}, reported on EVERY event and on the heartbeat.
     *
     * <p>⚠️ ONE function feeds both, deliberately. Two literals drift and each looks
     * internally consistent; the event's copy is the TRIAGE signal (which build
     * produced this traffic) and the heartbeat's is the LIVENESS signal (this reporter
     * is alive while emitting nothing). Neither is redundant.
     */
    public String integrationId() {
        return integrationName + "/" + VERSION;
    }

    /**
     * An id this process minted for itself, stable for its life and NOT across
     * restarts.
     *
     * <p>⚠️ Not reusing it across restarts is the point: a restarted process has fresh
     * counters, and reusing the id splices two series so a monotonic counter appears to
     * go backwards. Without it every replica of this integration overwrites the others'
     * version and counters in the runtime's liveness record.
     */
    public String instanceId() {
        return instanceId;
    }

    public Identity defaultIdentity() {
        return defaultIdentity;
    }

    public Duration heartbeatInterval() {
        return heartbeatInterval;
    }

    public static Builder builder() {
        return new Builder();
    }

    private static String require(String v, String name) {
        if (v == null || v.isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return v;
    }

    private static String trimTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    public static final class Builder {
        private String baseUrl;
        private String basePath = "";
        private String apiKey;
        private Mode mode = Mode.OBSERVE;
        private FailMode failMode = FailMode.OPEN;
        private Duration timeout = Duration.ofMillis(5000);
        private int streamHeadReleaseBytes = 32;
        private String integrationName = DEFAULT_INTEGRATION_NAME;
        private String instanceId = Ids.mint("inst-");
        private Identity defaultIdentity = Identity.NONE;
        private Duration heartbeatInterval = Duration.ofSeconds(30);

        public Builder baseUrl(String v) {
            this.baseUrl = v;
            return this;
        }

        public Builder basePath(String v) {
            this.basePath = v;
            return this;
        }

        public Builder apiKey(String v) {
            this.apiKey = v;
            return this;
        }

        public Builder mode(Mode v) {
            this.mode = v;
            return this;
        }

        public Builder failMode(FailMode v) {
            this.failMode = v;
            return this;
        }

        public Builder timeout(Duration v) {
            this.timeout = v;
            return this;
        }

        public Builder streamHeadReleaseBytes(int v) {
            this.streamHeadReleaseBytes = Math.max(0, v);
            return this;
        }

        public Builder integrationName(String v) {
            this.integrationName = v;
            return this;
        }

        public Builder instanceId(String v) {
            this.instanceId = v;
            return this;
        }

        public Builder defaultIdentity(Identity v) {
            this.defaultIdentity = v == null ? Identity.NONE : v;
            return this;
        }

        public Builder heartbeatInterval(Duration v) {
            this.heartbeatInterval = v;
            return this;
        }

        public OgrConfig build() {
            return new OgrConfig(this);
        }
    }
}
