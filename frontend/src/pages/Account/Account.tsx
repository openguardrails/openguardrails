import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Button, message, Divider, Progress, Tag, Tabs, Form, Input } from 'antd';
import { CopyOutlined, SafetyCertificateOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { authService, UserInfo } from '../../services/auth';
import { configApi } from '../../services/api';
import { billingService } from '../../services/billing';
import type { Subscription } from '../../types/billing';
import { features, getSystemConfig } from '../../config';

const { Title, Text } = Typography;

interface SystemInfo {
  support_email: string | null;
  app_name: string;
  app_version: string;
}

const Account: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [passwordForm] = Form.useForm();
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [apiDomain, setApiDomain] = useState<string>('http://localhost:5001');

  // Get active tab from URL query params
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') || 'general');

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
    // Skip subscription fetch in enterprise mode
    if (!features.showSubscription()) {
      return;
    }

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

    // Get API domain from system config
    try {
      const config = getSystemConfig();
      setApiDomain(config.apiDomain);
    } catch (e) {
      console.error('Failed to get system config', e);
    }
  }, []);

  // Sync activeTab with URL search params
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && tab !== activeTab) {
      setActiveTab(tab);
    } else if (!tab && activeTab !== 'general') {
      setActiveTab('general');
    }
  }, [searchParams, activeTab]);

  const handleCopyDifyEndpoint = async () => {
    const endpoint = 'https://api.openguardrails.com/v1/dify/moderation';
    try {
      await navigator.clipboard.writeText(endpoint);
      message.success(t('account.copied'));
    } catch {
      message.error(t('account.copyFailed'));
    }
  };

  const handleChangePassword = async (values: { current_password: string; new_password: string; confirm_password: string }) => {
    if (values.new_password !== values.confirm_password) {
      message.error(t('account.passwordMismatch') || 'Passwords do not match');
      return;
    }

    try {
      setPasswordLoading(true);
      const response = await authService.changePassword(values.current_password, values.new_password);

      if (response.status === 'success') {
        message.success(t('account.changePasswordSuccess'));
        passwordForm.resetFields();
      } else {
        message.error(t('account.changePasswordFailed'));
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.detail || t('account.changePasswordFailed');
      if (errorMessage.includes('Current password is incorrect')) {
        message.error(t('account.currentPasswordIncorrect'));
      } else {
        message.error(errorMessage);
      }
    } finally {
      setPasswordLoading(false);
    }
  };

  const tabItems = [
    {
      key: 'general',
      label: t('account.title') || 'Account Management',
      children: (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
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

          {/* Direct Model Access API Key */}
          {user?.model_api_key && (
            <div>
              <Divider />
              <div style={{ marginBottom: 16 }}>
                <Title level={5}>{t('docs.directModelAccess') || 'Direct Model Access'}</Title>
                <Text type="secondary">{t('docs.directModelAccessDesc') || 'Use this API key to directly access models (OpenGuardrails-Text, bge-m3, etc.) without guardrails detection. For privacy, we only track usage count, not content.'}</Text>
              </div>

              <div>
                <Text type="secondary">{t('docs.modelApiKey') || 'Model API Key'}</Text>
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
                      {user.model_api_key}
                    </Text>
                  </div>
                  <Button
                    icon={<CopyOutlined />}
                    onClick={() => {
                      if (user.model_api_key) {
                        navigator.clipboard.writeText(user.model_api_key);
                        message.success(t('account.copied'));
                      }
                    }}
                  >
                    {t('account.copy')}
                  </Button>
                  <Button
                    danger
                    onClick={async () => {
                      try {
                        const newKey = await authService.regenerateModelApiKey();
                        setUser(user ? { ...user, model_api_key: newKey.model_api_key } : null);
                        message.success(t('account.modelApiKeyRegenerated') || 'Model API Key regenerated successfully');
                      } catch (error) {
                        message.error(t('account.regenerateFailed') || 'Failed to regenerate Model API Key');
                      }
                    }}
                  >
                    {t('account.regenerate') || 'Regenerate'}
                  </Button>
                </Space>
              </div>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('account.usageExample') || 'Usage Example'}:</Text>
                <pre style={{
                  backgroundColor: '#f6f8fa',
                  padding: 16,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                  marginTop: 8
                }}>
{`from openai import OpenAI

# Just change base_url and api_key
client = OpenAI(
    base_url="${apiDomain}/v1/model/",
    api_key="${user.model_api_key}"
)

# Use as normal - direct model access!
response = client.chat.completions.create(
    model="OpenGuardrails-Text",  # or bge-m3
    messages=[{"role": "user", "content": "Hello"}]
)

# Privacy Notice: Content is NOT logged, only usage count`}
                </pre>
              </div>

              <div style={{
                marginTop: 16,
                padding: '12px 16px',
                backgroundColor: '#e6f7ff',
                border: '1px solid #91d5ff',
                borderRadius: 6
              }}>
                <Text strong style={{ color: '#1890ff' }}>{t('account.privacyNotice') || 'Privacy Notice'}:</Text>
                <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                  <li>{t('account.privacyNotice1') || 'Message content is NEVER stored in our database'}</li>
                  <li>{t('account.privacyNotice2') || 'Only usage statistics (request count, tokens) are tracked for billing'}</li>
                  <li>{t('account.privacyNotice3') || 'Ideal for private deployment where you self-host the platform'}</li>
                </ul>
              </div>
            </div>
          )}

          {/* Subscription info only in SaaS mode */}
          {features.showSubscription() && (
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
          )}

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
      )
    },
    {
      key: 'password',
      label: (
        <span>
          <LockOutlined />
          {t('account.passwordChange')}
        </span>
      ),
      children: (
        <Card style={{ marginTop: 16 }}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <div>
              <Title level={4}>{t('account.passwordChange')}</Title>
              <Text type="secondary">{t('account.newPasswordRequirements')}</Text>
            </div>

            <Form
              form={passwordForm}
              layout="vertical"
              onFinish={handleChangePassword}
              autoComplete="off"
            >
              <Form.Item
                name="current_password"
                label={t('account.currentPassword')}
                rules={[
                  { required: true, message: t('account.currentPasswordRequired') || 'Please enter current password' }
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder={t('account.currentPasswordPlaceholder')}
                  autoComplete="current-password"
                />
              </Form.Item>

              <Form.Item
                name="new_password"
                label={t('account.newPassword')}
                rules={[
                  { required: true, message: t('account.newPasswordRequired') || 'Please enter new password' },
                  { min: 8, message: t('account.passwordMinLength') || 'Password must be at least 8 characters' }
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder={t('account.newPasswordPlaceholder')}
                  autoComplete="new-password"
                />
              </Form.Item>

              <Form.Item
                name="confirm_password"
                label={t('account.confirmPassword')}
                dependencies={['new_password']}
                rules={[
                  { required: true, message: t('account.confirmPasswordRequired') || 'Please confirm new password' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('new_password') === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error(t('account.passwordMismatch') || 'Passwords do not match'));
                    },
                  }),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder={t('account.confirmPasswordPlaceholder')}
                  autoComplete="new-password"
                />
              </Form.Item>

              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={passwordLoading}
                  block
                  size="large"
                >
                  {t('account.changePassword')}
                </Button>
              </Form.Item>
            </Form>
          </Space>
        </Card>
      )
    }
  ];

  return (
    <Card>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Space align="center">
          <SafetyCertificateOutlined style={{ fontSize: 24, color: '#1890ff' }} />
          <Title level={4} style={{ margin: 0 }}>{t('account.title')}</Title>
        </Space>

        <Tabs
          activeKey={activeTab}
          items={tabItems}
          onChange={(key) => {
            setActiveTab(key);
            if (key === 'general') {
              searchParams.delete('tab');
              setSearchParams(searchParams);
            } else {
              searchParams.set('tab', key);
              setSearchParams(searchParams);
            }
          }}
        />
      </Space>
    </Card>
  );
};

export default Account;
