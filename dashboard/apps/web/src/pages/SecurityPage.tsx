import { useState, useEffect } from "react";
import {
  api,
  type DetectionResult,
  type DetectionSummary,
  buildAgentMap,
} from "../lib/api";

// Scanner ID to human-readable name mapping (matches Core definitions)
const SCANNER_NAMES: Record<string, string> = {
  S01: "Prompt Injection",
  S02: "System Override",
  S03: "Web Attacks",
  S04: "MCP Tool Poisoning",
  S05: "Malicious Code Execution",
  S06: "NSFW Content",
  S07: "PII Exposure",
  S08: "Credential Leakage",
  S09: "Confidential Data",
  S10: "Off-Topic Drift",
};

function formatCategory(cat: string): string {
  return SCANNER_NAMES[cat] || cat;
}

export function SecurityPage() {
  const [detections, setDetections] = useState<DetectionResult[]>([]);
  const [summary, setSummary] = useState<DetectionSummary | null>(null);
  const [agentMap, setAgentMap] = useState<Map<string, { name: string; emoji: string }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | "static" | "dynamic">("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [detRes, summaryRes, discRes, regRes] = await Promise.all([
          api.getDetections({ limit: 100, unsafe: true }),
          api.getDetectionSummary(),
          api.listDiscoveryAgents(),
          api.listAgents(),
        ]);
        if (cancelled) return;

        if (detRes.success) setDetections(detRes.data);
        if (summaryRes.success) setSummary(summaryRes.data);

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

  const riskLevel = (det: DetectionResult): { label: string; cls: string } => {
    if (det.sensitivityScore >= 0.8) return { label: "Critical", cls: "risk-critical" };
    if (det.sensitivityScore >= 0.6) return { label: "High", cls: "risk-high" };
    if (det.sensitivityScore >= 0.4) return { label: "Medium", cls: "risk-medium" };
    return { label: "Low", cls: "risk-low" };
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleString();
  };

  const agentName = (agentId: string | null) => {
    if (!agentId) return "Unknown";
    const a = agentMap.get(agentId);
    return a ? `${a.emoji} ${a.name}` : agentId.slice(0, 8);
  };

  // Check for quota exceeded findings
  const quotaExceeded = detections.some(d =>
    d.findings?.some(f => f.scanner === "quota" && f.name === "quota_exceeded")
  );

  // Filter detections by tab
  const filteredDetections = detections.filter(d => {
    if (activeTab === "static") return d.scanType === "static";
    if (activeTab === "dynamic") return d.scanType === "dynamic" || !d.scanType;
    return true; // "all"
  });

  // Count static vs dynamic
  const staticCount = detections.filter(d => d.scanType === "static").length;
  const dynamicCount = detections.filter(d => d.scanType === "dynamic" || !d.scanType).length;

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Security</h1>
          <p className="page-sub">Security risks detected across agents and workspace files</p>
        </div>
        <div className="page-meta">
          {summary && (
            <>
              <div className="pill">
                <span className="statusDot ok" />
                <span>{summary.safe} safe</span>
              </div>
              <div className="pill">
                <span className={`statusDot ${summary.unsafe > 0 ? "warn" : "ok"}`} />
                <span>{summary.unsafe} risk{summary.unsafe !== 1 ? "s" : ""}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Tabs for Static vs Dynamic */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        <button
          onClick={() => setActiveTab("all")}
          className={`pill ${activeTab === "all" ? "active" : ""}`}
          style={{
            background: activeTab === "all" ? "var(--accent)" : "var(--bg2)",
            color: activeTab === "all" ? "#fff" : "var(--fg)",
            cursor: "pointer",
            border: "none",
          }}
        >
          All ({detections.length})
        </button>
        <button
          onClick={() => setActiveTab("static")}
          className={`pill ${activeTab === "static" ? "active" : ""}`}
          style={{
            background: activeTab === "static" ? "var(--accent)" : "var(--bg2)",
            color: activeTab === "static" ? "#fff" : "var(--fg)",
            cursor: "pointer",
            border: "none",
          }}
        >
          Static Scans ({staticCount})
        </button>
        <button
          onClick={() => setActiveTab("dynamic")}
          className={`pill ${activeTab === "dynamic" ? "active" : ""}`}
          style={{
            background: activeTab === "dynamic" ? "var(--accent)" : "var(--bg2)",
            color: activeTab === "dynamic" ? "#fff" : "var(--fg)",
            cursor: "pointer",
            border: "none",
          }}
        >
          Runtime Detections ({dynamicCount})
        </button>
      </div>

      {quotaExceeded && (
        <div className="card" style={{ background: "#fef3c7", borderColor: "#f59e0b", marginBottom: "16px" }}>
          <div className="card-title" style={{ color: "#92400e" }}>Quota Exceeded</div>
          <div className="card-sub" style={{ color: "#78350f" }}>
            Your detection quota has been exceeded. Some scans were skipped.
            <br />
            <a href="https://openguardrails.com/pricing" target="_blank" rel="noopener noreferrer"
               style={{ color: "#d97706", fontWeight: 600 }}>
              Upgrade your plan to continue protection →
            </a>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading security data...</div>
        </div>
      ) : filteredDetections.length === 0 ? (
        <div className="card">
          <div className="card-title">No risks detected</div>
          <div className="card-sub">
            {activeTab === "all"
              ? "No security risks have been detected. Your agents are operating safely."
              : activeTab === "static"
              ? "No static security risks found in workspace files. Run `/og_scan` to scan your files."
              : "No runtime security risks detected. Your agents are operating safely."
            }
          </div>
        </div>
      ) : (
        <div className="risk-table-wrap">
          <table className="perm-table">
            <thead>
              <tr>
                <th className="perm-th">Risk</th>
                <th className="perm-th">{activeTab === "static" ? "File / Agent" : "Agent"}</th>
                <th className="perm-th">Categories</th>
                <th className="perm-th">Findings</th>
                <th className="perm-th">Detected</th>
              </tr>
            </thead>
            <tbody>
              {filteredDetections.map((det) => {
                const risk = riskLevel(det);
                return (
                  <tr key={det.id} className="perm-row">
                    <td className="perm-td">
                      <span className={`access-pill ${risk.cls}`}>{risk.label}</span>
                    </td>
                    <td className="perm-td">
                      {det.scanType === "static" && det.filePath ? (
                        <div>
                          <div style={{ fontWeight: 500 }}>{det.filePath}</div>
                          <div style={{ fontSize: "0.85em", color: "var(--fg3)", marginTop: "2px" }}>
                            {det.fileType ? `[${det.fileType}] ` : ""}{agentName(det.agentId)}
                          </div>
                        </div>
                      ) : (
                        <span>{agentName(det.agentId)}</span>
                      )}
                    </td>
                    <td className="perm-td">
                      {det.categories.length > 0 ? (
                        det.categories.map((cat, i) => (
                          <span key={i} className="chip" style={{ marginRight: 4 }}>{formatCategory(cat)}</span>
                        ))
                      ) : (
                        <span className="chip">unknown</span>
                      )}
                    </td>
                    <td className="perm-td">
                      {det.findings?.length > 0 ? (
                        <span title={det.findings.map(f => `${f.scanner}: ${f.name}`).join(", ")}>
                          {det.findings.length} finding{det.findings.length !== 1 ? "s" : ""}
                        </span>
                      ) : (
                        <span>-</span>
                      )}
                    </td>
                    <td className="perm-td perm-td--date">{formatDate(det.createdAt)}</td>
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
