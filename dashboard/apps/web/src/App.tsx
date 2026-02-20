import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/auth-context";
import { Shell } from "./components/Shell";
import { LoginPage } from "./pages/LoginPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentProfilePage } from "./pages/AgentProfilePage";
import { IdentitiesPage } from "./pages/IdentitiesPage";
import { PermissionsPage } from "./pages/PermissionsPage";
import { RiskPage } from "./pages/RiskPage";
import { GraphPage } from "./pages/GraphPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { authenticated, loading } = useAuth();
  if (loading) return null;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Shell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/inventory/agents" replace />} />
        <Route path="inventory/agents" element={<AgentsPage />} />
        <Route path="inventory/agents/:id" element={<AgentProfilePage />} />
        <Route path="inventory/identities" element={<IdentitiesPage />} />
        <Route path="inventory/permissions" element={<PermissionsPage />} />
        {/* Legacy /discovery routes redirect to /inventory */}
        <Route path="discovery/agents/:id" element={<Navigate to="/inventory/agents/:id" replace />} />
        <Route path="discovery/*" element={<Navigate to="/inventory/agents" replace />} />
        <Route path="secure/risk" element={<RiskPage />} />
        <Route path="secure/graph" element={<GraphPage />} />
      </Route>
    </Routes>
  );
}
