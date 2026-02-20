import { useState, useEffect } from "react";
import {
  api,
  type DiscoveredAgent,
  type AgentProfile,
  type AgentPermission,
} from "../lib/api";
import { IdentityGraph } from "../components/IdentityGraph";

export function GraphPage() {
  const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingGraph, setLoadingGraph] = useState(false);

  useEffect(() => {
    api.listDiscoveryAgents().then((res) => {
      if (res.success) {
        setAgents(res.data);
        if (res.data.length > 0) {
          setSelectedId(res.data[0].id);
        }
      }
      setLoadingAgents(false);
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingGraph(true);
    (async () => {
      try {
        const profileRes = await api.getAgentProfile(selectedId);
        if (cancelled) return;
        if (profileRes.success) {
          setProfile(profileRes.data);
          const permId = profileRes.data.registeredAgentId || selectedId;
          const permRes = await api.getAgentPermissions(permId);
          if (!cancelled && permRes.success) setPermissions(permRes.data);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingGraph(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Graph</h1>
          <p className="page-sub">Identity graph — owner, agent, systems, and tool connections</p>
        </div>
      </div>

      {loadingAgents ? (
        <div className="card">
          <div className="card-sub">Loading agents...</div>
        </div>
      ) : agents.length === 0 ? (
        <div className="card">
          <div className="card-title">No agents found</div>
          <div className="card-sub">
            No agents discovered yet. Run a scan from the Inventory page.
          </div>
        </div>
      ) : (
        <>
          <div className="filters">
            <div className="field" style={{ minWidth: 260 }}>
              <select
                value={selectedId || ""}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.emoji} {agent.name}
                  </option>
                ))}
              </select>
            </div>
            {profile && (
              <div className="pill">
                <span className="mono" style={{ fontSize: 11 }}>
                  {profile.provider} / {profile.model}
                </span>
              </div>
            )}
          </div>

          {loadingGraph ? (
            <div className="card">
              <div className="card-sub">Loading identity graph...</div>
            </div>
          ) : profile ? (
            <div className="graph-page-wrap">
              <IdentityGraph profile={profile} permissions={permissions} />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
