import { useState, useEffect } from "react";
import { api, type AgentCapability, type DiscoveredAgent } from "../lib/api";

interface IdentityGroup {
  category: string;
  capabilities: AgentCapability[];
  agents: Set<string>;
  targets: Set<string>;
  totalCalls: number;
  lastSeen: string;
  accessPatterns: Set<string>;
}

const CATEGORY_LABELS: Record<string, string> = {
  github: "GitHub",
  slack: "Slack",
  gmail: "Gmail",
  filesystem: "Filesystem",
  shell: "Shell",
  jira: "Jira",
  confluence: "Confluence",
  linear: "Linear",
  notion: "Notion",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  redis: "Redis",
  docker: "Docker",
  aws: "AWS",
  gcp: "GCP",
  azure: "Azure",
};

function formatCategory(cat: string): string {
  return CATEGORY_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
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

export function IdentitiesPage() {
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getAllCapabilities(), api.listDiscoveryAgents()]).then(
      ([capRes, agentRes]) => {
        if (capRes.success) setCapabilities(capRes.data);
        if (agentRes.success) setAgents(agentRes.data);
        setLoading(false);
      },
    );
  }, []);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Group capabilities by category
  const groupMap = new Map<string, IdentityGroup>();
  for (const cap of capabilities) {
    const cat = cap.category || "unknown";
    let group = groupMap.get(cat);
    if (!group) {
      group = {
        category: cat,
        capabilities: [],
        agents: new Set(),
        targets: new Set(),
        totalCalls: 0,
        lastSeen: cap.lastSeen,
        accessPatterns: new Set(),
      };
      groupMap.set(cat, group);
    }
    group.capabilities.push(cap);
    group.agents.add(cap.agentId);
    group.totalCalls += cap.callCount;
    if (cap.accessPattern) group.accessPatterns.add(cap.accessPattern);
    if (cap.lastSeen > group.lastSeen) group.lastSeen = cap.lastSeen;
    const targets = cap.targetsJson || [];
    for (const t of targets) group.targets.add(t);
  }

  const groups = [...groupMap.values()].sort(
    (a, b) => b.totalCalls - a.totalCalls,
  );

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Identities</h1>
          <p className="page-sub">
            Third-party systems and accounts accessed by your agents
          </p>
        </div>
        <div className="page-meta">
          <div className="pill">
            <span className="statusDot ok" />
            <span>
              {groups.length} system{groups.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading identity data...</div>
        </div>
      ) : groups.length === 0 ? (
        <div className="card">
          <div className="card-title">No identities observed</div>
          <div className="card-sub">
            Tool call observations will appear here once agents start making API
            calls.
          </div>
        </div>
      ) : (
        <div className="identity-grid">
          {groups.map((group, i) => {
            const isExpanded = expandedCategory === group.category;
            return (
              <div
                key={group.category}
                className={`identity-card stagger-${Math.min(i + 1, 6)}`}
              >
                <button
                  className="identity-card__header"
                  onClick={() =>
                    setExpandedCategory(isExpanded ? null : group.category)
                  }
                >
                  <div className="identity-card__title">
                    <span className="identity-card__name">
                      {formatCategory(group.category)}
                    </span>
                    <span className="identity-card__category mono">
                      {group.category}
                    </span>
                  </div>
                  <span className="identity-card__chevron">
                    {isExpanded ? "\u25B2" : "\u25BC"}
                  </span>
                </button>

                <div className="identity-card__stats">
                  <div className="identity-stat">
                    <span className="identity-stat__label">Agents</span>
                    <span className="identity-stat__value">
                      {group.agents.size}
                    </span>
                  </div>
                  <div className="identity-stat">
                    <span className="identity-stat__label">Calls</span>
                    <span className="identity-stat__value">
                      {group.totalCalls}
                    </span>
                  </div>
                  <div className="identity-stat">
                    <span className="identity-stat__label">Tools</span>
                    <span className="identity-stat__value">
                      {group.capabilities.length}
                    </span>
                  </div>
                  <div className="identity-stat">
                    <span className="identity-stat__label">Last seen</span>
                    <span className="identity-stat__value">
                      {formatTime(group.lastSeen)}
                    </span>
                  </div>
                </div>

                <div className="identity-card__pills">
                  {[...group.accessPatterns].map((ap) => (
                    <span key={ap} className={`access-pill ${ap}`}>
                      {ap}
                    </span>
                  ))}
                </div>

                {group.targets.size > 0 && (
                  <div className="identity-card__targets">
                    {[...group.targets].slice(0, 8).map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                    {group.targets.size > 8 && (
                      <span className="chip" style={{ borderStyle: "dashed", color: "var(--muted)" }}>
                        +{group.targets.size - 8}
                      </span>
                    )}
                  </div>
                )}

                {isExpanded && (
                  <div className="identity-card__detail">
                    <div className="identity-detail__section">
                      <div className="identity-detail__heading">
                        Agents accessing this system
                      </div>
                      <div className="identity-detail__agents">
                        {[...group.agents].map((agentId) => {
                          const agent = agentMap.get(agentId);
                          return (
                            <div key={agentId} className="identity-agent-row">
                              <span className="identity-agent-row__avatar">
                                {agent?.emoji || "\uD83E\uDD16"}
                              </span>
                              <span className="identity-agent-row__name">
                                {agent?.name || agentId}
                              </span>
                              <span className="mono" style={{ color: "var(--muted)", marginLeft: "auto" }}>
                                {
                                  group.capabilities.filter(
                                    (c) => c.agentId === agentId,
                                  ).length
                                }{" "}
                                tools
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="identity-detail__section">
                      <div className="identity-detail__heading">
                        Tools observed
                      </div>
                      <div className="identity-detail__tools">
                        {group.capabilities.map((cap) => (
                          <div key={cap.id} className="identity-tool-row">
                            <span className="mono">{cap.toolName}</span>
                            <span className={`access-pill ${cap.accessPattern}`}>
                              {cap.accessPattern}
                            </span>
                            <span className="identity-tool-row__count">
                              {cap.callCount}x
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
