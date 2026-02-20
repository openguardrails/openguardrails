import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type AgentPermission,
  type DiscoveredAgent,
  type RegisteredAgent,
  buildAgentMap,
} from "../lib/api";

export function RiskPage() {
  const [anomalies, setAnomalies] = useState<AgentPermission[]>([]);
  const [agentMap, setAgentMap] = useState<Map<string, { name: string; emoji: string }>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [anomRes, discRes, regRes] = await Promise.all([
          api.getAnomalies(),
          api.listDiscoveryAgents(),
          api.listAgents(),
        ]);
        if (cancelled) return;
        if (anomRes.success) setAnomalies(anomRes.data);
        const map = buildAgentMap(
          discRes.success ? discRes.data : [],
          regRes.success ? regRes.data : [],
        );
        setAgentMap(map);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const riskLevel = (perm: AgentPermission): { label: string; cls: string } => {
    if (perm.accessPattern === "admin") return { label: "High", cls: "risk-high" };
    if (perm.accessPattern === "write") return { label: "Medium", cls: "risk-medium" };
    return { label: "Low", cls: "risk-low" };
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleString();
  };

  const agentName = (agentId: string) => {
    const a = agentMap.get(agentId);
    return a ? `${a.emoji} ${a.name}` : agentId.slice(0, 8);
  };

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Risk</h1>
          <p className="page-sub">Anomalies and security risks detected across agents</p>
        </div>
        <div className="page-meta">
          <div className="pill">
            <span className={`statusDot ${anomalies.length > 0 ? "warn" : "ok"}`} />
            <span>{anomalies.length} finding{anomalies.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading risk data...</div>
        </div>
      ) : anomalies.length === 0 ? (
        <div className="card">
          <div className="card-title">No risks detected</div>
          <div className="card-sub">
            No anomalous permissions or first-seen tools have been flagged.
          </div>
        </div>
      ) : (
        <div className="risk-table-wrap">
          <table className="perm-table">
            <thead>
              <tr>
                <th className="perm-th">Risk</th>
                <th className="perm-th">Agent</th>
                <th className="perm-th">Tool</th>
                <th className="perm-th">Category</th>
                <th className="perm-th">Access</th>
                <th className="perm-th">Calls</th>
                <th className="perm-th">First seen</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((perm) => {
                const risk = riskLevel(perm);
                return (
                  <tr key={perm.id} className="perm-row">
                    <td className="perm-td">
                      <span className={`access-pill ${risk.cls}`}>{risk.label}</span>
                    </td>
                    <td className="perm-td">
                      <span>{agentName(perm.agentId)}</span>
                    </td>
                    <td className="perm-td">
                      <span className="mono">{perm.toolName}</span>
                    </td>
                    <td className="perm-td">
                      <span className="chip">{perm.category || "unknown"}</span>
                    </td>
                    <td className="perm-td">
                      <span className={`access-pill ${perm.accessPattern}`}>
                        {perm.accessPattern || "unknown"}
                      </span>
                    </td>
                    <td className="perm-td perm-td--num">{perm.callCount}</td>
                    <td className="perm-td perm-td--date">{formatDate(perm.firstSeen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
