import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Bot, Zap, ShieldOff, AlertTriangle, Clock } from "lucide-react";
import {
  api,
  type RegisteredAgent,
  type DetectionResult,
  type DetectionSummary,
  type ObservationSummary,
  type AgenticHoursSummary,
  buildAgentMap,
} from "../lib/api";

// Scanner ID to human-readable name mapping
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

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  variant?: "default" | "success" | "warning" | "danger";
  link?: string;
}

function StatCard({ icon, label, value, variant = "default", link }: StatCardProps) {
  const content = (
    <div className={`stat-card stat-card--${variant}`}>
      <div className="stat-card__icon">{icon}</div>
      <div className="stat-card__content">
        <div className="stat-card__value">{value}</div>
        <div className="stat-card__label">{label}</div>
      </div>
    </div>
  );

  if (link) {
    return <Link to={link} className="stat-card-link">{content}</Link>;
  }
  return content;
}

export function OverviewPage() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [detections, setDetections] = useState<DetectionResult[]>([]);
  const [summary, setSummary] = useState<DetectionSummary | null>(null);
  const [observationSummary, setObservationSummary] = useState<ObservationSummary[]>([]);
  const [agenticHours, setAgenticHours] = useState<AgenticHoursSummary | null>(null);
  const [agentMap, setAgentMap] = useState<Map<string, { name: string; emoji: string }>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentsRes, detectionsRes, summaryRes, obsRes, discRes, hoursRes] = await Promise.all([
          api.listAgents(),
          api.getDetections({ limit: 10, unsafe: true }),
          api.getDetectionSummary(),
          api.getObservationSummary(),
          api.listDiscoveryAgents(),
          api.getAgenticHoursToday(),
        ]);
        if (cancelled) return;

        if (agentsRes.success) setAgents(agentsRes.data);
        if (detectionsRes.success) setDetections(detectionsRes.data);
        if (summaryRes.success) setSummary(summaryRes.data);
        if (obsRes.success) setObservationSummary(obsRes.data);
        if (hoursRes.success) setAgenticHours(hoursRes.data);

        const map = buildAgentMap(
          discRes.success ? discRes.data : [],
          agentsRes.success ? agentsRes.data : [],
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

  /** Format milliseconds as human-readable duration */
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return "0s";
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  };

  const activeAgents = agents.filter(a => a.status === "active").length;
  const totalActions = agenticHours?.toolCallCount ?? observationSummary.reduce((sum, o) => sum + o.totalCalls, 0);
  const blockedActions = observationSummary.reduce((sum, o) => sum + o.blockedCalls, 0);
  const securityAlerts = summary?.unsafe || 0;

  const riskLevel = (det: DetectionResult): { label: string; cls: string } => {
    if (det.sensitivityScore >= 0.8) return { label: "Critical", cls: "risk-critical" };
    if (det.sensitivityScore >= 0.6) return { label: "High", cls: "risk-high" };
    if (det.sensitivityScore >= 0.4) return { label: "Medium", cls: "risk-medium" };
    return { label: "Low", cls: "risk-low" };
  };

  const agentName = (agentId: string | null) => {
    if (!agentId) return "Unknown";
    const a = agentMap.get(agentId);
    return a ? `${a.emoji} ${a.name}` : agentId.slice(0, 8);
  };

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Agent status and security summary</p>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading dashboard...</div>
        </div>
      ) : (
        <>
          {/* Stats Grid */}
          <div className="stats-grid">
            <StatCard
              icon={<Clock size={24} />}
              label="Agentic Hours"
              value={formatDuration(agenticHours?.totalDurationMs ?? 0)}
            />
            <StatCard
              icon={<Bot size={24} />}
              label="Active Agents"
              value={activeAgents}
              variant="success"
              link="/agents"
            />
            <StatCard
              icon={<Zap size={24} />}
              label="Actions Today"
              value={totalActions}
              link="/activity"
            />
            <StatCard
              icon={<ShieldOff size={24} />}
              label="Blocked Actions"
              value={blockedActions}
              variant={blockedActions > 0 ? "warning" : "default"}
              link="/activity"
            />
            <StatCard
              icon={<AlertTriangle size={24} />}
              label="Security Alerts"
              value={securityAlerts}
              variant={securityAlerts > 0 ? "danger" : "success"}
              link="/security"
            />
          </div>

          {/* Recent Security Events */}
          <div className="overview-section">
            <div className="overview-section__header">
              <h2 className="overview-section__title">Recent Security Events</h2>
              <Link to="/security" className="overview-section__link">View all</Link>
            </div>

            {detections.length === 0 ? (
              <div className="card">
                <div className="card-title">No security events</div>
                <div className="card-sub">
                  No security risks have been detected. Your agents are operating safely.
                </div>
              </div>
            ) : (
              <div className="events-list">
                {detections.slice(0, 5).map((det) => {
                  const risk = riskLevel(det);
                  return (
                    <div key={det.id} className="event-item">
                      <div className="event-item__risk">
                        <span className={`access-pill ${risk.cls}`}>{risk.label}</span>
                      </div>
                      <div className="event-item__content">
                        <div className="event-item__agent">{agentName(det.agentId)}</div>
                        <div className="event-item__categories">
                          {det.categories.map((cat, i) => (
                            <span key={i} className="chip">{formatCategory(cat)}</span>
                          ))}
                        </div>
                      </div>
                      <div className="event-item__time">{formatTime(det.createdAt)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Agent Activity Summary */}
          <div className="overview-section">
            <div className="overview-section__header">
              <h2 className="overview-section__title">Agent Activity</h2>
              <Link to="/agents" className="overview-section__link">View all agents</Link>
            </div>

            {agents.length === 0 ? (
              <div className="card">
                <div className="card-title">No agents connected</div>
                <div className="card-sub">
                  Agents appear here after the MoltGuard plugin connects for the first time.
                </div>
              </div>
            ) : (
              <div className="activity-summary">
                {agents.slice(0, 5).map((agent) => {
                  const obs = observationSummary.find(o => o.agentId === agent.id);
                  const m = agent.metadata;
                  return (
                    <Link
                      key={agent.id}
                      to={`/agents/${m.openclawId || agent.id}`}
                      className="activity-summary__item"
                    >
                      <div className="activity-summary__avatar">
                        {m.emoji || "\uD83E\uDD16"}
                      </div>
                      <div className="activity-summary__info">
                        <div className="activity-summary__name">{agent.name}</div>
                        <div className="activity-summary__stats">
                          <span>{obs?.totalCalls || 0} actions</span>
                          <span className="activity-summary__dot" />
                          <span>{obs?.uniqueTools || 0} tools</span>
                          {obs && obs.blockedCalls > 0 && (
                            <>
                              <span className="activity-summary__dot" />
                              <span className="activity-summary__blocked">
                                {obs.blockedCalls} blocked
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="activity-summary__status">
                        <span className={`statusDot ${agent.status === "active" ? "ok" : "warn"}`} />
                        <span>{agent.status}</span>
                      </div>
                    </Link>
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
