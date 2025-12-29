import React, { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Switch, message, Space, Popconfirm, Card, Typography, Tag, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, KeyOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useApplication } from '../../contexts/ApplicationContext';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface ProtectionSummary {
  risk_types_enabled: number;
  total_risk_types: number;
  ban_policy_enabled: boolean;
  sensitivity_level: string;
  data_security_entities: number;
  blacklist_count: number;
  whitelist_count: number;
  knowledge_base_count: number;
}

interface Application {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  api_keys_count: number;
  protection_summary?: ProtectionSummary;
}

interface ApiKey {
  id: string;
  application_id: string;
  key: string;
  name: string | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

const ApplicationManagement: React.FC = () => {
  const { t } = useTranslation();
  const { refreshApplications } = useApplication();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [keysModalVisible, setKeysModalVisible] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  const [currentAppKeys, setCurrentAppKeys] = useState<ApiKey[]>([]);
  const [currentAppId, setCurrentAppId] = useState<string>('');
  const [currentAppName, setCurrentAppName] = useState<string>('');
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [form] = Form.useForm();
  const [keyForm] = Form.useForm();

  useEffect(() => {
    fetchApplications();
  }, []);

  const fetchApplications = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/v1/applications');
      setApplications(response.data);
    } catch (error) {
      message.error(t('applicationManagement.fetchError'));
    } finally {
      setLoading(false);
    }
  };

  const fetchApiKeys = async (appId: string) => {
    try {
      const response = await api.get(`/api/v1/applications/${appId}/keys`);
      setCurrentAppKeys(response.data);
    } catch (error) {
      message.error(t('applicationManagement.fetchKeysError'));
    }
  };

  const handleCreate = () => {
    setEditingApp(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (app: Application) => {
    setEditingApp(app);
    form.setFieldsValue({
      name: app.name,
      description: app.description,
      is_active: app.is_active,
    });
    setModalVisible(true);
  };

  const handleDelete = async (appId: string) => {
    try {
      await api.delete(`/api/v1/applications/${appId}`);
      message.success(t('applicationManagement.deleteSuccess'));
      fetchApplications();
      refreshApplications(); // Refresh ApplicationSelector
    } catch (error: any) {
      if (error.response?.status === 400) {
        message.error(t('applicationManagement.cannotDeleteLast'));
      } else {
        message.error(t('applicationManagement.deleteError'));
      }
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingApp) {
        await api.put(`/api/v1/applications/${editingApp.id}`, values);
        message.success(t('applicationManagement.updateSuccess'));
      } else {
        await api.post('/api/v1/applications', values);
        message.success(t('applicationManagement.createSuccess'));
      }
      setModalVisible(false);
      fetchApplications();
      refreshApplications(); // Refresh ApplicationSelector
    } catch (error) {
      message.error(t('applicationManagement.saveError'));
    }
  };

  const handleManageKeys = async (app: Application) => {
    setCurrentAppId(app.id);
    setCurrentAppName(app.name);
    await fetchApiKeys(app.id);
    setKeysModalVisible(true);
  };

  const handleCreateKey = async () => {
    try {
      const values = await keyForm.validateFields();
      await api.post(`/api/v1/applications/${currentAppId}/keys`, {
        application_id: currentAppId,
        name: values.name,
      });
      message.success(t('applicationManagement.keyCreateSuccess'));
      keyForm.resetFields();
      await fetchApiKeys(currentAppId);
      fetchApplications(); // Refresh to update key count
    } catch (error) {
      message.error(t('applicationManagement.keyCreateError'));
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    try {
      await api.delete(`/api/v1/applications/${currentAppId}/keys/${keyId}`);
      message.success(t('applicationManagement.keyDeleteSuccess'));
      await fetchApiKeys(currentAppId);
      fetchApplications(); // Refresh to update key count
    } catch (error) {
      message.error(t('applicationManagement.keyDeleteError'));
    }
  };

  const handleToggleKey = async (keyId: string) => {
    try {
      await api.put(`/api/v1/applications/${currentAppId}/keys/${keyId}/toggle`);
      message.success(t('applicationManagement.keyToggleSuccess'));
      await fetchApiKeys(currentAppId);
    } catch (error) {
      message.error(t('applicationManagement.keyToggleError'));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success(t('applicationManagement.copiedToClipboard'));
  };

  const toggleKeyVisibility = (keyId: string) => {
    setVisibleKeys(prev => {
      const newSet = new Set(prev);
      if (newSet.has(keyId)) {
        newSet.delete(keyId);
      } else {
        newSet.add(keyId);
      }
      return newSet;
    });
  };

  const maskApiKey = (key: string) => {
    if (key.length <= 20) return key;
    return key.slice(0, 15) + '...' + key.slice(-4);
  };

  const columns: ColumnsType<Application> = [
    {
      title: t('applicationManagement.name'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
    },
    {
      title: t('applicationManagement.description'),
      dataIndex: 'description',
      key: 'description',
      width: 250,
      ellipsis: {
        showTitle: false,
      },
      render: (text) => (
        <Tooltip placement="topLeft" title={text}>
          {text || '-'}
        </Tooltip>
      ),
    },
    {
      title: t('applicationManagement.protectionSummary'),
      key: 'protection_summary',
      width: 400,
      render: (_, record) => {
        const summary = record.protection_summary;
        if (!summary) return '-';

        return (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Space wrap size="small">
              <Tooltip title={t('applicationManagement.riskTypesTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.riskTypes')}:
                  </Text>
                  <Tag color="blue" style={{ marginLeft: '4px' }}>
                    {summary.risk_types_enabled}/{summary.total_risk_types}
                  </Tag>
                </div>
              </Tooltip>
              <Tooltip title={t('applicationManagement.sensitivityLevelTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.sensitivityLevel')}:
                  </Text>
                  <Tag color="orange" style={{ marginLeft: '4px' }}>
                    {t(`sensitivity.${summary.sensitivity_level}`)}
                  </Tag>
                </div>
              </Tooltip>
            </Space>
            <Space wrap size="small">
              <Tooltip title={t('applicationManagement.banPolicyTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.banPolicy')}:
                  </Text>
                  <Tag color={summary.ban_policy_enabled ? 'green' : 'default'} style={{ marginLeft: '4px' }}>
                    {summary.ban_policy_enabled ? t('common.enabled') : t('common.disabled')}
                  </Tag>
                </div>
              </Tooltip>
              <Tooltip title={t('applicationManagement.dlpEntitiesTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.dlpEntities')}:
                  </Text>
                  <Tag color="purple" style={{ marginLeft: '4px' }}>
                    {summary.data_security_entities}
                  </Tag>
                </div>
              </Tooltip>
            </Space>
            <Space wrap size="small">
              <Tooltip title={t('applicationManagement.blacklistTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.blacklist')}:
                  </Text>
                  <Tag color="red" style={{ marginLeft: '4px' }}>
                    {summary.blacklist_count}
                  </Tag>
                </div>
              </Tooltip>
              <Tooltip title={t('applicationManagement.whitelistTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.whitelist')}:
                  </Text>
                  <Tag color="green" style={{ marginLeft: '4px' }}>
                    {summary.whitelist_count}
                  </Tag>
                </div>
              </Tooltip>
              <Tooltip title={t('applicationManagement.knowledgeBaseTooltip')}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('applicationManagement.knowledgeBase')}:
                  </Text>
                  <Tag color="cyan" style={{ marginLeft: '4px' }}>
                    {summary.knowledge_base_count}
                  </Tag>
                </div>
              </Tooltip>
            </Space>
          </Space>
        );
      },
    },
    {
      title: t('applicationManagement.status'),
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'green' : 'red'}>
          {isActive ? t('applicationManagement.active') : t('applicationManagement.inactive')}
        </Tag>
      ),
    },
    {
      title: t('applicationManagement.apiKeysCount'),
      dataIndex: 'api_keys_count',
      key: 'api_keys_count',
      width: 120,
      render: (count: number) => (
        <Tag color="blue">{count}</Tag>
      ),
    },
    {
      title: t('applicationManagement.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (text: string) => new Date(text).toLocaleString(),
    },
    {
      title: t('applicationManagement.actions'),
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space>
          <Tooltip title={t('applicationManagement.manageKeys')}>
            <Button
              type="link"
              icon={<KeyOutlined />}
              onClick={() => handleManageKeys(record)}
            />
          </Tooltip>
          <Tooltip title={t('common.edit')}>
            <Button
              type="link"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title={t('applicationManagement.deleteConfirm')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('common.yes')}
            cancelText={t('common.no')}
          >
            <Tooltip title={t('common.delete')}>
              <Button type="link" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const keyColumns: ColumnsType<ApiKey> = [
    {
      title: t('applicationManagement.keyName'),
      dataIndex: 'name',
      key: 'name',
      width: 150,
      render: (text) => text || t('applicationManagement.unnamed'),
    },
    {
      title: t('applicationManagement.apiKey'),
      dataIndex: 'key',
      key: 'key',
      width: 400,
      render: (key: string, record: ApiKey) => (
        <Space>
          <Text code style={{ fontSize: '12px' }}>
            {visibleKeys.has(record.id) ? key : maskApiKey(key)}
          </Text>
          <Button
            type="link"
            size="small"
            icon={visibleKeys.has(record.id) ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            onClick={() => toggleKeyVisibility(record.id)}
          />
          <Button
            type="link"
            size="small"
            icon={<CopyOutlined />}
            onClick={() => copyToClipboard(key)}
          />
        </Space>
      ),
    },
    {
      title: t('applicationManagement.status'),
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      render: (isActive: boolean, record: ApiKey) => (
        <Switch
          checked={isActive}
          onChange={() => handleToggleKey(record.id)}
        />
      ),
    },
    {
      title: t('applicationManagement.lastUsed'),
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      width: 180,
      render: (text: string | null) => text ? new Date(text).toLocaleString() : t('applicationManagement.neverUsed'),
    },
    {
      title: t('applicationManagement.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (text: string) => new Date(text).toLocaleString(),
    },
    {
      title: t('applicationManagement.actions'),
      key: 'actions',
      width: 100,
      render: (_, record) => (
        <Popconfirm
          title={t('applicationManagement.deleteKeyConfirm')}
          onConfirm={() => handleDeleteKey(record.id)}
          okText={t('common.yes')}
          cancelText={t('common.no')}
        >
          <Button type="link" danger icon={<DeleteOutlined />}>
            {t('common.delete')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      <Card>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={3}>{t('applicationManagement.title')}</Title>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('applicationManagement.createApplication')}
          </Button>
        </div>

        <Table
          columns={columns}
          dataSource={applications}
          loading={loading}
          rowKey="id"
          pagination={{ pageSize: 10 }}
        />
      </Card>

      {/* Application Create/Edit Modal */}
      <Modal
        title={editingApp ? t('applicationManagement.editApplication') : t('applicationManagement.createApplication')}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('applicationManagement.name')}
            rules={[{ required: true, message: t('applicationManagement.nameRequired') }]}
          >
            <Input placeholder={t('applicationManagement.namePlaceholder')} />
          </Form.Item>

          <Form.Item
            name="description"
            label={t('applicationManagement.description')}
          >
            <TextArea
              rows={4}
              placeholder={t('applicationManagement.descriptionPlaceholder')}
            />
          </Form.Item>

          {editingApp && (
            <Form.Item
              name="is_active"
              label={t('applicationManagement.status')}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* API Keys Management Modal */}
      <Modal
        title={
          <div>
            <Text strong>{t('applicationManagement.manageApiKeys')}</Text>
            <Text type="secondary" style={{ marginLeft: '12px', fontSize: '14px' }}>
              ({currentAppName})
            </Text>
          </div>
        }
        open={keysModalVisible}
        onCancel={() => {
          setKeysModalVisible(false);
          setVisibleKeys(new Set());
        }}
        footer={null}
        width={1000}
      >
        <Card size="small" style={{ marginBottom: 16 }}>
          <Form form={keyForm} layout="inline" onFinish={handleCreateKey}>
            <Form.Item
              name="name"
              style={{ flex: 1 }}
            >
              <Input placeholder={t('applicationManagement.keyNamePlaceholder')} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
                {t('applicationManagement.createApiKey')}
              </Button>
            </Form.Item>
          </Form>
        </Card>

        <Table
          columns={keyColumns}
          dataSource={currentAppKeys}
          rowKey="id"
          pagination={{ pageSize: 5 }}
          size="small"
        />
      </Modal>
    </div>
  );
};

export default ApplicationManagement;
