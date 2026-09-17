package com.openguardrails.ogr.server;

import com.openguardrails.ogr.StepGuard;

import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * What the OUT-OF-BAND door remembers between a step's two halves.
 *
 * <p>The inline proxy needs none of this — one {@link StepGuard} lives for the length of
 * one request. A caller that hands us the two halves as two separate HTTP calls does, and
 * the thing that must survive is the token→plaintext mapping: without it the reply keeps
 * the placeholders and the caller's application receives {@code ${OGR_EMAIL_1}} where its
 * own data belongs.
 *
 * <h2>⚠️ Bounded and expiring, and the caller can opt out entirely</h2>
 *
 * Entries expire, and the map is capped: an unbounded per-step cache is a memory leak
 * with a retention policy of "whatever the traffic does". And because this store is
 * PER PROCESS, a deployment that load-balances the two halves across replicas must either
 * route them together or carry the mapping itself — the door returns
 * {@code placeholders} on the request call and accepts it back on the response call
 * exactly so that a stateless caller needs nothing from here.
 */
final class StepStore {

    private final Map<String, Entry> steps = new ConcurrentHashMap<String, Entry>();
    private final long ttlMillis;
    private final int capacity;

    StepStore(long ttlMillis, int capacity) {
        this.ttlMillis = ttlMillis;
        this.capacity = capacity;
    }

    static final class Entry {
        final StepGuard step;
        final long expiresAt;

        Entry(StepGuard step, long expiresAt) {
            this.step = step;
            this.expiresAt = expiresAt;
        }
    }

    void put(String stepId, StepGuard step) {
        sweep();
        if (steps.size() >= capacity) {
            // Full: the newest step is the one most likely to be asked about, so the
            // oldest entries were already swept and this one still goes in. Losing an old
            // mapping costs a placeholder in a reply; refusing to remember the new one
            // costs it for the request that is happening now.
            sweepOldest();
        }
        steps.put(stepId, new Entry(step, System.currentTimeMillis() + ttlMillis));
    }

    /**
     * The step, if it is still remembered.
     *
     * <p>⚠️ NON-DESTRUCTIVE, deliberately. A caller whose response call failed in transit
     * retries it, and a read that consumed the entry would hand the retry a step with no
     * placeholder mapping — the reply then keeps its placeholders and the customer's
     * application receives {@code ${OGR_EMAIL_1}} where its own data belongs. Entries are
     * bounded and expire; a retry window is worth more than the bytes.
     */
    StepGuard peek(String stepId) {
        Entry e = steps.get(stepId);
        if (e == null || e.expiresAt < System.currentTimeMillis()) {
            return null;
        }
        return e.step;
    }

    int size() {
        return steps.size();
    }

    private void sweep() {
        long now = System.currentTimeMillis();
        for (Iterator<Map.Entry<String, Entry>> it = steps.entrySet().iterator(); it.hasNext();) {
            if (it.next().getValue().expiresAt < now) {
                it.remove();
            }
        }
    }

    private void sweepOldest() {
        String oldestKey = null;
        long oldest = Long.MAX_VALUE;
        for (Map.Entry<String, Entry> e : steps.entrySet()) {
            if (e.getValue().expiresAt < oldest) {
                oldest = e.getValue().expiresAt;
                oldestKey = e.getKey();
            }
        }
        if (oldestKey != null) {
            steps.remove(oldestKey);
        }
    }
}
