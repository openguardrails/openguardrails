import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/auth-context";
import { Shell } from "./components/Shell";
import { LoginPage } from "./pages/LoginPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AgentProfilePage } from "./pages/AgentProfilePage";
import { IdentitiesPage } from "./pages/IdentitiesPage";
import { PermissionsPage } from "./pages/PermissionsPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";

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
        <Route index element={<Navigate to="/discovery/agents" replace />} />
        <Route path="discovery/agents" element={<AgentsPage />} />
        <Route path="discovery/agents/:id" element={<AgentProfilePage />} />
        <Route path="discovery/identities" element={<IdentitiesPage />} />
        <Route path="discovery/permissions" element={<PermissionsPage />} />
        <Route path="secure" element={<PlaceholderPage section="Secure" />} />
        <Route path="deploy" element={<PlaceholderPage section="Deploy" />} />
        <Route path="governance" element={<PlaceholderPage section="Governance" />} />
      </Route>
    </Routes>
  );
}
