import React, { useEffect, useState } from 'react';
import { Card, Table, Button, message, Tag, Space, Modal, Select, Input, Progress, Popconfirm } from 'antd';
import { ReloadOutlined, EditOutlined, SyncOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { billingService } from '../../services/billing';
import type { SubscriptionListItem } from '../../types/billing';

const { Search } = Input;

const SubscriptionManagement: React.FC = () => {
  const { t } = useTranslation();
  const [subscriptions, setSubscriptions] = useState<SubscriptionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'free' | 'subscribed' | undefined>(undefined);
  const [sortBy, setSortBy] = useState<'current_month_usage' | 'usage_reset_at'>('current_month_usage');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [selectedSubscription, setSelectedSubscription] = useState<SubscriptionListItem | null>(null);
  const [newSubscriptionType, setNewSubscriptionType] = useState<'free' | 'subscribed'>('free');

  const fetchSubscriptions = async () => {
    try {
      setLoading(true);
      const { data, total: totalCount } = await billingService.listAllSubscriptions({
        skip: (currentPage - 1) * pageSize,
        limit: pageSize,
        search: search || undefined,
        subscription_type: filterType,
        sort_by: sortBy,
        sort_order: sortOrder
      });
      setSubscriptions(data);
      setTotal(totalCount);
    } catch (error: any) {
      message.error(error.message || t('admin.subscriptions.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscriptions();
  }, [currentPage, pageSize, search, filterType, sortBy, sortOrder]);

  const handleEditSubscription = (subscription: SubscriptionListItem) => {
    setSelectedSubscription(subscription);
    setNewSubscriptionType(subscription.subscription_type);
    setEditModalVisible(true);
  };

  const handleUpdateSubscription = async () => {
    if (!selectedSubscription) return;

    try {
      await billingService.updateSubscription(selectedSubscription.tenant_id, {
        subscription_type: newSubscriptionType
      });
      message.success(t('admin.subscriptions.updateSuccess'));
      setEditModalVisible(false);
      fetchSubscriptions();
    } catch (error: any) {
      message.error(error.message || t('admin.subscriptions.updateFailed'));
    }
  };

  const handleResetQuota = async (tenantId: string) => {
    try {
      await billingService.resetTenantQuota(tenantId);
      message.success(t('admin.subscriptions.resetSuccess'));
      fetchSubscriptions();
    } catch (error: any) {
      message.error(error.message || t('admin.subscriptions.resetFailed'));
    }
  };

  const columns = [
    {
      title: t('admin.subscriptions.email'),
      dataIndex: 'email',
      key: 'email',
      width: 250,
    },
    {
      title: t('admin.subscriptions.plan'),
      dataIndex: 'subscription_type',
      key: 'subscription_type',
      width: 150,
      render: (type: string, record: SubscriptionListItem) => (
        <Tag color={type === 'subscribed' ? 'blue' : 'default'}>
          {record.plan_name}
        </Tag>
      ),
    },
    {
      title: t('admin.subscriptions.usage'),
      key: 'usage',
      width: 300,
      sorter: true,
      sortOrder: sortBy === 'current_month_usage' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (_: any, record: SubscriptionListItem) => (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <div>
            {record.current_month_usage.toLocaleString()} / {record.monthly_quota.toLocaleString()}
            {' '}({record.usage_percentage.toFixed(1)}%)
          </div>
          <Progress
            percent={Math.min(record.usage_percentage, 100)}
            status={record.usage_percentage >= 90 ? 'exception' : 'active'}
            strokeColor={record.usage_percentage >= 90 ? '#ff4d4f' : '#1890ff'}
            size="small"
          />
        </Space>
      ),
    },
    {
      title: t('admin.subscriptions.resetDate'),
      dataIndex: 'usage_reset_at',
      key: 'usage_reset_at',
      width: 150,
      sorter: true,
      sortOrder: sortBy === 'usage_reset_at' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 180,
      render: (_: any, record: SubscriptionListItem) => (
        <Space>
          <Button
            icon={<EditOutlined />}
            size="small"
            onClick={() => handleEditSubscription(record)}
          >
            {t('common.edit')}
          </Button>
          <Popconfirm
            title={t('admin.subscriptions.resetConfirm')}
            onConfirm={() => handleResetQuota(record.tenant_id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              icon={<SyncOutlined />}
              size="small"
              danger
            >
              {t('admin.subscriptions.reset')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('admin.subscriptions.title')}
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={fetchSubscriptions}
          loading={loading}
        >
          {t('common.refresh')}
        </Button>
      }
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Space>
          <Search
            placeholder={t('admin.subscriptions.searchPlaceholder')}
            onSearch={setSearch}
            style={{ width: 300 }}
            allowClear
          />
          <Select
            style={{ width: 200 }}
            placeholder={t('admin.subscriptions.filterByType')}
            allowClear
            value={filterType}
            onChange={setFilterType}
          >
            <Select.Option value="free">{t('admin.subscriptions.freePlan')}</Select.Option>
            <Select.Option value="subscribed">{t('admin.subscriptions.subscribedPlan')}</Select.Option>
          </Select>
        </Space>

        <Table
          columns={columns}
          dataSource={subscriptions}
          rowKey="id"
          loading={loading}
          onChange={(pagination, filters, sorter: any) => {
            if (sorter && sorter.columnKey) {
              const newSortBy = sorter.columnKey === 'usage' ? 'current_month_usage' : sorter.columnKey;
              const newSortOrder = sorter.order === 'ascend' ? 'asc' : 'desc';
              setSortBy(newSortBy);
              setSortOrder(newSortOrder);
              setCurrentPage(1); // Reset to first page when sorting changes
            }
          }}
          pagination={{
            current: currentPage,
            pageSize: pageSize,
            total: total,
            onChange: (page, size) => {
              setCurrentPage(page);
              setPageSize(size || 20);
            },
            showSizeChanger: true,
            showTotal: (total) => t('admin.subscriptions.total', { count: total }),
          }}
        />
      </Space>

      <Modal
        title={t('admin.subscriptions.editSubscription')}
        open={editModalVisible}
        onOk={handleUpdateSubscription}
        onCancel={() => setEditModalVisible(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        {selectedSubscription && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <strong>{t('admin.subscriptions.tenant')}:</strong> {selectedSubscription.email}
            </div>
            <div>
              <strong>{t('admin.subscriptions.currentPlan')}:</strong>{' '}
              <Tag color={selectedSubscription.subscription_type === 'subscribed' ? 'blue' : 'default'}>
                {selectedSubscription.plan_name}
              </Tag>
            </div>
            <div>
              <strong>{t('admin.subscriptions.newPlan')}:</strong>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                value={newSubscriptionType}
                onChange={setNewSubscriptionType}
              >
                <Select.Option value="free">
                  {t('admin.subscriptions.freePlan')} (10,000 {t('account.calls')}/month)
                </Select.Option>
                <Select.Option value="subscribed">
                  {t('admin.subscriptions.subscribedPlan')} (1,000,000 {t('account.calls')}/month)
                </Select.Option>
              </Select>
            </div>
          </Space>
        )}
      </Modal>
    </Card>
  );
};

export default SubscriptionManagement;
