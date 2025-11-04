import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Button, message, Divider, Progress, Tag } from 'antd';
import { CopyOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authService, UserInfo } from '../../services/auth';
import { configApi } from '../../services/api';
import { billingService } from '../../services/billing';
import type { Subscription } from '../../types/billing';

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
  const [subscription, setSubscription] = useState<Subscription | null>(null);

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

  const fetchSubscription = async () => {
    try {
      const sub = await billingService.getCurrentSubscription();
      setSubscription(sub);
    } catch (e: any) {
      console.error('Fetch subscription failed', e);
      // Set null to indicate subscription not found (for legacy users)
      setSubscription(null);
    }
  };

  useEffect(() => {
    fetchMe();
    fetchSystemInfo();
    fetchSubscription();
  }, []);

  const handleCopyDifyEndpoint = async () => {
    const endpoint = 'https://api.openguardrails.com/v1/dify/moderation';
    try {
      await navigator.clipboard.writeText(endpoint);
      message.success(t('account.copied'));
    } catch {
      message.error(t('account.copyFailed'));
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
          <Text type="secondary">{t('account.apiKeyManagement')}</Text>
          <div style={{
            marginTop: 8,
            padding: '12px 16px',
            border: '1px solid #d9d9d9',
            borderRadius: '6px',
            backgroundColor: '#fafafa'
          }}>
            <Text>{t('account.apiKeyMigrationNotice')}</Text>
            <div style={{ marginTop: 8 }}>
              <Button
                type="link"
                onClick={() => window.location.href = '/platform/applications'}
                style={{ padding: 0, height: 'auto' }}
              >
                {t('account.goToApplicationManagement')}
              </Button>
            </div>
          </div>
        </div>

        <div>
          <Text type="secondary">{t('account.difyModerationEndpoint')}</Text>
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
                https://api.openguardrails.com/v1/dify/moderation
              </Text>
            </div>
            <Button icon={<CopyOutlined />} onClick={handleCopyDifyEndpoint}>{t('account.copy')}</Button>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">{t('account.difyModerationEndpointNote')}</Text>
          </div>
        </div>

        <div>
          <Text type="secondary">{t('account.subscription')}</Text>
          <div style={{ marginTop: 8 }}>
            {subscription ? (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <div>
                  <Tag color={subscription.subscription_type === 'subscribed' ? 'blue' : 'default'}>
                    {subscription.plan_name}
                  </Tag>
                </div>
                <div>
                  <Text>{t('account.monthlyQuota')}: </Text>
                  <Text strong>
                    {subscription.current_month_usage.toLocaleString()} / {subscription.monthly_quota.toLocaleString()}
                  </Text>
                  <Text type="secondary"> {t('account.calls')}</Text>
                </div>
                <Progress
                  percent={Math.min(subscription.usage_percentage, 100)}
                  status={subscription.usage_percentage >= 90 ? 'exception' : 'active'}
                  strokeColor={subscription.usage_percentage >= 90 ? '#ff4d4f' : '#1890ff'}
                />
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('account.quotaResetsOn', { date: new Date(subscription.usage_reset_at).toLocaleDateString() })}
                  </Text>
                </div>
                {subscription.subscription_type === 'free' && subscription.usage_percentage >= 80 && (
                  <div style={{
                    padding: '8px 12px',
                    background: '#fff7e6',
                    border: '1px solid #ffd591',
                    borderRadius: '4px',
                    marginTop: 8
                  }}>
                    <Text type="warning" style={{ fontSize: 12 }}>
                      {t('account.upgradePrompt', { email: systemInfo?.support_email || '' })}
                    </Text>
                  </div>
                )}
              </Space>
            ) : subscription === null ? (
              <div style={{
                padding: '12px',
                background: '#fff7e6',
                border: '1px solid #ffd591',
                borderRadius: '4px'
              }}>
                <Text type="warning">
                  {t('account.subscriptionNotFound', { email: systemInfo?.support_email || 'support@openguardrails.com' })}
                </Text>
              </div>
            ) : (
              <Text type="secondary">{t('common.loading')}</Text>
            )}
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
