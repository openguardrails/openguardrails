import React, { useState } from 'react';
import { GlobalOutlined } from '@ant-design/icons';
import { Dropdown, MenuProps, message } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth';

const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();
  const { isAuthenticated, refreshUserInfo } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleLanguageChange = async (lang: string) => {
    try {
      setLoading(true);
      
      // Update i18n and localStorage immediately for better UX
      i18n.changeLanguage(lang);
      localStorage.setItem('i18nextLng', lang);
      
      // If user is authenticated, update language preference on server
      if (isAuthenticated) {
        try {
          await authService.updateLanguage(lang);
          // Refresh user info to get updated language preference
          await refreshUserInfo();
          message.success('Language preference updated successfully');
        } catch (error) {
          console.error('Failed to update language preference:', error);
          message.warning('Language changed locally, but failed to save preference');
        }
      }
      
      // Reload page to apply language change
      window.location.reload();
    } catch (error) {
      console.error('Language change failed:', error);
      message.error('Failed to change language');
    } finally {
      setLoading(false);
    }
  };

  const items: MenuProps['items'] = [
    {
      key: 'en',
      label: 'English',
      onClick: () => handleLanguageChange('en'),
    },
    {
      key: 'zh',
      label: '中文',
      onClick: () => handleLanguageChange('zh'),
    },
  ];

  return (
    <Dropdown menu={{ items }} placement="bottomRight" disabled={loading}>
      <div style={{ cursor: loading ? 'not-allowed' : 'pointer', padding: '0 12px', opacity: loading ? 0.6 : 1 }}>
        <GlobalOutlined style={{ fontSize: '16px' }} />
        <span style={{ marginLeft: '8px' }}>
          {i18n.language === 'zh' ? '中文' : 'English'}
        </span>
        {loading && <span style={{ marginLeft: '4px' }}>...</span>}
      </div>
    </Dropdown>
  );
};

export default LanguageSwitcher;
