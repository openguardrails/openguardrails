import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/auth-context";
import { Shell } from "./components/Shell";
import { OverviewPage } from "./pages/OverviewPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentProfilePage } from "./pages/AgentProfilePage";
import { ActivityPage } from "./pages/ActivityPage";
import { SecurityPage } from "./pages/SecurityPage";
import { SecretsPage } from "./pages/SecretsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { GatewayPage } from "./pages/GatewayPage";

function NoSessionError() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      background: "#f8fafc",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{
        background: "white",
        borderRadius: "12px",
        padding: "40px",
        boxShadow: "0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05)",
        maxWidth: "440px",
        textAlign: "center",
      }}>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "12px", color: "#dc2626" }}>
          No Session
        </h2>
        <p style={{ color: "#64748b", fontSize: "0.95rem", marginBottom: "20px", lineHeight: 1.5 }}>
          Dashboard requires a valid session token.
          <br /><br />
          Run <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: "4px" }}>/og_dashboard</code> to get the access URL.
        </p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { authenticated, loading } = useAuth();
  if (loading) return null;
  if (!authenticated) return <NoSessionError />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Shell />
          </ProtectedRoute>
        }
      >
        {/* New flat routes */}
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentProfilePage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="gateway" element={<GatewayPage />} />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="settings" element={<SettingsPage />} />

        {/* Legacy redirects for old routes */}
        <Route path="inventory/agents" element={<Navigate to="/agents" replace />} />
        <Route path="inventory/agents/:id" element={<Navigate to="/agents/:id" replace />} />
        <Route path="inventory/permissions" element={<Navigate to="/activity" replace />} />
        <Route path="inventory/identities" element={<Navigate to="/agents" replace />} />
        <Route path="inventory/*" element={<Navigate to="/agents" replace />} />
        <Route path="secure/risk" element={<Navigate to="/security" replace />} />
        <Route path="secure/graph" element={<Navigate to="/agents" replace />} />
        <Route path="secure/*" element={<Navigate to="/security" replace />} />
        <Route path="discovery/*" element={<Navigate to="/agents" replace />} />
      </Route>
    </Routes>
  );
}
