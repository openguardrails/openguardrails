import { useEffect, useState } from "react";
import { api, type GatewayActivityEvent, type GatewayActivityStats } from "../lib/api";

interface GatewayStatus {
  enabled: boolean;
  running: boolean;
  pid?: number;
  port: number;
  url: string;
  agents: string[];
  providers: string[];
  enabledAt: string | null;
  backends: string[];
}

interface GatewayConfig {
  configured: boolean;
  port: number;
  backends: Record<string, { baseUrl: string; hasApiKey: boolean }>;
  routing?: Record<string, string>;
}

interface GatewayHealth {
  healthy: boolean;
  status?: string;
  version?: string;
  error?: string;
}

type TabType = "status" | "activity";

export function GatewayPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [activity, setActivity] = useState<GatewayActivityEvent[]>([]);
  const [activityStats, setActivityStats] = useState<GatewayActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("status");

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const [statusRes, configRes, healthRes, activityRes, statsRes] = await Promise.all([
          api.getGatewayStatus(),
          api.getGatewayConfig(),
          api.getGatewayHealth(),
          api.getGatewayActivity({ limit: 50 }),
          api.getGatewayActivityStats(),
        ]);

        if (cancelled) return;

        if (statusRes.success) setStatus(statusRes.data);
        if (configRes.success) setConfig(configRes.data);
        if (healthRes.success) setHealth(healthRes.data);
        if (activityRes.success) setActivity(activityRes.data);
        if (statsRes.success) setActivityStats(statsRes.data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load gateway data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();

    // Refresh every 10 seconds
    const interval = setInterval(loadData, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <>
        <div className="content-header">
          <h1 className="page-title">AI Security Gateway</h1>
          <p className="page-sub">Data sanitization proxy for LLM API calls</p>
        </div>
        <div className="card">Loading...</div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="content-header">
          <h1 className="page-title">AI Security Gateway</h1>
          <p className="page-sub">Data sanitization proxy for LLM API calls</p>
        </div>
        <div className="card" style={{ color: "#dc2626" }}>Error: {error}</div>
      </>
    );
  }

  return (
    <>
      <div className="content-header">
        <h1 className="page-title">AI Security Gateway</h1>
        <p className="page-sub">Data sanitization proxy for LLM API calls</p>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        <button
          onClick={() => setActiveTab("status")}
          style={{
            padding: "8px 16px",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
            background: activeTab === "status" ? "#3b82f6" : "#f1f5f9",
            color: activeTab === "status" ? "white" : "#64748b",
            fontWeight: 500,
          }}
        >
          Status
        </button>
        <button
          onClick={() => setActiveTab("activity")}
          style={{
            padding: "8px 16px",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
            background: activeTab === "activity" ? "#3b82f6" : "#f1f5f9",
            color: activeTab === "activity" ? "white" : "#64748b",
            fontWeight: 500,
          }}
        >
          Activity {activity.length > 0 && `(${activity.length})`}
        </button>
      </div>

      {activeTab === "activity" && (
        <>
          {/* Activity Stats */}
          {activityStats && (
            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-card__icon" style={{ background: "#dcfce7" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div className="stat-card__content">
                  <div className="stat-card__label">Sanitizations (24h)</div>
                  <div className="stat-card__value">{activityStats.last24Hours.sanitizeCount}</div>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-card__icon" style={{ background: "#dbeafe" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <div className="stat-card__content">
                  <div className="stat-card__label">Restorations (24h)</div>
                  <div className="stat-card__value">{activityStats.last24Hours.restoreCount}</div>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-card__icon" style={{ background: "#fef3c7" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ca8a04" strokeWidth="2">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </div>
                <div className="stat-card__content">
                  <div className="stat-card__label">Redactions (24h)</div>
                  <div className="stat-card__value">{activityStats.last24Hours.totalRedactions}</div>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-card__icon" style={{ background: "#f3e8ff" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9333ea" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18" />
                    <path d="M9 21V9" />
                  </svg>
                </div>
                <div className="stat-card__content">
                  <div className="stat-card__label">Total Redactions</div>
                  <div className="stat-card__value">{activityStats.allTime.totalRedactions}</div>
                </div>
              </div>
            </div>
          )}

          {/* Category Breakdown */}
          {activityStats && Object.keys(activityStats.allTime.categories).length > 0 && (
            <div className="card" style={{ marginTop: "20px" }}>
              <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>Redaction Categories</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {Object.entries(activityStats.allTime.categories).map(([category, count]) => (
                  <span
                    key={category}
                    style={{
                      background: "#f1f5f9",
                      padding: "4px 12px",
                      borderRadius: "16px",
                      fontSize: "0.85rem",
                    }}
                  >
                    <strong>{category}</strong>: {count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Activity Log */}
          <div className="card" style={{ marginTop: "20px" }}>
            <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>Recent Activity</h3>
            {activity.length === 0 ? (
              <p style={{ color: "#94a3b8" }}>No gateway activity recorded yet.</p>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Backend</th>
                      <th>Model</th>
                      <th>Redactions</th>
                      <th>Categories</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((event) => (
                      <tr key={event.id}>
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
                          {new Date(event.timestamp).toLocaleString()}
                        </td>
                        <td>
                          <span
                            style={{
                              background: event.type === "sanitize" ? "#dcfce7" : "#dbeafe",
                              color: event.type === "sanitize" ? "#166534" : "#1e40af",
                              padding: "2px 8px",
                              borderRadius: "4px",
                              fontSize: "0.8rem",
                              fontWeight: 500,
                            }}
                          >
                            {event.type}
                          </span>
                        </td>
                        <td>{event.backend}</td>
                        <td style={{ fontSize: "0.85rem", color: "#64748b" }}>{event.model || "-"}</td>
                        <td>{event.redactionCount}</td>
                        <td style={{ fontSize: "0.8rem" }}>
                          {Object.entries(event.categories || {}).map(([cat, cnt]) => (
                            <span key={cat} style={{ marginRight: "6px" }}>
                              {cat}: {cnt}
                            </span>
                          ))}
                          {Object.keys(event.categories || {}).length === 0 && "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === "status" && (
        <>
      {/* Status Cards */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-card__icon" style={{ background: status?.enabled ? "#dcfce7" : "#fee2e2" }}>
            {status?.enabled ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <line x1="4" y1="4" x2="20" y2="20" />
              </svg>
            )}
          </div>
          <div className="stat-card__content">
            <div className="stat-card__label">Status</div>
            <div className="stat-card__value" style={{ color: status?.enabled ? "#16a34a" : "#dc2626" }}>
              {status?.enabled ? "Enabled" : "Disabled"}
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card__icon" style={{ background: health?.healthy ? "#dcfce7" : "#fee2e2" }}>
            {health?.healthy ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            )}
          </div>
          <div className="stat-card__content">
            <div className="stat-card__label">Health</div>
            <div className="stat-card__value">
              {health?.healthy ? "Healthy" : health?.error || "Unhealthy"}
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card__icon" style={{ background: "#dbeafe" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div className="stat-card__content">
            <div className="stat-card__label">Endpoint</div>
            <div className="stat-card__value" style={{ fontSize: "0.9rem" }}>
              {status?.url || `http://127.0.0.1:${config?.port || 53669}`}
            </div>
          </div>
        </div>
      </div>

      {/* How to Enable */}
      {!status?.enabled && (
        <div className="card" style={{ marginTop: "20px" }}>
          <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>How to Enable</h3>
          <p style={{ color: "#64748b", marginBottom: "12px" }}>
            Enable the AI Security Gateway to automatically sanitize sensitive data before sending to LLM providers.
          </p>
          <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "12px", fontFamily: "monospace" }}>
            <code>/og_sanitize on</code>
          </div>
          <p style={{ color: "#94a3b8", fontSize: "0.85rem", marginTop: "12px" }}>
            Run this command in your OpenClaw conversation to enable data sanitization.
          </p>
        </div>
      )}

      {/* Protected Agents */}
      {status?.enabled && status.agents.length > 0 && (
        <div className="card" style={{ marginTop: "20px" }}>
          <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>Protected Agents</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {status.agents.map((agent) => (
              <span
                key={agent}
                style={{
                  background: "#dcfce7",
                  color: "#166534",
                  padding: "4px 12px",
                  borderRadius: "16px",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                }}
              >
                {agent}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Configured Backends */}
      {config?.configured && Object.keys(config.backends).length > 0 && (
        <div className="card" style={{ marginTop: "20px" }}>
          <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>Configured Backends</h3>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Base URL</th>
                  <th>API Key</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(config.backends).map(([name, backend]) => (
                  <tr key={name}>
                    <td>
                      <span style={{
                        background: "#f1f5f9",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        fontWeight: 500,
                      }}>
                        {name}
                      </span>
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                      {backend.baseUrl}
                    </td>
                    <td>
                      {backend.hasApiKey ? (
                        <span style={{ color: "#16a34a" }}>Configured</span>
                      ) : (
                        <span style={{ color: "#dc2626" }}>Missing</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Protected Providers */}
      {status?.enabled && status.providers.length > 0 && (
        <div className="card" style={{ marginTop: "20px" }}>
          <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>Protected Providers</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {status.providers.map((provider) => (
              <span
                key={provider}
                style={{
                  background: "#dbeafe",
                  color: "#1e40af",
                  padding: "4px 12px",
                  borderRadius: "16px",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                }}
              >
                {provider}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Data Protection Info */}
      <div className="card" style={{ marginTop: "20px" }}>
        <h3 style={{ marginBottom: "12px", fontSize: "1rem", fontWeight: 600 }}>Data Protection</h3>
        <p style={{ color: "#64748b", marginBottom: "16px" }}>
          The gateway automatically detects and sanitizes sensitive data before sending to LLM providers:
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "12px" }}>
          {[
            { type: "API Keys", example: "sk-xxx... → __secret_1__" },
            { type: "Emails", example: "user@example.com → __email_1__" },
            { type: "Credit Cards", example: "4111-xxxx → __credit_card_1__" },
            { type: "Phone Numbers", example: "+1-555-xxx → __phone_1__" },
            { type: "IP Addresses", example: "192.168.x.x → __ip_1__" },
            { type: "Bearer Tokens", example: "Bearer xxx → __secret_1__" },
          ].map((item) => (
            <div
              key={item.type}
              style={{
                background: "#f8fafc",
                padding: "12px",
                borderRadius: "8px",
              }}
            >
              <div style={{ fontWeight: 500, marginBottom: "4px" }}>{item.type}</div>
              <div style={{ fontSize: "0.8rem", fontFamily: "monospace", color: "#64748b" }}>
                {item.example}
              </div>
            </div>
          ))}
        </div>
      </div>
        </>
      )}
    </>
  );
}
