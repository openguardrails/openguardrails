import React, { useState, useEffect } from 'react';
import { Layout as AntLayout, Menu, theme, Dropdown, Avatar, Space, Button, Modal, Select, message, Tag } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DashboardOutlined,
  FileSearchOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  SwapOutlined,
  ReloadOutlined,
  ExperimentOutlined,
  BookOutlined,
  CreditCardOutlined,
} from '@ant-design/icons';
import { useAuth } from '../../contexts/AuthContext';
import { adminApi, configApi } from '../../services/api';
import LanguageSwitcher from '../LanguageSwitcher/LanguageSwitcher';

const { Header, Sider, Content } = AntLayout;

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [switchModalVisible, setSwitchModalVisible] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [systemVersion, setSystemVersion] = useState<string>('');

  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, switchInfo, switchToUser, exitSwitch, refreshSwitchStatus } = useAuth();
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  useEffect(() => {
    // If super admin, periodically check switch status
    if (user?.is_super_admin) {
      const interval = setInterval(() => {
        refreshSwitchStatus();
      }, 30000); // Check every 30 seconds
      return () => clearInterval(interval);
    }
  }, [user?.is_super_admin, refreshSwitchStatus]);

  useEffect(() => {
    // Get system version information
    const fetchSystemVersion = async () => {
      try {
        const systemInfo = await configApi.getSystemInfo();
        if (systemInfo.app_version) {
          setSystemVersion(`v${systemInfo.app_version}`);
        }
      } catch (error) {
        console.error('Failed to fetch system version:', error);
      }
    };

    fetchSystemVersion();
  }, []);

  const menuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: t('nav.dashboard'),
    },
    {
      key: '/online-test',
      icon: <ExperimentOutlined />,
      label: t('nav.onlineTest'),
    },
    {
      key: '/results',
      icon: <FileSearchOutlined />,
      label: t('nav.results'),
    },
    {
      key: '/reports',
      icon: <BarChartOutlined />,
      label: t('nav.reports'),
    },
    {
      key: '/security-gateway',
      icon: <SettingOutlined />,
      label: t('nav.securityGateway'),
    },
    {
      key: '/config',
      icon: <SettingOutlined />,
      label: t('nav.config'),
      children: [
        {
          key: '/config/risk-types',
          label: t('config.riskType'),
        },
        {
          key: '/config/sensitivity-thresholds',
          label: t('config.sensitivity'),
        },
        {
          key: '/config/data-security',
          label: t('config.dataSecurity'),
        },
        {
          key: '/config/ban-policy',
          label: t('config.banPolicy'),
        },
        {
          key: '/config/blacklist',
          label: t('config.blacklist'),
        },
        {
          key: '/config/whitelist',
          label: t('config.whitelist'),
        },
        {
          key: '/config/responses',
          label: t('config.template'),
        },
        {
          key: '/config/knowledge-bases',
          label: t('config.knowledge'),
        },
      ],
    },
    // Only super admins can see tenant management
    ...(user?.is_super_admin ? [{
      key: '/admin',
      icon: <SettingOutlined />,
      label: t('nav.admin'),
      children: [
        {
          key: '/admin/users',
          label: t('nav.tenantManagement'),
        },
        {
          key: '/admin/rate-limits',
          label: t('nav.rateLimiting'),
        },
        {
          key: '/admin/subscriptions',
          label: t('nav.subscriptionManagement'),
        },
      ],
    }] : []),
    {
      key: '/account',
      icon: <UserOutlined />,
      label: t('nav.account'),
    },
    {
      key: '/subscription',
      icon: <CreditCardOutlined />,
      label: t('nav.subscription'),
    },
  ];

  const handleMenuClick = ({ key }: { key: string }) => {
    navigate(key);
  };

  const getSelectedKeys = () => {
    const path = location.pathname;
    if (path.startsWith('/config') || path.startsWith('/admin') || path.startsWith('/security-gateway')) {
      return [path];
    }
    if (path === '/' || path === '/') {
      return ['/dashboard'];
    }
    return [path.startsWith('/') ? path : '/platform' + path];
  };

  const getOpenKeys = () => {
    const path = location.pathname;
    if (path.startsWith('/config')) {
      return ['/config'];
    }
    if (path.startsWith('/admin')) {
      return ['/admin'];
    }
    return [];
  };

  const loadUsers = async () => {
    if (!user?.is_super_admin) return;
    
    setLoading(true);
    try {
      const response = await adminApi.getUsers();
      setUsers(response.users || []);
    } catch (error) {
      console.error('Failed to load users:', error);
      message.error(t('layout.loadUsersError'));
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchUser = async (userId: string) => {
    try {
      await switchToUser(userId);
      setSwitchModalVisible(false);
      message.success(t('layout.switchSuccess'));
      // Refresh current page
      window.location.reload();
    } catch (error) {
      console.error('Switch user failed:', error);
      message.error(t('layout.switchError'));
    }
  };

  const handleExitSwitch = async () => {
    try {
      await exitSwitch();
      message.success(t('layout.exitSwitchSuccess'));
      // Refresh current page
      window.location.reload();
    } catch (error) {
      console.error('Exit switch failed:', error);
      message.error(t('layout.exitSwitchError'));
    }
  };

  const showSwitchModal = () => {
    setSwitchModalVisible(true);
    loadUsers();
  };

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider trigger={null} collapsible collapsed={collapsed}>
        <div
          style={{
            height: 48,
            margin: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
          onClick={() => navigate('/dashboard')}
        >
          <img
            src="/platform/logo.png"
            alt="OpenGuardrails logo"
            style={{
              height: '100%',
              maxWidth: collapsed ? '32px' : '100%',
              objectFit: 'contain',
            }}
          />
        </div>
        <style>{`
          .ant-menu-inline .ant-menu-item,
          .ant-menu-inline .ant-menu-submenu-title {
            white-space: normal !important;
            height: auto !important;
            line-height: 1.5 !important;
            padding: 8px 16px !important;
            overflow-wrap: break-word !important;
          }
          .ant-menu-inline .ant-menu-item-icon {
            vertical-align: top !important;
            margin-top: 2px !important;
          }
          .ant-menu-submenu-inline .ant-menu-item {
            white-space: normal !important;
            height: auto !important;
            line-height: 1.5 !important;
            overflow-wrap: break-word !important;
          }
        `}</style>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={getSelectedKeys()}
          defaultOpenKeys={getOpenKeys()}
          items={menuItems}
          onClick={handleMenuClick}
        />
      </Sider>
      <AntLayout>
        <Header
          style={{
            padding: 0,
            background: colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingRight: 24,
          }}
        >
          <div style={{ paddingLeft: 24, fontSize: 18, fontWeight: 'bold' }}>
            {t('common.appName')}
          </div>
          <Space>
            {/* Documentation Link */}
            <Button
              type="link"
              icon={<BookOutlined />}
              onClick={() => navigate('/documentation')}
            >
              {t('nav.documentation')}
            </Button>

            {/* Language Switcher */}
            <LanguageSwitcher />

            {/* Tenant switch status display */}
            {switchInfo.is_switched && (
              <Tag color="orange" style={{ marginRight: 8 }}>
                Switched to: {switchInfo.target_user?.email}
              </Tag>
            )}

            {/* Super admin only: tenant switch button */}
            {user?.is_super_admin && !switchInfo.is_switched && (
              <Button
                type="link"
                icon={<SwapOutlined />}
                onClick={showSwitchModal}
                size="small"
              >
                {t('layout.switchUser')}
              </Button>
            )}

            {/* Exit tenant switch button */}
            {switchInfo.is_switched && (
              <Button
                type="link"
                icon={<ReloadOutlined />}
                onClick={handleExitSwitch}
                size="small"
                danger
              >
                {t('layout.exitSwitch')}
              </Button>
            )}

            {/* Current user display */}
            <span style={{
              color: '#1890ff',
              fontWeight: 500,
              padding: '4px 8px',
              backgroundColor: '#f0f6ff',
              borderRadius: '4px',
              border: '1px solid #d6e4ff'
            }}>
              {user?.email}
              {user?.is_super_admin && <Tag color="red" style={{ marginLeft: 4 }}>{t('layout.admin')}</Tag>}
            </span>

            <span style={{ color: '#666' }}>{systemVersion}</span>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'account',
                    icon: <UserOutlined />,
                    label: t('nav.account'),
                    onClick: () => navigate('/account'),
                  },
                  {
                    type: 'divider',
                  },
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: t('nav.logout'),
                    onClick: () => {
                      logout();
                      navigate('/login');
                    },
                  },
                ],
              }}
              placement="bottomRight"
            >
              <Avatar
                style={{ cursor: 'pointer', backgroundColor: '#1890ff' }}
                icon={<UserOutlined />}
              />
            </Dropdown>
          </Space>
        </Header>
        <Content
          style={{
            margin: '24px 16px',
            padding: 24,
            minHeight: 280,
            background: colorBgContainer,
            borderRadius: 6,
          }}
        >
          {children}
        </Content>
      </AntLayout>
      
      {/* Tenant switch Modal */}
      <Modal
        title={t('layout.switchTenant')}
        open={switchModalVisible}
        onCancel={() => setSwitchModalVisible(false)}
        footer={null}
        width={600}
      >
        <div style={{ marginBottom: 16 }}>
          <p>{t('layout.selectTenantPrompt')}</p>
        </div>
        <Select
          style={{ width: '100%' }}
          placeholder={t('layout.selectTenantPlaceholder')}
          loading={loading}
          showSearch
          filterOption={(input, option) => {
            // Find corresponding tenant from users array for filtering
            const user = users.find(u => u.id === option?.value);
            return user ? user.email.toLowerCase().includes(input.toLowerCase()) : false;
          }}
          onSelect={handleSwitchUser}
          options={users.map(user => ({
            value: user.id,
            label: (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{user.email}</span>
                <div>
                  {user.is_super_admin && <Tag color="red">{t('layout.admin')}</Tag>}
                  {user.is_verified ? (
                    <Tag color="green">{t('layout.verified')}</Tag>
                  ) : (
                    <Tag color="orange">{t('layout.unverified')}</Tag>
                  )}
                </div>
              </div>
            )
          }))}
        />
        <div style={{ marginTop: 16, color: '#666', fontSize: '12px' }}>
          {t('layout.switchNote')}
        </div>
      </Modal>
    </AntLayout>
  );
};

export default Layout;