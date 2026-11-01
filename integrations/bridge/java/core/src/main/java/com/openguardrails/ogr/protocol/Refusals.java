package com.openguardrails.ogr.protocol;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Shared refusal and continuation helpers.
 *
 * <p>⚠️⚠️ NOTHING HERE WEAKENS A REFUSAL. The action does not happen, the withheld content
 * does not reach the model, and the runtime still recorded {@code decision: block}. What
 * changes is the TOKEN the turn ends on.
 */
public final class Refusals {

    private Refusals() {}

    /**
     * The machine-readable marker spliced into every soft rendering — what a client that
     * cares about refusals reads now that the finish reason no longer says it.
     *
     * <p>⚠️ A body key rather than a header, because a proxy rewrites response bytes after
     * headers have already gone out on the streaming path, so a header is unavailable at
     * the one site that needs this most. One mechanism at both sites beats two that
     * differ.
     */
    public static String xOgr(String style) {
        return "{\"decision\":\"block\",\"continuation\":\"" + style + "\"}";
    }

    /**
     * Joins the model's surviving prose and the notice.
     *
     * <p>⚠️ The notice goes AFTER, never instead. What the model already said is its own
     * output and stays in the record the client renders; replacing it hides the reasoning
     * that led to the refused action from the person reviewing it.
     */
    public static String withNotice(String existing, String notice) {
        if (existing == null || existing.trim().isEmpty()) {
            return notice;
        }
        return existing + "\n\n" + notice;
    }

    /**
     * Orders drop paths so that deleting one cannot shift the index of the next: within
     * each parent array, DEEPEST INDEX FIRST.
     *
     * <p>⚠️⚠️ This is the whole correctness of a multi-call drop. {@code tool_calls.0} and
     * {@code tool_calls.2} deleted in that order removes the refused call and then the
     * WRONG one — the element that slid into index 2 is a call the policy allowed.
     *
     * <p>Returns {@code null} when any path does not end in an array index: a continuation
     * names whole calls, and half-understanding a directive is how an enforcement point
     * forwards the thing it was told to remove.
     */
    public static List<String> dropOrder(List<String> paths) {
        List<String[]> entries = new ArrayList<String[]>(paths.size());
        for (String p : paths) {
            int cut = p.lastIndexOf('.');
            if (cut < 0) {
                return null;
            }
            try {
                Integer.parseInt(p.substring(cut + 1));
            } catch (NumberFormatException e) {
                return null;
            }
            entries.add(new String[] {p, p.substring(0, cut), p.substring(cut + 1)});
        }
        Collections.sort(entries, new Comparator<String[]>() {
            @Override
            public int compare(String[] a, String[] b) {
                int byParent = a[1].compareTo(b[1]);
                if (byParent != 0) {
                    return byParent;
                }
                return Integer.compare(Integer.parseInt(b[2]), Integer.parseInt(a[2]));
            }
        });
        List<String> out = new ArrayList<String>(entries.size());
        for (String[] e : entries) {
            out.add(e[0]);
        }
        return out;
    }

    /**
     * Groups drop paths by their parent array, keeping the indexes per array.
     *
     * <p>Returns {@code null} when any path is not an array element — the same
     * all-or-nothing rule as {@link #dropOrder}.
     */
    public static java.util.Map<String, List<Integer>> dropGroups(List<String> paths) {
        java.util.Map<String, List<Integer>> out = new java.util.LinkedHashMap<String, List<Integer>>();
        if (paths == null || paths.isEmpty()) {
            return null;
        }
        for (String p : paths) {
            int cut = p.lastIndexOf('.');
            if (cut < 0) {
                return null;
            }
            int idx;
            try {
                idx = Integer.parseInt(p.substring(cut + 1));
            } catch (NumberFormatException e) {
                return null;
            }
            String parent = p.substring(0, cut);
            List<Integer> group = out.get(parent);
            if (group == null) {
                group = new ArrayList<Integer>();
                out.put(parent, group);
            }
            group.add(Integer.valueOf(idx));
        }
        return out;
    }
}
