import { useState, useEffect } from "react";
import { CheckCircle, Server, ExternalLink } from "lucide-react";
import { api } from "../lib/api";

const CORE_URL = "https://www.openguardrails.com/core/login";

type SecurityLevel = "low" | "balanced" | "strict";
type ConnectionMode = "autonomous" | "claimed";

interface Settings {
  dailyLlmCalls: number;
  dailyActions: number;
  securityLevel: SecurityLevel;
}

const SECURITY_LEVELS: { value: SecurityLevel; label: string; description: string }[] = [
  {
    value: "low",
    label: "Low",
    description: "Minimal protection, fewer blocks. Best for development and testing.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Recommended for most use cases. Blocks obvious threats.",
  },
  {
    value: "strict",
    label: "Strict",
    description: "Maximum protection. May require more user confirmations.",
  },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    dailyLlmCalls: 1000,
    dailyActions: 500,
    securityLevel: "balanced",
  });
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("autonomous");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Load settings and connection status in parallel
        const [settingsRes, connectionRes] = await Promise.all([
          api.getSettings(),
          api.getConnectionStatus(),
        ]);
        if (cancelled) return;

        if (settingsRes.success && settingsRes.data) {
          setSettings({
            dailyLlmCalls: parseInt(settingsRes.data.daily_llm_calls || "1000", 10),
            dailyActions: parseInt(settingsRes.data.daily_actions || "500", 10),
            securityLevel: (settingsRes.data.security_level as SecurityLevel) || "balanced",
          });
        }

        if (connectionRes.success && connectionRes.data) {
          setConnectionMode(connectionRes.data.mode);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      const res = await api.updateSettings({
        daily_llm_calls: String(settings.dailyLlmCalls),
        daily_actions: String(settings.dailyActions),
        security_level: settings.securityLevel,
      });
      if (res.success) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleSecurityLevelChange = (level: SecurityLevel) => {
    setSettings(prev => ({ ...prev, securityLevel: level }));
  };

  return (
    <>
      <div className="content-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Configure agent protection and limits</p>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="card-sub">Loading settings...</div>
        </div>
      ) : (
        <div className="settings-container">
          {/* Core Connection Status */}
          <div className="settings-section">
            <h2 className="settings-section__title">Core Connection</h2>
            <div className="connection-status">
              <div className="connection-status__indicator">
                {connectionMode === "claimed" ? (
                  <CheckCircle size={20} className="text-success" />
                ) : (
                  <Server size={20} className="text-success" />
                )}
              </div>
              <div className="connection-status__info">
                <div className="connection-status__label">
                  {connectionMode === "claimed" ? "Claimed" : "Autonomous Mode"}
                </div>
                <div className="connection-status__description">
                  {connectionMode === "claimed"
                    ? "Agent is linked to your account. Using account quota for detection."
                    : "Agent is protected with free quota (500 checks/day). Claim on the platform to manage billing and view usage across devices."}
                </div>
              </div>
              <a
                href={CORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={`btn ${connectionMode === "autonomous" ? "btn-primary" : "btn-secondary"}`}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", textDecoration: "none" }}
              >
                {connectionMode === "autonomous" ? "Claim Agent" : "Open Core"}
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {/* Agent Budget */}
          <div className="settings-section">
            <h2 className="settings-section__title">Agent Budget</h2>
            <p className="settings-section__description">
              Set daily limits for agent activity. Agents will be warned when approaching limits.
            </p>

            <div className="settings-grid">
              <div className="settings-field">
                <label className="settings-field__label">Daily LLM Calls</label>
                <div className="settings-field__input">
                  <input
                    type="number"
                    value={settings.dailyLlmCalls}
                    onChange={(e) => setSettings(prev => ({
                      ...prev,
                      dailyLlmCalls: parseInt(e.target.value) || 0
                    }))}
                    min={0}
                    step={100}
                  />
                </div>
                <div className="settings-field__help">
                  Maximum number of LLM API calls per day across all agents.
                </div>
              </div>

              <div className="settings-field">
                <label className="settings-field__label">Daily Actions</label>
                <div className="settings-field__input">
                  <input
                    type="number"
                    value={settings.dailyActions}
                    onChange={(e) => setSettings(prev => ({
                      ...prev,
                      dailyActions: parseInt(e.target.value) || 0
                    }))}
                    min={0}
                    step={50}
                  />
                </div>
                <div className="settings-field__help">
                  Maximum number of tool calls per day across all agents.
                </div>
              </div>
            </div>
          </div>

          {/* Security Level */}
          <div className="settings-section">
            <h2 className="settings-section__title">Security Level</h2>
            <p className="settings-section__description">
              Choose how aggressively to block potentially risky actions.
            </p>

            <div className="security-levels">
              {SECURITY_LEVELS.map((level) => (
                <button
                  key={level.value}
                  className={`security-level${settings.securityLevel === level.value ? " active" : ""}`}
                  onClick={() => handleSecurityLevelChange(level.value)}
                >
                  <div className="security-level__header">
                    <span className="security-level__label">{level.label}</span>
                    {settings.securityLevel === level.value && (
                      <CheckCircle size={16} className="security-level__check" />
                    )}
                  </div>
                  <div className="security-level__description">
                    {level.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Save Button */}
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : saveSuccess ? "Saved!" : "Save Changes"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
