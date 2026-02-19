import { useState, useEffect, useMemo } from "react";
import { api, type AgentPermission, type AgentLookup, buildAgentMap } from "../lib/api";

type SortField = "toolName" | "category" | "callCount" | "errorRate" | "lastSeen" | "firstSeen";
type SortDir = "asc" | "desc";

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function PermissionsPage() {
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [agentMap, setAgentMap] = useState<Map<string, AgentLookup>>(new Map());
  const [anomalyIds, setAnomalyIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("callCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    Promise.all([
      api.getAllPermissions(),
      api.listDiscoveryAgents(),
      api.listAgents(),
      api.getAnomalies(),
    ]).then(([permRes, discoveryRes, registeredRes, anomRes]) => {
      if (permRes.success) setPermissions(permRes.data);
      const discovery = discoveryRes.success ? discoveryRes.data : [];
      const registered = registeredRes.success ? registeredRes.data : [];
      setAgentMap(buildAgentMap(discovery, registered));
      if (anomRes.success) {
        setAnomalyIds(new Set(anomRes.data.map((a) => a.id)));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  };

  const filtered = useMemo(() => {
    let items = permissions;
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(
        (c) =>
          c.toolName.toLowerCase().includes(q) ||
          (c.category || "").toLowerCase().includes(q) ||
          (c.accessPattern || "").toLowerCase().includes(q) ||
          (agentMap.get(c.agentId)?.name || c.agentId).toLowerCase().includes(q),
      );
    }
    return [...items].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortField) {
        case "toolName":
          return dir * a.toolName.localeCompare(b.toolName);
        case "category":
          return dir * (a.category || "").localeCompare(b.category || "");
        case "callCount":
          return dir * (a.callCount - b.callCount);
        case "errorRate": {
          const rateA = a.callCount > 0 ? a.errorCount / a.callCount : 0;
          const rateB = b.callCount > 0 ? b.errorCount / b.callCount : 0;
          return dir * (rateA - rateB);
        }
        case "lastSeen":
          return dir * a.lastSeen.localeCompare(b.lastSeen);
        case "firstSeen":
          return dir * a.firstSeen.localeCompare(b.firstSeen);
        default:
          return 0;
      }
    });
  }, [permissions, search, sortField, sortDir, agentMap]);

  const uniqueTools = new Set(permissions.map((c) => c.toolName)).size;

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Permissions</h1>
          <p className="page-sub">
            All observed tool actions across your agents
          </p>
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
        <div className="pill">
          <span className="statusDot ok" />
          <span>
            {uniqueTools} tool{uniqueTools !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="pill">
          <span>{permissions.length} entr{permissions.length !== 1 ? "ies" : "y"}</span>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading permission data...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="card-title">No permissions observed</div>
          <div className="card-sub">
            {search
              ? "Try a different search term"
              : "Tool call observations will appear here once agents start making API calls."}
          </div>
        </div>
      ) : (
        <div className="perm-table-wrap">
          <table className="perm-table">
            <thead>
              <tr>
                <th />
                <th className="perm-th" onClick={() => handleSort("toolName")}>
                  Tool{sortIndicator("toolName")}
                </th>
                <th className="perm-th" onClick={() => handleSort("category")}>
                  Category{sortIndicator("category")}
                </th>
                <th className="perm-th">Access</th>
                <th className="perm-th">Agent</th>
                <th className="perm-th" onClick={() => handleSort("callCount")}>
                  Calls{sortIndicator("callCount")}
                </th>
                <th className="perm-th" onClick={() => handleSort("errorRate")}>
                  Errors{sortIndicator("errorRate")}
                </th>
                <th className="perm-th" onClick={() => handleSort("firstSeen")}>
                  First seen{sortIndicator("firstSeen")}
                </th>
                <th className="perm-th" onClick={() => handleSort("lastSeen")}>
                  Last seen{sortIndicator("lastSeen")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((perm) => {
                const agentInfo = agentMap.get(perm.agentId);
                const isAnomaly = anomalyIds.has(perm.id);
                const errorRate =
                  perm.callCount > 0
                    ? Math.round((perm.errorCount / perm.callCount) * 100)
                    : 0;
                return (
                  <tr key={perm.id} className="perm-row">
                    <td className="perm-td" style={{ width: 28 }}>
                      {isAnomaly && <span className="anomaly-dot" title="First-seen tool" />}
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
                    <td className="perm-td">
                      <span className="perm-agent">
                        <span>{agentInfo?.emoji || "\uD83E\uDD16"}</span>
                        <span>{agentInfo?.name || perm.agentId}</span>
                      </span>
                    </td>
                    <td className="perm-td perm-td--num">{perm.callCount}</td>
                    <td className="perm-td perm-td--num">
                      {perm.errorCount > 0 ? (
                        <span style={{ color: "var(--danger)" }}>
                          {perm.errorCount} ({errorRate}%)
                        </span>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>0</span>
                      )}
                    </td>
                    <td className="perm-td perm-td--date">
                      {formatDate(perm.firstSeen)}
                    </td>
                    <td className="perm-td perm-td--date">
                      {formatTime(perm.lastSeen)}
                    </td>
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
