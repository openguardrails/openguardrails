import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Progress, Tag, Statistic, Row, Col, Divider, Alert, Button, message } from 'antd';
import { CreditCardOutlined, CalendarOutlined, LineChartOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { billingService } from '../../services/billing';
import { configApi } from '../../services/api';
import type { Subscription as SubscriptionType, UsageInfo } from '../../types/billing';

const { Title, Text } = Typography;

interface SystemInfo {
  support_email: string | null;
  app_name: string;
  app_version: string;
}

const Subscription: React.FC = () => {
  const { t } = useTranslation();
  const [subscription, setSubscription] = useState<SubscriptionType | null>(undefined);
  const [usageInfo, setUsageInfo] = useState<UsageInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSubscription = async () => {
    setLoading(true);
    try {
      const sub = await billingService.getCurrentSubscription();
      setSubscription(sub);
    } catch (e: any) {
      console.error('Fetch subscription failed', e);
      setSubscription(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchUsageInfo = async () => {
    try {
      const usage = await billingService.getCurrentUsage();
      setUsageInfo(usage);
    } catch (e: any) {
      console.error('Fetch usage info failed', e);
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
    fetchSubscription();
    fetchUsageInfo();
    fetchSystemInfo();
  }, []);

  const handleRefresh = () => {
    fetchSubscription();
    fetchUsageInfo();
  };

  if (loading) {
    return (
      <Card loading={loading}>
        <Text>{t('common.loading')}</Text>
      </Card>
    );
  }

  if (subscription === null) {
    return (
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Space align="center">
            <CreditCardOutlined style={{ fontSize: 24, color: '#1890ff' }} />
            <Title level={4} style={{ margin: 0 }}>{t('billing.subscriptionManagement')}</Title>
          </Space>
          <Alert
            message={t('billing.subscriptionNotFound')}
            description={t('billing.subscriptionNotFoundDesc', {
              email: systemInfo?.support_email || 'support@openguardrails.com'
            })}
            type="warning"
            showIcon
          />
        </Space>
      </Card>
    );
  }

  if (!subscription) {
    return null;
  }

  const resetDate = new Date(subscription.usage_reset_at);
  const daysUntilReset = Math.ceil((resetDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* Header */}
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space align="center">
              <CreditCardOutlined style={{ fontSize: 24, color: '#1890ff' }} />
              <Title level={4} style={{ margin: 0 }}>{t('billing.subscriptionManagement')}</Title>
            </Space>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>
              {t('common.refresh')}
            </Button>
          </Space>

          {/* Current Plan */}
          <div>
            <Text type="secondary">{t('billing.currentPlan')}</Text>
            <div style={{ marginTop: 8 }}>
              <Tag
                color={subscription.subscription_type === 'subscribed' ? 'blue' : 'default'}
                style={{ fontSize: 16, padding: '4px 12px' }}
              >
                {subscription.plan_name}
              </Tag>
            </div>
          </div>

          {/* Upgrade Prompt */}
          {subscription.subscription_type === 'free' && (
            <Alert
              message={t('billing.upgradeAvailable')}
              description={
                <Space direction="vertical" size="small">
                  <Text>{t('billing.upgradeDescription')}</Text>
                  <Text type="secondary">
                    {t('billing.contactSupport', { email: systemInfo?.support_email || 'support@openguardrails.com' })}
                  </Text>
                </Space>
              }
              type="info"
              showIcon
            />
          )}
        </Space>
      </Card>

      {/* Usage Statistics */}
      <Card title={<Space><LineChartOutlined /> {t('billing.usageStatistics')}</Space>}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Statistics Row */}
          <Row gutter={16}>
            <Col xs={24} sm={12} md={6}>
              <Statistic
                title={t('billing.currentUsage')}
                value={subscription.current_month_usage.toLocaleString()}
                suffix={`/ ${subscription.monthly_quota.toLocaleString()}`}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Statistic
                title={t('billing.remaining')}
                value={Math.max(0, subscription.monthly_quota - subscription.current_month_usage).toLocaleString()}
                valueStyle={{ color: subscription.usage_percentage >= 90 ? '#cf1322' : '#3f8600' }}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Statistic
                title={t('billing.usagePercentage')}
                value={subscription.usage_percentage}
                suffix="%"
                precision={1}
                valueStyle={{
                  color: subscription.usage_percentage >= 90 ? '#cf1322' :
                         subscription.usage_percentage >= 80 ? '#faad14' : '#3f8600'
                }}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Statistic
                title={t('billing.daysUntilReset')}
                value={daysUntilReset}
                suffix={t('billing.days')}
                prefix={<CalendarOutlined />}
              />
            </Col>
          </Row>

          <Divider style={{ margin: '12px 0' }} />

          {/* Usage Progress Bar */}
          <div>
            <div style={{ marginBottom: 8 }}>
              <Text strong>{t('billing.monthlyQuotaUsage')}</Text>
            </div>
            <Progress
              percent={Math.min(subscription.usage_percentage, 100)}
              status={
                subscription.usage_percentage >= 100 ? 'exception' :
                subscription.usage_percentage >= 90 ? 'exception' :
                subscription.usage_percentage >= 80 ? 'normal' : 'active'
              }
              strokeColor={
                subscription.usage_percentage >= 90 ? '#ff4d4f' :
                subscription.usage_percentage >= 80 ? '#faad14' : '#1890ff'
              }
              format={(percent) => `${subscription.current_month_usage.toLocaleString()} / ${subscription.monthly_quota.toLocaleString()} (${percent?.toFixed(1)}%)`}
            />
          </div>

          {/* Quota Reset Info */}
          <div style={{
            padding: '12px',
            background: '#f0f5ff',
            border: '1px solid #adc6ff',
            borderRadius: '4px'
          }}>
            <Space direction="vertical" size="small">
              <Text strong>
                <CalendarOutlined /> {t('billing.quotaResetDate')}
              </Text>
              <Text>
                {t('billing.quotaResetsOn', {
                  date: resetDate.toLocaleDateString(),
                  time: resetDate.toLocaleTimeString()
                })}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('billing.quotaResetNote')}
              </Text>
            </Space>
          </div>

          {/* Warning Messages */}
          {subscription.usage_percentage >= 100 && (
            <Alert
              message={t('billing.quotaExceeded')}
              description={t('billing.quotaExceededDesc', {
                date: resetDate.toLocaleDateString()
              })}
              type="error"
              showIcon
            />
          )}

          {subscription.usage_percentage >= 80 && subscription.usage_percentage < 100 && (
            <Alert
              message={t('billing.quotaWarning')}
              description={t('billing.quotaWarningDesc', {
                percentage: subscription.usage_percentage.toFixed(1),
                email: systemInfo?.support_email || 'support@openguardrails.com'
              })}
              type="warning"
              showIcon
            />
          )}
        </Space>
      </Card>

      {/* Plan Details */}
      <Card title={t('billing.planDetails')}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Row gutter={[16, 16]}>
            <Col span={12}>
              <Text type="secondary">{t('billing.planType')}</Text>
              <div style={{ marginTop: 4 }}>
                <Text strong>{subscription.plan_name}</Text>
              </div>
            </Col>
            <Col span={12}>
              <Text type="secondary">{t('billing.monthlyQuota')}</Text>
              <div style={{ marginTop: 4 }}>
                <Text strong>{subscription.monthly_quota.toLocaleString()} {t('billing.calls')}</Text>
              </div>
            </Col>
            <Col span={12}>
              <Text type="secondary">{t('billing.subscriptionId')}</Text>
              <div style={{ marginTop: 4 }}>
                <Text code style={{ fontSize: 12 }}>{subscription.id}</Text>
              </div>
            </Col>
            <Col span={12}>
              <Text type="secondary">{t('billing.billingCycle')}</Text>
              <div style={{ marginTop: 4 }}>
                <Text strong>{t('billing.monthly')}</Text>
              </div>
            </Col>
          </Row>

          {subscription.subscription_type === 'free' && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <div style={{
                padding: '12px',
                background: '#fffbe6',
                border: '1px solid #ffe58f',
                borderRadius: '4px'
              }}>
                <Space direction="vertical" size="small">
                  <Text strong>{t('billing.upgradeToUnlockMore')}</Text>
                  <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                    <li>{t('billing.feature1')}</li>
                    <li>{t('billing.feature2')}</li>
                    <li>{t('billing.feature3')}</li>
                    <li>{t('billing.feature4')}</li>
                  </ul>
                  <Text type="secondary">
                    {t('billing.contactSupport', { email: systemInfo?.support_email || 'support@openguardrails.com' })}
                  </Text>
                </Space>
              </div>
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
};

export default Subscription;
