import { useState, useEffect } from "react";
import { Key, FileKey, Lock, AlertTriangle } from "lucide-react";
import {
  api,
  type DetectionResult,
  buildAgentMap,
} from "../lib/api";

// Scanners for sensitive data (S07-S09)
const SECRET_SCANNERS = ["S07", "S08", "S09"];
const SCANNER_NAMES: Record<string, string> = {
  S07: "PII Exposure",
  S08: "Credential Leakage",
  S09: "Confidential Data",
};

const SCANNER_DESCRIPTIONS: Record<string, string> = {
  S07: "Personally identifiable information like names, emails, phone numbers, SSNs",
  S08: "API keys, passwords, tokens, SSH keys, database credentials",
  S09: "Internal documents, proprietary code, trade secrets",
};

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

interface ProtectedItem {
  type: "api_key" | "env_file" | "ssh_key" | "pii" | "credential";
  label: string;
  icon: React.ReactNode;
  count: number;
  description: string;
}

export function SecretsPage() {
  const [detections, setDetections] = useState<DetectionResult[]>([]);
  const [agentMap, setAgentMap] = useState<Map<string, { name: string; emoji: string }>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [detectionsRes, discRes, regRes] = await Promise.all([
          api.getDetections({ limit: 200 }),
          api.listDiscoveryAgents(),
          api.listAgents(),
        ]);
        if (cancelled) return;

        if (detectionsRes.success) {
          // Filter to only S07-S09 detections
          const secretDetections = detectionsRes.data.filter(d =>
            d.categories.some(cat => SECRET_SCANNERS.includes(cat))
          );
          setDetections(secretDetections);
        }

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

  // Calculate protected items based on detections
  const protectedItems: ProtectedItem[] = [
    {
      type: "api_key",
      label: "API Keys",
      icon: <Key size={20} />,
      count: detections.filter(d => d.categories.includes("S08")).length,
      description: "API keys, tokens, and authentication secrets",
    },
    {
      type: "env_file",
      label: ".env Files",
      icon: <FileKey size={20} />,
      count: detections.filter(d =>
        d.findings?.some(f => f.matchedText?.includes(".env"))
      ).length,
      description: "Environment configuration files",
    },
    {
      type: "ssh_key",
      label: "SSH Keys",
      icon: <Lock size={20} />,
      count: detections.filter(d =>
        d.findings?.some(f =>
          f.matchedText?.includes("ssh") ||
          f.name?.toLowerCase().includes("ssh")
        )
      ).length,
      description: "SSH private and public keys",
    },
    {
      type: "pii",
      label: "PII Data",
      icon: <AlertTriangle size={20} />,
      count: detections.filter(d => d.categories.includes("S07")).length,
      description: "Personal identifiable information",
    },
  ];

  const agentName = (agentId: string | null) => {
    if (!agentId) return "Unknown";
    const a = agentMap.get(agentId);
    return a ? `${a.emoji} ${a.name}` : agentId.slice(0, 8);
  };

  const riskLevel = (det: DetectionResult): { label: string; cls: string } => {
    if (det.sensitivityScore >= 0.8) return { label: "Critical", cls: "risk-critical" };
    if (det.sensitivityScore >= 0.6) return { label: "High", cls: "risk-high" };
    if (det.sensitivityScore >= 0.4) return { label: "Medium", cls: "risk-medium" };
    return { label: "Low", cls: "risk-low" };
  };

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Secrets</h1>
          <p className="page-sub">Sensitive data protection and detection</p>
        </div>
        <div className="page-meta">
          <div className="pill">
            <span className={`statusDot ${detections.length > 0 ? "warn" : "ok"}`} />
            <span>{detections.length} detection{detections.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading secrets data...</div>
        </div>
      ) : (
        <>
          {/* Protected Items Grid */}
          <div className="secrets-grid">
            {protectedItems.map((item) => (
              <div key={item.type} className="secrets-card">
                <div className="secrets-card__icon">{item.icon}</div>
                <div className="secrets-card__content">
                  <div className="secrets-card__label">{item.label}</div>
                  <div className="secrets-card__description">{item.description}</div>
                </div>
                <div className="secrets-card__count">
                  {item.count > 0 ? (
                    <span className="secrets-card__badge warn">{item.count}</span>
                  ) : (
                    <span className="secrets-card__badge ok">0</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Scanner Categories */}
          <div className="secrets-section">
            <h2 className="secrets-section__title">Protection Categories</h2>
            <div className="scanner-list">
              {SECRET_SCANNERS.map((scanner) => {
                const count = detections.filter(d => d.categories.includes(scanner)).length;
                return (
                  <div key={scanner} className="scanner-item">
                    <div className="scanner-item__header">
                      <span className="scanner-item__id mono">{scanner}</span>
                      <span className="scanner-item__name">{SCANNER_NAMES[scanner]}</span>
                    </div>
                    <div className="scanner-item__description">
                      {SCANNER_DESCRIPTIONS[scanner]}
                    </div>
                    <div className="scanner-item__count">
                      {count} detection{count !== 1 ? "s" : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent Detections */}
          <div className="secrets-section">
            <h2 className="secrets-section__title">Recent Detections</h2>
            {detections.length === 0 ? (
              <div className="card">
                <div className="card-title">No sensitive data detected</div>
                <div className="card-sub">
                  No PII, credentials, or confidential data has been detected in agent activity.
                </div>
              </div>
            ) : (
              <div className="detections-list">
                {detections.slice(0, 10).map((det) => {
                  const risk = riskLevel(det);
                  return (
                    <div key={det.id} className="detection-item">
                      <div className="detection-item__risk">
                        <span className={`access-pill ${risk.cls}`}>{risk.label}</span>
                      </div>
                      <div className="detection-item__content">
                        <div className="detection-item__agent">{agentName(det.agentId)}</div>
                        <div className="detection-item__categories">
                          {det.categories
                            .filter(cat => SECRET_SCANNERS.includes(cat))
                            .map((cat, i) => (
                              <span key={i} className="chip">{SCANNER_NAMES[cat]}</span>
                            ))}
                        </div>
                        {det.findings && det.findings.length > 0 && (
                          <div className="detection-item__findings">
                            {det.findings.slice(0, 2).map((f, i) => (
                              <span key={i} className="detection-finding">
                                {f.name}
                              </span>
                            ))}
                            {det.findings.length > 2 && (
                              <span className="detection-finding more">
                                +{det.findings.length - 2} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="detection-item__time">{formatTime(det.createdAt)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
