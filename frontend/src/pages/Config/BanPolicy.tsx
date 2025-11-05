import React, { useState, useEffect } from 'react';
import { Card, Form, Switch, Select, InputNumber, Button, Table, message, Modal, Tag, Space, Descriptions } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { configApi } from '../../services/api';
import { translateRiskLevel, getRiskLevelColor } from '../../utils/i18nMapper';
import { useApplication } from '../../contexts/ApplicationContext';
import { useAuth } from '../../contexts/AuthContext';

const { Option } = Select;

interface BanPolicy {
  id: string;
  tenant_id: string;
  enabled: boolean;
  risk_level: string;
  trigger_count: number;
  time_window_minutes: number;
  ban_duration_minutes: number;
  created_at: string;
  updated_at: string;
}

interface BannedUser {
  id: string;
  user_id: string;
  banned_at: string;
  ban_until: string;
  trigger_count: number;
  risk_level: string;
  reason: string;
  is_active: boolean;
  status: string;
}

interface RiskTrigger {
  id: string;
  detection_result_id: string | null;
  risk_level: string;
  triggered_at: string;
}

const BanPolicy: React.FC = () => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [policy, setPolicy] = useState<BanPolicy | null>(null);
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [userHistory, setUserHistory] = useState<RiskTrigger[]>([]);
  const { currentApplicationId } = useApplication();
  const { onUserSwitch } = useAuth();

  // Get translated risk level text - use i18nMapper to handle both English and Chinese formats
  const getRiskLevelText = (level: string): string => {
    return translateRiskLevel(level, t);
  };

  // Get translated status text
  const getStatusText = (status: string): string => {
    if (status === 'banned') return t('banPolicy.banned');
    if (status === 'unbanned') return t('banPolicy.unbanned');
    return status;
  };

  // Get status color
  const getStatusColor = (status: string): string => {
    if (status === 'banned') return 'red';
    if (status === 'unbanned') return 'green';
    return 'default';
  };

  // 获取封禁策略
  const fetchPolicy = async () => {
    try {
      setLoading(true);
      const policyData = await configApi.banPolicy.get();
      setPolicy(policyData);
      form.setFieldsValue({
        enabled: policyData.enabled,
        risk_level: policyData.risk_level,
        trigger_count: policyData.trigger_count,
        time_window_minutes: policyData.time_window_minutes,
        ban_duration_minutes: policyData.ban_duration_minutes,
      });
    } catch (error: any) {
      message.error(t('banPolicy.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Fetch banned users list
  const fetchBannedUsers = async () => {
    try {
      setTableLoading(true);
      const data = await configApi.banPolicy.getBannedUsers();
      setBannedUsers(data.users);
    } catch (error: any) {
      message.error(t('banPolicy.getBannedUsersFailed'));
    } finally {
      setTableLoading(false);
    }
  };

  useEffect(() => {
    if (currentApplicationId) {
      fetchPolicy();
      fetchBannedUsers();
    }
  }, [currentApplicationId]);

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchPolicy();
      fetchBannedUsers();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  // Save policy
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      await configApi.banPolicy.update(values);
      message.success(t('banPolicy.saveSuccess'));
      fetchPolicy();
    } catch (error: any) {
      message.error(t('banPolicy.saveFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Apply template
  const applyTemplate = (template: string) => {
    const templates: { [key: string]: any } = {
      strict: {
        enabled: true,
        risk_level: 'high_risk',
        trigger_count: 3,
        time_window_minutes: 10,
        ban_duration_minutes: 60,
      },
      standard: {
        enabled: true,
        risk_level: 'high_risk',
        trigger_count: 5,
        time_window_minutes: 30,
        ban_duration_minutes: 30,
      },
      relaxed: {
        enabled: true,
        risk_level: 'high_risk',
        trigger_count: 10,
        time_window_minutes: 60,
        ban_duration_minutes: 15,
      },
      disabled: {
        enabled: false,
        risk_level: 'high_risk',
        trigger_count: 3,
        time_window_minutes: 10,
        ban_duration_minutes: 60,
      },
    };

    form.setFieldsValue(templates[template]);
  };

  // Unban user
  const handleUnban = async (userId: string) => {
    try {
      await configApi.banPolicy.unbanUser(userId);
      message.success(t('banPolicy.unbanSuccess'));
      fetchBannedUsers();
    } catch (error: any) {
      message.error(t('banPolicy.unbanFailed'));
    }
  };

  // View user risk history
  const viewUserHistory = async (userId: string) => {
    try {
      setSelectedUserId(userId);
      const data = await configApi.banPolicy.getUserHistory(userId);
      setUserHistory(data.history);
      setHistoryVisible(true);
    } catch (error: any) {
      message.error(t('banPolicy.getUserHistoryFailed'));
    }
  };

  const columns: ColumnsType<BannedUser> = [
    {
      title: t('banPolicy.userIdColumn'),
      dataIndex: 'user_id',
      key: 'user_id',
      width: 200,
    },
    {
      title: t('banPolicy.banTimeColumn'),
      dataIndex: 'banned_at',
      key: 'banned_at',
      width: 180,
      render: (text) => new Date(text).toLocaleString(),
    },
    {
      title: t('banPolicy.unbanTimeColumn'),
      dataIndex: 'ban_until',
      key: 'ban_until',
      width: 180,
      render: (text) => new Date(text).toLocaleString(),
    },
    {
      title: t('banPolicy.triggerTimesColumn'),
      dataIndex: 'trigger_count',
      key: 'trigger_count',
      width: 100,
    },
    {
      title: t('banPolicy.riskLevelColumn'),
      dataIndex: 'risk_level',
      key: 'risk_level',
      width: 100,
      render: (level) => (
        <Tag color={getRiskLevelColor(level)}>{getRiskLevelText(level)}</Tag>
      ),
    },
    {
      title: t('banPolicy.banReasonColumn'),
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
    },
    {
      title: t('banPolicy.statusColumn'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => (
        <Tag color={getStatusColor(status)}>{getStatusText(status)}</Tag>
      ),
    },
    {
      title: t('banPolicy.operationColumn'),
      key: 'action',
      width: 150,
      render: (_, record) => (
        <Space size="small">
          {record.status === 'banned' && (
            <Button type="link" size="small" onClick={() => handleUnban(record.user_id)}>
              {t('banPolicy.unbanUser')}
            </Button>
          )}
          <Button type="link" size="small" onClick={() => viewUserHistory(record.user_id)}>
            {t('banPolicy.viewHistory')}
          </Button>
        </Space>
      ),
    },
  ];

  const historyColumns: ColumnsType<RiskTrigger> = [
    {
      title: t('banPolicy.triggeredAt'),
      dataIndex: 'triggered_at',
      key: 'triggered_at',
      render: (text) => new Date(text).toLocaleString(),
    },
    {
      title: t('banPolicy.riskLevelColumn'),
      dataIndex: 'risk_level',
      key: 'risk_level',
      render: (level) => (
        <Tag color={getRiskLevelColor(level)}>{getRiskLevelText(level)}</Tag>
      ),
    },
    {
      title: t('banPolicy.detectionResultId'),
      dataIndex: 'detection_result_id',
      key: 'detection_result_id',
      render: (id) => id || '-',
    },
  ];

  return (
    <div>
      <Card title={t('banPolicy.title')} style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Form.Item
            name="enabled"
            label={t('banPolicy.enableBanPolicyLabel')}
            valuePropName="checked"
            extra={t('banPolicy.enableBanPolicyDesc')}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="risk_level"
            label={t('banPolicy.triggerRiskLevelLabel')}
            extra={t('banPolicy.triggerRiskLevelDesc')}
          >
            <Select>
              <Option value="high_risk">{t('banPolicy.highRisk')}</Option>
              <Option value="medium_risk">{t('banPolicy.mediumRisk')}</Option>
              <Option value="low_risk">{t('banPolicy.lowRisk')}</Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="trigger_count"
            label={t('banPolicy.triggerCountThresholdLabel')}
            extra={t('banPolicy.triggerCountThresholdDesc')}
          >
            <InputNumber min={1} max={100} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="time_window_minutes"
            label={t('banPolicy.timeWindowLabel')}
            extra={t('banPolicy.timeWindowMinutesDesc')}
          >
            <InputNumber min={1} max={1440} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="ban_duration_minutes"
            label={t('banPolicy.banDurationLabel')}
            extra={t('banPolicy.banDurationMinutesDesc')}
          >
            <InputNumber min={1} max={10080} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item>
            <Button type="primary" onClick={handleSave} loading={loading}>
              {t('banPolicy.saveConfig')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title={t('banPolicy.presetTemplates')} style={{ marginBottom: 16 }}>
        <Space size="middle">
          <Button onClick={() => applyTemplate('strict')}>{t('banPolicy.strictModeTemplate')}</Button>
          <Button onClick={() => applyTemplate('standard')}>{t('banPolicy.standardModeTemplate')}</Button>
          <Button onClick={() => applyTemplate('relaxed')}>{t('banPolicy.lenientModeTemplate')}</Button>
          <Button onClick={() => applyTemplate('disabled')}>{t('common.disabled')}</Button>
        </Space>
        <Descriptions column={1} size="small" style={{ marginTop: 16 }}>
          <Descriptions.Item label={t('banPolicy.strictModeTemplate')}>{t('banPolicy.strictModeTemplateDesc')}</Descriptions.Item>
          <Descriptions.Item label={t('banPolicy.standardModeTemplate')}>{t('banPolicy.standardModeTemplateDesc')}</Descriptions.Item>
          <Descriptions.Item label={t('banPolicy.lenientModeTemplate')}>{t('banPolicy.lenientModeTemplateDesc')}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title={t('banPolicy.bannedUsersList')}>
        <Table
          columns={columns}
          dataSource={bannedUsers}
          loading={tableLoading}
          rowKey="id"
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            showTotal: (total) => t('banPolicy.totalRecords', { total }),
          }}
        />
      </Card>

      <Modal
        title={`${t('banPolicy.userRiskHistoryTitle')} - ${selectedUserId}`}
        open={historyVisible}
        onCancel={() => setHistoryVisible(false)}
        footer={null}
        width={800}
      >
        <Table
          columns={historyColumns}
          dataSource={userHistory}
          rowKey="id"
          pagination={{
            pageSize: 10,
            showTotal: (total) => t('banPolicy.totalRecords', { total }),
          }}
        />
      </Modal>
    </div>
  );
};

export default BanPolicy;
