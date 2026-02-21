import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, type DiscoveredAgent } from "../lib/api";

const MAX_VISIBLE_SKILLS = 4;

export function AgentsPage() {
  const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    api.listDiscoveryAgents().then((res) => {
      if (res.success) setAgents(res.data);
      setLoading(false);
    });
  }, []);

  const handleScan = async () => {
    setScanning(true);
    const res = await api.scanAgents();
    if (res.success) setAgents(res.data);
    setScanning(false);
  };

  const filtered = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.creature.toLowerCase().includes(q) ||
      a.model.toLowerCase().includes(q) ||
      a.provider.toLowerCase().includes(q) ||
      a.ownerName.toLowerCase().includes(q) ||
      a.skills.some((s) => s.name.toLowerCase().includes(q))
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
          <p className="page-sub">AI agents detected in your environment</p>
        </div>
        <div className="page-meta">
          <button className="btn" onClick={handleScan} disabled={scanning}>
            {scanning ? "Scanning..." : "Scan"}
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="field" style={{ minWidth: 260 }}>
          <input
            type="text"
            placeholder="Search agents, skills, models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="pill">
          <span className="statusDot ok" />
          <span>{agents.length} agent{agents.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Scanning for agents...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="card-title">No agents found</div>
          <div className="card-sub">
            {search
              ? "Try a different search term"
              : "No OpenClaw agents detected. Make sure ~/.openclaw/ exists."}
          </div>
        </div>
      ) : (
        <div className="agents-grid">
          {filtered.map((agent, i) => (
            <Link
              key={agent.id}
              to={`/inventory/agents/${agent.id}`}
              className={`agent-card stagger-${Math.min(i + 1, 6)}`}
            >
              <div className="agent-card__header">
                <div className="agent-card__avatar">
                  {agent.avatarUrl ? (
                    <img src={agent.avatarUrl} alt={agent.name} className="agent-card__avatar-img" />
                  ) : (
                    agent.emoji
                  )}
                </div>
                <div className="agent-card__info">
                  <div className="agent-card__name">{agent.name}</div>
                  {agent.creature && (
                    <div className="agent-card__creature">{agent.creature}</div>
                  )}
                </div>
              </div>

              <div className="agent-card__model">
                <span>{agent.provider}</span>
                <span>/</span>
                <span>{agent.model}</span>
              </div>

              {agent.channels.length > 0 && (
                <div className="agent-card__channels">
                  {agent.channels.map((ch) => (
                    <span key={ch} className="channel-pill">{ch}</span>
                  ))}
                </div>
              )}

              {agent.ownerName && (
                <div className="agent-card__owner">{agent.ownerName}</div>
              )}

              {agent.skills.length > 0 && (
                <div className="agent-card__skills">
                  {agent.skills.slice(0, MAX_VISIBLE_SKILLS).map((s) => (
                    <span key={s.name} className="skill-pill">{s.name}</span>
                  ))}
                  {agent.skills.length > MAX_VISIBLE_SKILLS && (
                    <span className="skill-pill overflow">
                      +{agent.skills.length - MAX_VISIBLE_SKILLS}
                    </span>
                  )}
                </div>
              )}

              <div className="agent-card__footer">
                <span>{agent.sessionCount} session{agent.sessionCount !== 1 ? "s" : ""}</span>
                <span>{formatTime(agent.lastActive)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
