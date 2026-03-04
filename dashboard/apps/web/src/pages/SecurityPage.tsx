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

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Security</h1>
          <p className="page-sub">Security risks detected across agents</p>
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
      ) : detections.length === 0 ? (
        <div className="card">
          <div className="card-title">No risks detected</div>
          <div className="card-sub">
            No security risks have been detected. Your agents are operating safely.
          </div>
        </div>
      ) : (
        <div className="risk-table-wrap">
          <table className="perm-table">
            <thead>
              <tr>
                <th className="perm-th">Risk</th>
                <th className="perm-th">Agent</th>
                <th className="perm-th">Categories</th>
                <th className="perm-th">Findings</th>
                <th className="perm-th">Detected</th>
              </tr>
            </thead>
            <tbody>
              {detections.map((det) => {
                const risk = riskLevel(det);
                return (
                  <tr key={det.id} className="perm-row">
                    <td className="perm-td">
                      <span className={`access-pill ${risk.cls}`}>{risk.label}</span>
                    </td>
                    <td className="perm-td">
                      <span>{agentName(det.agentId)}</span>
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
