import React, { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Layout from './components/Layout/Layout';
import ProtectedRoute from './components/ProtectedRoute/ProtectedRoute';
import { ApplicationProvider } from './contexts/ApplicationContext';
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
import OnlineTest from './pages/OnlineTest/OnlineTest';
import SecurityGateway from './pages/SecurityGateway/SecurityGateway';
import Documentation from './pages/Documentation/Documentation';
import Subscription from './pages/Billing/Subscription';
import ApplicationManagement from './pages/Config/ApplicationManagement';
import TailwindDemo from './pages/TailwindDemo';
import { initSystemConfig, features } from './config';

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
      <Routes>
        <Route path="/tailwind-demo" element={<TailwindDemo />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/*" element={
          <ProtectedRoute>
            <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/online-test" element={<OnlineTest />} />
              <Route path="/results" element={<Results />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/applications" element={<ApplicationManagement />} />
              <Route path="/security-gateway" element={<SecurityGateway />} />
              <Route path="/config/*" element={<Config />} />
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
    </ApplicationProvider>
  );
}

export default App;