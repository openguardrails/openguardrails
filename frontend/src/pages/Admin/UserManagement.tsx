import React, { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Tag,
  message,
  Typography,
  Modal,
  Form,
  Input,
  Switch,
  Tooltip,
  Popconfirm
} from 'antd';
import {
  UserOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  MailOutlined,
  KeyOutlined
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { adminApi } from '../../services/api';

const { Title, Text } = Typography;

interface User {
  id: string;
  email: string;
  is_active: boolean;
  is_verified: boolean;
  is_super_admin: boolean;
  api_key: string;
  detection_count: number;
  created_at: string;
  updated_at: string;
}

interface AdminStats {
  total_users: number;
  total_detections: number;
  user_detection_counts: Array<{
    tenant_id: string;
    email: string;
    detection_count: number;
  }>;
}

const UserManagement: React.FC = () => {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [searchText, setSearchText] = useState('');

  const [form] = Form.useForm();
  const { user: currentUser, switchToUser, switchInfo } = useAuth();

  const loadAdminStats = async () => {
    try {
      const response = await adminApi.getAdminStats();
      setAdminStats(response.data);
    } catch (error) {
      console.error('Failed to load admin stats:', error);
      message.error(t('admin.loadStatsFailed'));
    }
  };

  const loadUsers = async () => {
    setLoading(true);
    try {
      const response = await adminApi.getUsers();
      setUsers(response.users || []);
    } catch (error) {
      console.error('Failed to load users:', error);
      message.error(t('admin.loadTenantsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadData = async () => {
    await Promise.all([loadUsers(), loadAdminStats()]);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleEdit = (user: User) => {
    setEditingUser(user);
    form.setFieldsValue({
      email: user.email,
      is_active: user.is_active,
      is_verified: user.is_verified,
      is_super_admin: user.is_super_admin,
    });
    setModalVisible(true);
  };

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleSave = async (values: any) => {
    try {
      if (editingUser) {
        // Update tenant
        await adminApi.updateUser(editingUser.id, values);
        message.success(t('admin.tenantUpdated'));
      } else {
        // Create new tenant
        await adminApi.createUser(values);
        message.success(t('admin.tenantCreated'));
      }

      setModalVisible(false);
      // Delay reset form, avoid user seeing button state change
      setTimeout(() => {
        form.resetFields();
      }, 300);
      loadUsers();
    } catch (error: any) {
      console.error('Save user failed:', error);
      message.error(error.response?.data?.detail || t('admin.saveFailed'));
    }
  };

  const handleDelete = async (tenantId: string) => {
    try {
      await adminApi.deleteUser(tenantId);
      message.success(t('admin.tenantDeleted'));
      loadUsers();
    } catch (error: any) {
      console.error('Delete user failed:', error);
      message.error(error.response?.data?.detail || t('admin.deleteFailed'));
    }
  };

  const handleResetApiKey = async (tenantId: string) => {
    try {
      await adminApi.resetUserApiKey(tenantId);
      message.success(t('admin.apiKeyReset'));
      loadUsers();
    } catch (error: any) {
      console.error('Reset API key failed:', error);
      message.error(error.response?.data?.detail || t('admin.resetApiFailed'));
    }
  };

  const handleSwitchToUser = async (tenantId: string, email: string) => {
    try {
      await switchToUser(tenantId);
      message.success(t('admin.switchedToTenant', { email }));
      // Refresh current page to update status
      window.location.reload();
    } catch (error: any) {
      console.error('Switch user failed:', error);
      message.error(error.response?.data?.detail || t('admin.switchTenantFailed'));
    }
  };

  const columns = [
    {
      title: t('admin.tenantEmail'),
      dataIndex: 'email',
      key: 'email',
      render: (email: string, record: User) => (
        <Space>
          <UserOutlined />
          {/* Only super admin and not current tenant and not in switching state can click switch */}
          {currentUser?.is_super_admin && record.id !== currentUser?.id && !switchInfo.is_switched ? (
            <Text
              style={{ cursor: 'pointer', color: '#1890ff' }}
              onClick={() => handleSwitchToUser(record.id, record.email)}
              title={t('admin.clickToSwitch')}
            >
              {email}
            </Text>
          ) : (
            <Text>{email}</Text>
          )}
          {record.id === currentUser?.id && <Tag color="blue">{t('admin.currentTenant')}</Tag>}
          {switchInfo.is_switched && switchInfo.target_user?.id === record.id && (
            <Tag color="orange">{t('admin.switching')}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: t('common.status'),
      key: 'status',
      width: 120,
      render: (_: any, record: User) => (
        <Space size={2} direction="vertical" style={{ display: 'flex' }}>
          <Tag color={record.is_active ? 'green' : 'red'}>
            {record.is_active ? t('admin.active') : t('admin.inactive')}
          </Tag>
          <Tag color={record.is_verified ? 'green' : 'orange'}>
            {record.is_verified ? t('admin.verified') : t('admin.unverified')}
          </Tag>
          {record.is_super_admin && (
            <Tag color="red">{t('admin.admin')}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'API Key',
      dataIndex: 'api_key',
      key: 'api_key',
      render: (apiKey: string, record: User) => (
        <Space>
          <Text code copyable={{ text: apiKey }}>
            {apiKey ? `${apiKey.substring(0, 20)}...` : t('admin.notGenerated')}
          </Text>
          <Tooltip title={t('admin.resetApiKey')}>
            <Button
              type="link"
              size="small"
              icon={<KeyOutlined />}
              onClick={() => handleResetApiKey(record.id)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'UUID',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => (
        <Text code copyable={{ text: id }}>
          {id.substring(0, 8)}...
        </Text>
      ),
    },
    {
      title: t('admin.detectionCount'),
      dataIndex: 'detection_count',
      key: 'detection_count',
      sorter: (a: User, b: User) => a.detection_count - b.detection_count,
      render: (count: number) => (
        <Tag color={count > 0 ? 'blue' : 'default'}>
          {count}
        </Tag>
      ),
    },
    {
      title: t('common.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      sorter: (a: User, b: User) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      defaultSortOrder: 'descend' as const,
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: t('common.operation'),
      key: 'actions',
      render: (_: any, record: User) => (
        <Space>
          <Tooltip title={t('admin.editTenant')}>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          {record.id !== currentUser?.id && (
            <Popconfirm
              title={t('admin.confirmDeleteTenant')}
              description={t('admin.cannotRecover')}
              onConfirm={() => handleDelete(record.id)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Tooltip title={t('admin.deleteTenant')}>
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <Title level={4} style={{ margin: 0 }}>
              <UserOutlined style={{ marginRight: 8 }} />
              {t('admin.tenantManagement')}
            </Title>
            <Text type="secondary">{t('admin.manageTenants')}</Text>
            {adminStats && (
              <div style={{ marginTop: 8 }}>
                <Space split={<Text type="secondary">|</Text>}>
                  <Text>
                    <strong>{adminStats.total_users}</strong> {t('admin.totalTenants')}
                  </Text>
                  <Text>
                    {t('admin.totalDetections')}: <strong>{adminStats.total_detections}</strong>
                  </Text>
                </Space>
              </div>
            )}
          </div>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={loadData}
              loading={loading}
            >
              {t('common.refresh')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleAdd}
            >
              {t('admin.addTenant')}
            </Button>
          </Space>
        </div>

        {/* Search box */}
        <div style={{ marginBottom: 16 }}>
          <Input.Search
            placeholder={t('admin.searchTenantPlaceholder')}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 300 }}
            allowClear
          />
        </div>

        <Table
          columns={columns}
          dataSource={users.filter(user =>
            !searchText ||
            user.email.toLowerCase().includes(searchText.toLowerCase()) ||
            user.id.toLowerCase().includes(searchText.toLowerCase())
          )}
          rowKey="id"
          loading={loading}
          pagination={{
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total) => `${t('common.total')} ${total} ${t('admin.totalTenants')}`,
          }}
        />
      </Card>

      <Modal
        title={editingUser ? t('admin.editTenantTitle') : t('admin.addTenantTitle')}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          // Delay reset form, avoid user seeing button state change
          setTimeout(() => {
            form.resetFields();
          }, 300);
        }}
        onOk={() => form.submit()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSave}
        >
          <Form.Item
            name="email"
            label={t('admin.tenantEmailLabel')}
            rules={[
              { required: true, message: t('admin.tenantEmailRequired') },
              { type: 'email', message: t('admin.validEmailRequired') }
            ]}
          >
            <Input
              prefix={<MailOutlined />}
              placeholder={t('admin.tenantEmailPlaceholder')}
              disabled={!!editingUser}
            />
          </Form.Item>

          {!editingUser && (
            <Form.Item
              name="password"
              label={t('admin.initialPassword')}
              rules={[
                { required: true, message: t('admin.initialPasswordRequired') },
                { min: 6, message: t('admin.passwordMinLength') }
              ]}
            >
              <Input.Password placeholder={t('admin.initialPasswordPlaceholder')} />
            </Form.Item>
          )}

          <Form.Item
            name="is_active"
            label={t('admin.accountStatus')}
            valuePropName="checked"
            initialValue={true}
          >
            <Switch
              checkedChildren={t('admin.active')}
              unCheckedChildren={t('admin.inactive')}
            />
          </Form.Item>

          <Form.Item
            name="is_verified"
            label={t('admin.emailVerification')}
            valuePropName="checked"
            initialValue={false}
          >
            <Switch
              checkedChildren={t('admin.verified')}
              unCheckedChildren={t('admin.unverified')}
            />
          </Form.Item>

          {/* {t('admin.superAdminNote')} */}
          <Form.Item label={t('admin.superAdmin')}>
            <Switch
              checked={!!editingUser?.is_super_admin}
              checkedChildren={t('common.yes')}
              unCheckedChildren={t('common.no')}
              disabled
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default UserManagement;