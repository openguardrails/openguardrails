import { useState, useEffect, useMemo } from "react";
import {
  api,
  type ToolCallObservation,
  type AgentLookup,
  buildAgentMap,
} from "../lib/api";

type FilterStatus = "all" | "allowed" | "blocked";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ActivityPage() {
  const [observations, setObservations] = useState<ToolCallObservation[]>([]);
  const [agentMap, setAgentMap] = useState<Map<string, AgentLookup>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Fetch all observations and agent info in parallel
        const [obsRes, discoveryRes, registeredRes] = await Promise.all([
          api.getAllObservations(200),
          api.listDiscoveryAgents(),
          api.listAgents(),
        ]);
        if (cancelled) return;

        const discovery = discoveryRes.success ? discoveryRes.data : [];
        const registered = registeredRes.success ? registeredRes.data : [];
        setAgentMap(buildAgentMap(discovery, registered));

        if (obsRes.success) {
          // Already sorted by timestamp descending from API
          setObservations(obsRes.data);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    let items = observations;

    // Filter by status
    if (filterStatus === "allowed") {
      items = items.filter(o => !o.blocked);
    } else if (filterStatus === "blocked") {
      items = items.filter(o => o.blocked);
    }

    // Filter by search
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(o =>
        o.toolName.toLowerCase().includes(q) ||
        (o.category || "").toLowerCase().includes(q) ||
        (agentMap.get(o.agentId)?.name || o.agentId).toLowerCase().includes(q)
      );
    }

    return items;
  }, [observations, search, filterStatus, agentMap]);

  const blockedCount = observations.filter(o => o.blocked).length;
  const allowedCount = observations.filter(o => !o.blocked).length;

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">Timeline of agent actions</p>
        </div>
        <div className="page-meta">
          <div className="pill">
            <span className="statusDot ok" />
            <span>{allowedCount} allowed</span>
          </div>
          {blockedCount > 0 && (
            <div className="pill">
              <span className="statusDot warn" />
              <span>{blockedCount} blocked</span>
            </div>
          )}
        </div>
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 260 }}>
          <input
            type="text"
            placeholder="Search tools, categories, agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-tabs">
          <button
            className={`filter-tab${filterStatus === "all" ? " active" : ""}`}
            onClick={() => setFilterStatus("all")}
          >
            All
          </button>
          <button
            className={`filter-tab${filterStatus === "allowed" ? " active" : ""}`}
            onClick={() => setFilterStatus("allowed")}
          >
            Allowed
          </button>
          <button
            className={`filter-tab${filterStatus === "blocked" ? " active" : ""}`}
            onClick={() => setFilterStatus("blocked")}
          >
            Blocked
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading activity...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="card-title">No activity found</div>
          <div className="card-sub">
            {search || filterStatus !== "all"
              ? "Try adjusting your filters"
              : "Agent activity will appear here once agents start making tool calls."}
          </div>
        </div>
      ) : (
        <div className="timeline">
          {filtered.map((obs) => {
            const agentInfo = agentMap.get(obs.agentId);
            return (
              <div
                key={obs.id}
                className={`timeline-item${obs.blocked ? " timeline-item--blocked" : ""}`}
              >
                <div className="timeline-item__marker">
                  <span className={`timeline-dot${obs.blocked ? " blocked" : " allowed"}`} />
                </div>
                <div className="timeline-item__content">
                  <div className="timeline-item__header">
                    <span className="timeline-item__tool mono">{obs.toolName}</span>
                    <span className={`timeline-item__status ${obs.blocked ? "blocked" : "allowed"}`}>
                      {obs.blocked ? "Blocked" : "Allowed"}
                    </span>
                  </div>
                  <div className="timeline-item__meta">
                    <span className="timeline-item__agent">
                      <span>{agentInfo?.emoji || "\uD83E\uDD16"}</span>
                      <span>{agentInfo?.name || obs.agentId}</span>
                    </span>
                    {obs.category && (
                      <span className="chip">{obs.category}</span>
                    )}
                    {obs.accessPattern && (
                      <span className={`access-pill ${obs.accessPattern}`}>
                        {obs.accessPattern}
                      </span>
                    )}
                  </div>
                  {obs.error && (
                    <div className="timeline-item__error">
                      {obs.error}
                    </div>
                  )}
                </div>
                <div className="timeline-item__time">
                  <span className="timeline-item__timestamp">{formatTimestamp(obs.timestamp)}</span>
                  <span className="timeline-item__relative">{formatTime(obs.timestamp)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
