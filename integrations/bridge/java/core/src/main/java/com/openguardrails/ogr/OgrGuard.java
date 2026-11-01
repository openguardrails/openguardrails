package com.openguardrails.ogr;

import java.io.Closeable;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * The entry point: one per process, holding the runtime client, the counters and the
 * heartbeat.
 *
 * <p>A proxy creates one of these at startup and a {@link StepGuard} per proxied model
 * call.
 */
public final class OgrGuard implements Closeable {

    private final OgrConfig config;
    private final OgrClient client;
    private final Counters counters = new Counters();
    private final ThreadPoolExecutor dispatcher;
    private final ScheduledExecutorService beat;

    public OgrGuard(OgrConfig config) {
        this(config, new OgrClient(config));
    }

    public OgrGuard(OgrConfig config, OgrClient client) {
        this.config = config;
        this.client = client;
        /*
         * The OBSERVE lane's dispatcher.
         *
         * ⚠️ A BOUNDED queue that DISCARDS when full, on purpose. An unbounded one turns a
         * slow or unreachable runtime into this proxy's own memory exhaustion — the
         * observation channel taking down the traffic it was only supposed to watch. Under
         * pressure the honest failure is losing observations and saying so, which is what
         * the `evaluate_errors` counter is for.
         */
        this.dispatcher = new ThreadPoolExecutor(1, 4, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(1024), daemon("ogr-dispatch"),
            new ThreadPoolExecutor.DiscardPolicy());
        this.beat = Executors.newSingleThreadScheduledExecutor(daemon("ogr-heartbeat"));
    }

    /**
     * Starts the periodic heartbeat.
     *
     * <p>Liveness over the authenticated channel, so the runtime can tell "agent idle"
     * from "integration went dark" — the one thing a silent proxy cannot say about
     * itself.
     */
    public OgrGuard startHeartbeat() {
        long seconds = Math.max(5, config.heartbeatInterval().getSeconds());
        beat.scheduleAtFixedRate(new Runnable() {
            @Override
            public void run() {
                try {
                    client.heartbeat(counters);
                } catch (RuntimeException e) {
                    // A heartbeat is a report, never a control: it must not be able to
                    // stop its own schedule, whatever the runtime answered.
                }
            }
        }, seconds, seconds, TimeUnit.SECONDS);
        return this;
    }

    /**
     * A guard for one model call.
     *
     * @param identity    the four-tuple, resolved by the caller from its own authentication
     * @param sessionHint the producer's own name for this CONVERSATION, or "" — a
     *                    GROUPING HINT the runtime may decline, never a coordinate
     * @param connection  which downstream connection carried this request, or "" — the one
     *                    session signal a client cannot strip
     * @param llmEndpoint the host the agent DIALLED ({@code host[:port]}), or ""
     * @param initiator   {@code "scheduled"} when the caller declared a scheduled run, else ""
     */
    public StepGuard newStep(Identity identity, String sessionHint, String connection,
                             String llmEndpoint, String initiator) {
        return new StepGuard(this, config, Ids.stepId(),
            identity == null ? config.defaultIdentity() : identity,
            sessionHint, connection, llmEndpoint, initiator);
    }

    /** As above, with a step id the caller already minted — the out-of-band door's case. */
    public StepGuard resumeStep(String stepId, Identity identity, String sessionHint,
                                String connection, String llmEndpoint, String initiator) {
        String id = (stepId == null || stepId.isEmpty()) ? Ids.stepId() : stepId;
        return new StepGuard(this, config, id,
            identity == null ? config.defaultIdentity() : identity,
            sessionHint, connection, llmEndpoint, initiator);
    }

    public OgrConfig config() {
        return config;
    }

    public OgrClient client() {
        return client;
    }

    public Counters counters() {
        return counters;
    }

    /** Sends an event without waiting for the verdict — the observe lane. */
    void dispatch(final GuardEvent event) {
        try {
            dispatcher.execute(new Runnable() {
                @Override
                public void run() {
                    OgrClient.EvaluateResult r = client.evaluate(event);
                    if (r.answered()) {
                        counters.event();
                    } else {
                        counters.evaluateError();
                    }
                }
            });
        } catch (RejectedExecutionException e) {
            counters.evaluateError();
        }
    }

    @Override
    public void close() {
        beat.shutdownNow();
        dispatcher.shutdown();
    }

    private static ThreadFactory daemon(final String name) {
        return new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, name);
                // Daemon, so a guard nobody closed cannot keep a JVM alive.
                t.setDaemon(true);
                return t;
            }
        };
    }
}
