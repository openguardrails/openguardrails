import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, type RegisteredAgent } from "../lib/api";

const MAX_VISIBLE_SKILLS = 4;

export function AgentsPage() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.listAgents().then((res) => {
      if (res.success) setAgents(res.data);
      setLoading(false);
    });
  }, []);

  const filtered = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const m = a.metadata;
    return (
      a.name.toLowerCase().includes(q) ||
      (a.description ?? "").toLowerCase().includes(q) ||
      a.provider.toLowerCase().includes(q) ||
      (m.model ?? "").toLowerCase().includes(q) ||
      (m.creature ?? "").toLowerCase().includes(q) ||
      (m.ownerName ?? "").toLowerCase().includes(q) ||
      (m.skills ?? []).some((s) => s.name.toLowerCase().includes(q))
    );
  });

  const formatTime = (iso: string | null) => {
    if (!iso) return "Never";
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
  };

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">AI Agents</h1>
          <p className="page-sub">AI agents connected to OpenGuardrails</p>
        </div>
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 260 }}>
          <input
            type="text"
            placeholder="Search agents, models, skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="pill">
          <span className="statusDot ok" />
          <span>{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading agents...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="card-title">No agents found</div>
          <div className="card-sub">
            {search
              ? "Try a different search term"
              : "Agents appear here after the MoltGuard plugin connects for the first time."}
          </div>
        </div>
      ) : (
        <div className="agents-grid">
          {filtered.map((agent, i) => {
            const m = agent.metadata;
            const skills = m.skills ?? [];
            const model = m.model || "";
            const provider = agent.provider !== "custom" ? agent.provider : (m.model ? "" : "");
            const modelLine = [provider, model].filter(Boolean).join("/");

            // Use openclawId if available so the discovery profile route can match it
            const profileId = (m.openclawId as string | undefined) ?? agent.id;

            return (
              <Link
                key={agent.id}
                to={`/inventory/agents/${profileId}`}
                className={`agent-card stagger-${Math.min(i + 1, 6)}`}
              >
                <div className="agent-card__header">
                  <div className="agent-card__avatar">
                    {m.emoji || "🤖"}
                  </div>
                  <div className="agent-card__info">
                    <div className="agent-card__name">{agent.name}</div>
                    {m.creature && (
                      <div className="agent-card__creature">{m.creature}</div>
                    )}
                  </div>
                </div>

                {modelLine && (
                  <div className="agent-card__model">
                    {modelLine.includes("/") ? (
                      <>
                        <span>{modelLine.split("/")[0]}</span>
                        <span>/</span>
                        <span>{modelLine.split("/")[1]}</span>
                      </>
                    ) : (
                      <span>{modelLine}</span>
                    )}
                  </div>
                )}

                {m.ownerName && (
                  <div className="agent-card__owner">{m.ownerName}</div>
                )}

                {skills.length > 0 && (
                  <div className="agent-card__skills">
                    {skills.slice(0, MAX_VISIBLE_SKILLS).map((s) => (
                      <span key={s.name} className="skill-pill">{s.name}</span>
                    ))}
                    {skills.length > MAX_VISIBLE_SKILLS && (
                      <span className="skill-pill overflow">
                        +{skills.length - MAX_VISIBLE_SKILLS}
                      </span>
                    )}
                  </div>
                )}

                <div className="agent-card__footer">
                  <span className={`statusDot ${agent.status === "active" ? "ok" : "warn"}`} style={{ display: "inline-block", marginRight: 4 }} />
                  <span>{agent.status}</span>
                  <span>{formatTime(agent.lastSeenAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
