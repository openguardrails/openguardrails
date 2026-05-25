import React, { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Layout from './components/Layout/Layout';
import ProtectedRoute from './components/ProtectedRoute/ProtectedRoute';
import { ApplicationProvider } from './contexts/ApplicationContext';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import Login from './pages/Login/Login';
import Register from './pages/Register/Register';
import Verify from './pages/Verify/Verify';
import ForgotPassword from './pages/ForgotPassword/ForgotPassword';
import ResetPassword from './pages/ResetPassword/ResetPassword';
import Dashboard from './pages/Dashboard/Dashboard';
import Results from './pages/Results/Results';
import Reports from './pages/Reports/Reports';
import Config from './pages/Config/Config';
import AdminPanel from './pages/Admin/AdminPanel';
import Account from './pages/Account/Account';
import { SecurityPolicy, ProvidersAndRoutes } from './pages/SecurityGateway';
import GatewayConnection from './pages/Connection/GatewayConnection';
import Documentation from './pages/Documentation/Documentation';
import Subscription from './pages/Billing/Subscription';
import ApplicationManagement from './pages/Config/ApplicationManagement';
import Workspaces from './pages/Config/Workspaces';
import { AccessControl, FalsePositiveAppeal } from './pages/AccessControl';
import TeamManagement from './pages/Team/TeamManagement';
import AcceptInvitation from './pages/Auth/AcceptInvitation';
import AuditLog from './pages/AuditLog/AuditLog';
import { ChatTesting, AttackCampaigns } from './pages/RedTeaming';
import { initSystemConfig, features } from './config';
import WorkspaceSelector from './components/WorkspaceSelector';
import { useWorkspace } from './contexts/WorkspaceContext';

// Wrapper to add workspace selector above SecurityPolicy
const SecurityPolicyWithWorkspace: React.FC = () => {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <WorkspaceSelector />
      </div>
      <SecurityPolicy workspaceId={currentWorkspaceId || undefined} />
    </div>
  );
};

// Wrapper to add workspace selector above FalsePositiveAppeal
const FalsePositiveAppealWithWorkspace: React.FC = () => {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <WorkspaceSelector />
      </div>
      <FalsePositiveAppeal workspaceId={currentWorkspaceId || undefined} />
    </div>
  );
};

function App() {
  const { t, i18n } = useTranslation();
  const [configLoaded, setConfigLoaded] = useState(false);

  // Initialize system configuration
  useEffect(() => {
    const loadConfig = async () => {
      await initSystemConfig();
      setConfigLoaded(true);
    };
    loadConfig();
  }, []);

  // Update document title based on current language
  useEffect(() => {
    document.title = t('common.appName');
  }, [t, i18n.language]);

  // Don't render until config is loaded
  if (!configLoaded) {
    return null;
  }

  return (
    <ApplicationProvider>
    <WorkspaceProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        {features.showRegistration() && (
          <>
            <Route path="/register" element={<Register />} />
            <Route path="/verify" element={<Verify />} />
          </>
        )}
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvitation />} />
        <Route path="/*" element={
          <ProtectedRoute>
            <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/redteaming/chat" element={<ChatTesting />} />
              <Route path="/redteaming/campaigns" element={<AttackCampaigns />} />
              <Route path="/results" element={<Results />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/audit-log" element={<AuditLog />} />
              <Route path="/applications" element={<ApplicationManagement />} />
              <Route path="/applications/list" element={<ApplicationManagement />} />
              <Route path="/applications/workspaces" element={<Workspaces />} />
              <Route path="/connection/models" element={<ProvidersAndRoutes />} />
              <Route path="/connection/gateway" element={<GatewayConnection />} />
              <Route path="/security-gateway/providers" element={<ProvidersAndRoutes />} />
              <Route path="/security-gateway/policy" element={<SecurityPolicyWithWorkspace />} />
              <Route path="/security-gateway/appeals" element={<FalsePositiveAppealWithWorkspace />} />
              <Route path="/config/*" element={<Config />} />
              <Route path="/access-control/*" element={<AccessControl />} />
              <Route path="/team" element={<TeamManagement />} />
              <Route path="/admin/*" element={<AdminPanel />} />
              <Route path="/account" element={<Account />} />
              {features.showSubscription() && (
                <Route path="/subscription" element={<Subscription />} />
              )}
              <Route path="/documentation" element={<Documentation />} />
            </Routes>
          </Layout>
        </ProtectedRoute>
      } />
      {/* Root redirect to dashboard */}
      <Route path="/" element={<Login />} />
      </Routes>
    </WorkspaceProvider>
    </ApplicationProvider>
  );
}

export default App;