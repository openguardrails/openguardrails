import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import UserManagement from './UserManagement';
import RateLimitManagement from './RateLimitManagement';

const AdminPanel: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="users" replace />} />
      <Route path="/users" element={<UserManagement />} />
      <Route path="/rate-limits" element={<RateLimitManagement />} />
    </Routes>
  );
};

export default AdminPanel;