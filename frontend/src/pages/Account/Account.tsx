import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Button, message, Divider } from 'antd';
import { CopyOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authService, UserInfo } from '../../services/auth';
import { configApi } from '../../services/api';

const { Title, Text } = Typography;

interface SystemInfo {
  support_email: string | null;
  app_name: string;
  app_version: string;
}

const Account: React.FC = () => {
  const { t } = useTranslation();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchMe = async () => {
    try {
      const me = await authService.getCurrentUser();
      setUser(me);
    } catch (e) {
      message.error(t('account.fetchUserInfoFailed'));
    }
  };

  const fetchSystemInfo = async () => {
    try {
      const info = await configApi.getSystemInfo();
      setSystemInfo(info);
    } catch (e) {
      console.error('Fetch system info failed', e);
    }
  };

  useEffect(() => {
    fetchMe();
    fetchSystemInfo();
  }, []);

  const handleCopy = async () => {
    if (!user?.api_key) return;
    try {
      await navigator.clipboard.writeText(user.api_key);
      message.success(t('account.copied'));
    } catch {
      message.error(t('account.copyFailed'));
    }
  };

  const handleRegenerate = async () => {
    try {
      setLoading(true);
      const data = await authService.regenerateApiKey();
      message.success(t('account.apiKeyUpdated'));
      setUser((prev: UserInfo | null) => prev ? { ...prev, api_key: data.api_key } : prev);
    } catch (e: any) {
      message.error(e.message || t('account.operationFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Space align="center">
          <SafetyCertificateOutlined style={{ fontSize: 24, color: '#1890ff' }} />
          <Title level={4} style={{ margin: 0 }}>{t('account.title')}</Title>
        </Space>

        <div>
          <Text type="secondary">{t('account.email')}</Text>
          <div style={{ fontSize: 16 }}>{user?.email || '-'}</div>
        </div>

        <div>
          <Text type="secondary">{t('account.tenantUuid')}</Text>
          <Space style={{ width: '100%', marginTop: 8, alignItems: 'center' }}>
            <div style={{
              flex: 1,
              padding: '8px 12px',
              border: '1px solid #d9d9d9',
              borderRadius: '6px',
              backgroundColor: '#fafafa',
              fontFamily: 'monospace',
              fontSize: '14px',
              wordBreak: 'break-all'
            }}>
              <Text code style={{ backgroundColor: 'transparent', border: 'none', padding: 0 }}>
                {user?.id || '-'}
              </Text>
            </div>
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                if (user?.id) {
                  navigator.clipboard.writeText(user.id);
                  message.success(t('account.uuidCopied'));
                }
              }}
            >
              {t('account.copy')}
            </Button>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">{t('account.uuidNote')}</Text>
          </div>
        </div>

        <div>
          <Text type="secondary">{t('account.currentApiKey')}</Text>
          <Space style={{ width: '100%', marginTop: 8, alignItems: 'center' }}>
            <div style={{
              flex: 1,
              padding: '8px 12px',
              border: '1px solid #d9d9d9',
              borderRadius: '6px',
              backgroundColor: '#fafafa',
              fontFamily: 'monospace',
              fontSize: '14px',
              wordBreak: 'break-all'
            }}>
              <Text code style={{ backgroundColor: 'transparent', border: 'none', padding: 0 }}>
                {user?.api_key || '-'}
              </Text>
            </div>
            <Button icon={<CopyOutlined />} onClick={handleCopy}>{t('account.copy')}</Button>
            <Button type="primary" loading={loading} icon={<ReloadOutlined />} onClick={handleRegenerate}>
              {t('account.regenerate')}
            </Button>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">{t('account.regenerateWarning')}</Text>
          </div>
        </div>

        <div>
          <Text type="secondary">{t('account.apiRateLimit')}</Text>
          <div style={{ fontSize: 16, marginTop: 4 }}>
            {(() => {
              const rateLimit = user?.rate_limit;
              // Ensure conversion to number
              const rateLimitNum = typeof rateLimit === 'string' ? parseInt(rateLimit, 10) : Number(rateLimit);

              if (rateLimitNum === 0) {
                return <Text style={{ color: '#52c41a' }}>{t('account.unlimited')}</Text>;
              } else if (rateLimitNum > 0) {
                return <Text>{t('account.rateLimitValue', { limit: rateLimitNum })}</Text>;
              } else {
                return <Text type="secondary">{t('common.loading')}</Text>;
              }
            })()}
          </div>
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('account.rateLimitNote', { email: systemInfo?.support_email || '' })}
            </Text>
          </div>
        </div>

        {systemInfo?.support_email && (
          <>
            <Divider />
            <div>
              <Title level={5}>{t('account.contactSupport')}</Title>
              <div style={{ paddingLeft: 0 }}>
                <Text type="secondary">
                  {t('account.openguardrailsServices')}
                </Text>
                <div style={{ marginTop: 8, fontSize: 16 }}>
                  <Text strong style={{ color: '#1890ff' }}>{systemInfo.support_email}</Text>
                </div>
              </div>
            </div>
          </>
        )}
      </Space>
    </Card>
  );
};

export default Account;
