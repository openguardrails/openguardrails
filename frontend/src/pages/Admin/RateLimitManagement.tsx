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
  InputNumber,
  Switch,
  Select,
  Tooltip,
  Popconfirm,
  Statistic,
  Row,
  Col,
  Input
} from 'antd';
import {
  ThunderboltOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  UserOutlined,
  InfoCircleOutlined,
  SearchOutlined
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { adminApi } from '../../services/api';

const { Title, Text } = Typography;
const { Option } = Select;

interface User {
  id: string;
  email: string;
  is_active: boolean;
  is_verified: boolean;
  is_super_admin: boolean;
}

interface RateLimit {
  tenant_id: string;
  email: string;
  requests_per_second: number;
  is_active: boolean;
}

const RateLimitManagement: React.FC = () => {
  const { t } = useTranslation();
  const [rateLimits, setRateLimits] = useState<RateLimit[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingRateLimit, setEditingRateLimit] = useState<RateLimit | null>(null);
  const [searchText, setSearchText] = useState('');
  const [total, setTotal] = useState(0);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10 });
  const [sortBy, setSortBy] = useState<'requests_per_second' | 'email'>('requests_per_second');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [form] = Form.useForm();

  const loadRateLimits = async (search?: string, page = 1, pageSize = 10, sortByParam?: string, sortOrderParam?: string) => {
    setLoading(true);
    try {
      const response = await adminApi.getRateLimits({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        search: search || undefined,
        sort_by: sortByParam || sortBy,
        sort_order: sortOrderParam || sortOrder
      });
      setRateLimits(response.data || []);
      setTotal(response.total || 0);
    } catch (error) {
      console.error('Failed to load rate limits:', error);
      message.error(t('rateLimit.loadRateLimitsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const response = await adminApi.getUsers();
      setUsers(response.users || []);
    } catch (error) {
      console.error('Failed to load tenants:', error);
    }
  };

  useEffect(() => {
    loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder);
    loadUsers();
  }, []);

  const handleSearch = (value: string) => {
    setSearchText(value);
    setPagination({ ...pagination, current: 1 });
    loadRateLimits(value, 1, pagination.pageSize, sortBy, sortOrder);
  };

  const handleTableChange = (newPagination: any, filters: any, sorter: any) => {
    setPagination(newPagination);
    
    // Handle sorting
    if (sorter && sorter.columnKey) {
      const newSortBy = sorter.columnKey === 'rps' ? 'requests_per_second' : sorter.columnKey;
      const newSortOrder = sorter.order === 'ascend' ? 'asc' : 'desc';
      setSortBy(newSortBy);
      setSortOrder(newSortOrder);
      loadRateLimits(searchText, newPagination.current, newPagination.pageSize, newSortBy, newSortOrder);
    } else {
      loadRateLimits(searchText, newPagination.current, newPagination.pageSize, sortBy, sortOrder);
    }
  };

  const handleEdit = (rateLimit: RateLimit) => {
    setEditingRateLimit(rateLimit);
    form.setFieldsValue({
      tenant_id: rateLimit.tenant_id,
      requests_per_second: rateLimit.requests_per_second,
      is_active: rateLimit.is_active,
    });
    setModalVisible(true);
  };

  const handleAdd = () => {
    setEditingRateLimit(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleSave = async (values: any) => {
    try {
      if (editingRateLimit) {
        // Update rate limit config
        await adminApi.setUserRateLimit({
          tenant_id: editingRateLimit.tenant_id,
          requests_per_second: values.requests_per_second
        });
        message.success(t('rateLimit.rateLimitUpdated'));
      } else {
        // Create new rate limit config
        await adminApi.setUserRateLimit({
          tenant_id: values.tenant_id,
          requests_per_second: values.requests_per_second
        });
        message.success(t('rateLimit.rateLimitCreated'));
      }
      
      setModalVisible(false);
      form.resetFields();
      loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder);
    } catch (error: any) {
      console.error('Save rate limit failed:', error);
      message.error(error.response?.data?.detail || t('common.saveFailed'));
    }
  };

  const handleDelete = async (tenantId: string) => {
    try {
      await adminApi.removeUserRateLimit(tenantId);
      message.success(t('rateLimit.rateLimitDeleted'));
      loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder);
    } catch (error: any) {
      console.error('Delete rate limit failed:', error);
      message.error(error.response?.data?.detail || t('common.deleteFailed'));
    }
  };

  const getAvailableUsers = () => {
    // Show all users - Allow configuring any tenant
    // This allows updating existing configurations or adding new ones
    return users;
  };

  const getRpsDisplay = (rps: number) => {
    if (rps === 0) {
      return <Tag color="green">{t('rateLimit.unlimited')}</Tag>;
    }
    return <Tag color={rps > 10 ? 'blue' : rps > 5 ? 'orange' : 'red'}>{rps} {t('rateLimit.requestsPerSecond')}</Tag>;
  };

  const getStatistics = () => {
    const totalUsers = rateLimits.length;
    const unlimitedUsers = rateLimits.filter(rl => rl.requests_per_second === 0).length;
    const avgRps = rateLimits.length > 0
      ? rateLimits.filter(rl => rl.requests_per_second > 0)
                  .reduce((sum, rl) => sum + rl.requests_per_second, 0) /
        rateLimits.filter(rl => rl.requests_per_second > 0).length || 0
      : 0;

    return { totalUsers, unlimitedUsers, avgRps };
  };

  const stats = getStatistics();

  const columns = [
    {
      title: t('rateLimit.tenant'),
      key: 'user',
      render: (_: any, record: RateLimit) => (
        <Space>
          <UserOutlined />
          <Text>{record.email}</Text>
        </Space>
      ),
    },
    {
      title: t('rateLimit.rateLimitConfig'),
      key: 'rps',
      sorter: true,
      sortOrder: sortBy === 'requests_per_second' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (_: any, record: RateLimit) => getRpsDisplay(record.requests_per_second),
    },
    {
      title: t('common.status'),
      dataIndex: 'is_active',
      key: 'is_active',
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'green' : 'red'}>
          {isActive ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('common.description'),
      key: 'description',
      render: (_: any, record: RateLimit) => {
        if (record.requests_per_second === 0) {
          return <Text type="secondary">{t('rateLimit.allowUnlimitedCalls')}</Text>;
        }
        const dailyMax = record.requests_per_second * 86400;
        return <Text type="secondary">{t('rateLimit.dailyMaxCalls', { count: dailyMax.toLocaleString() })}</Text>;
      },
    },
    {
      title: t('common.operation'),
      key: 'actions',
      render: (_: any, record: RateLimit) => (
        <Space>
          <Tooltip title={t('rateLimit.editConfig')}>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title={t('rateLimit.confirmDeleteRateLimit')}
            description={t('rateLimit.deleteRateLimitWarning')}
            onConfirm={() => handleDelete(record.tenant_id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Tooltip title={t('rateLimit.deleteConfig')}>
              <Button
                type="link"
                size="small"
                danger
                icon={<DeleteOutlined />}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('rateLimit.totalConfigurations')}
              value={stats.totalUsers}
              prefix={<UserOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('rateLimit.unlimitedTenants')}
              value={stats.unlimitedUsers}
              prefix={<ThunderboltOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('rateLimit.averageRateLimit')}
              value={stats.avgRps}
              precision={1}
              suffix="RPS"
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('rateLimit.restrictedTenants')}
              value={stats.totalUsers - stats.unlimitedUsers}
              prefix={<ThunderboltOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <Title level={4} style={{ margin: 0 }}>
              <ThunderboltOutlined style={{ marginRight: 8 }} />
              {t('rateLimit.tenantRateLimitConfig')}
            </Title>
            <Text type="secondary">
              {t('rateLimit.configureApiCallFrequency')}
              <Tooltip title={t('rateLimit.rateLimitExplanation')}>
                <InfoCircleOutlined style={{ marginLeft: 4 }} />
              </Tooltip>
            </Text>
          </div>
          <Space>
            <Input.Search
              placeholder={t('rateLimit.searchByEmail')}
              allowClear
              onSearch={handleSearch}
              onChange={(e) => {
                if (!e.target.value) {
                  handleSearch('');
                }
              }}
              style={{ width: 300 }}
              prefix={<SearchOutlined />}
            />
            <Button
              icon={<ReloadOutlined />}
              onClick={() => loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder)}
              loading={loading}
            >
              {t('common.refresh')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleAdd}
            >
              {t('rateLimit.addConfig')}
            </Button>
          </Space>
        </div>

        <Table
          columns={columns}
          dataSource={rateLimits}
          rowKey="tenant_id"
          loading={loading}
          pagination={{
            ...pagination,
            total: total,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total) => t('rateLimit.totalConfigCount', { count: total }),
          }}
          onChange={handleTableChange}
        />
      </Card>

      <Modal
        title={editingRateLimit ? t('rateLimit.editRateLimitConfig') : t('rateLimit.addRateLimitConfig')}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          form.resetFields();
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
          {!editingRateLimit && (
            <Form.Item
              name="tenant_id"
              label={t('rateLimit.selectTenant')}
              rules={[{ required: true, message: t('rateLimit.selectTenant') }]}
            >
              <Select
                placeholder={t('rateLimit.selectTenantPlaceholder')}
                showSearch
                optionFilterProp="children"
              >
                {getAvailableUsers().map(user => (
                  <Option key={user.id} value={user.id}>
                    {user.email}
                    {user.is_super_admin && <Tag color="red" style={{ marginLeft: 8 }}>{t('admin.admin')}</Tag>}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          )}

          <Form.Item
            name="requests_per_second"
            label={t('rateLimit.requestFrequencyLimit')}
            rules={[{ required: true, message: t('rateLimit.requestFrequencyRequired') }]}
            extra={t('rateLimit.requestFrequencyExtra')}
            initialValue={1}
          >
            <InputNumber
              min={0}
              max={1000}
              style={{ width: '100%' }}
              addonAfter={t('rateLimit.requestsPerSecond')}
              placeholder={t('rateLimit.requestFrequencyPlaceholder')}
            />
          </Form.Item>

          <Form.Item
            name="is_active"
            label={t('rateLimit.enableStatus')}
            valuePropName="checked"
            initialValue={true}
          >
            <Switch
              checkedChildren={t('common.enabled')}
              unCheckedChildren={t('common.disabled')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default RateLimitManagement;