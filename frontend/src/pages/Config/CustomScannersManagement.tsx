import React, { useState, useEffect } from 'react';
import { Card, Table, Button, message, Spin, Space, Modal, Form, Input, Select, Tag, Alert, Collapse, Switch, Result, Typography } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, CrownOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { customScannersApi } from '../../services/api';
import { useApplication } from '../../contexts/ApplicationContext';
import { eventBus, EVENTS } from '../../utils/eventBus';
import { billingService } from '../../services/billing';

const { TextArea } = Input;
const { Text } = Typography;
const { Option } = Select;
const { Panel } = Collapse;

interface CustomScanner {
  id: string;
  custom_scanner_id: string;
  tag: string;
  name: string;
  description?: string;
  scanner_type: string;
  definition: string;
  default_risk_level: string;
  default_scan_prompt: boolean;
  default_scan_response: boolean;
  notes?: string;
  created_by: string;
  created_at?: string;
  updated_at?: string;
  is_enabled?: boolean;
}

const CustomScannersManagement: React.FC = () => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const { currentApplicationId } = useApplication();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanners, setScanners] = useState<CustomScanner[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingScanner, setEditingScanner] = useState<CustomScanner | null>(null);
  const [isSubscribed, setIsSubscribed] = useState<boolean | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);

  useEffect(() => {
    checkSubscription();
    if (currentApplicationId) {
      loadData();
    }
  }, [currentApplicationId]);

  const checkSubscription = async () => {
    try {
      setSubscriptionLoading(true);
      const subscription = await billingService.getCurrentSubscription();
      setIsSubscribed(subscription?.subscription_type === 'subscribed');
    } catch (error) {
      console.error('Failed to check subscription:', error);
      setIsSubscribed(false);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const scannersData = await customScannersApi.getAll();
      setScanners(scannersData);
    } catch (error: any) {
      // Handle 403 subscription error gracefully
      if (error.response?.status === 403) {
        setScanners([]);
        // Don't show error message, the UI will show the upgrade prompt
      } else {
        message.error(t('customScanners.loadFailed'));
        console.error('Failed to load custom scanners:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    if (!isSubscribed) {
      showUpgradeModal();
      return;
    }
    setEditingScanner(null);
    form.resetFields();
    setModalVisible(true);
  };

  const showUpgradeModal = () => {
    Modal.info({
      title: (
        <Space>
          <CrownOutlined style={{ color: '#faad14' }} />
          {t('customScanners.premiumFeature')}
        </Space>
      ),
      content: (
        <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 16 }}>
          <div>
            <p style={{ fontSize: 15, marginBottom: 12 }}>{t('customScanners.premiumFeatureDesc')}</p>
            <ul style={{ paddingLeft: 20, marginBottom: 16 }}>
              <li>{t('customScanners.feature1')}</li>
              <li>{t('customScanners.feature2')}</li>
              <li>{t('customScanners.feature3')}</li>
              <li>{t('customScanners.feature4')}</li>
            </ul>
          </div>
        </Space>
      ),
      okText: t('customScanners.upgradeNow'),
      onOk: () => {
        navigate('/subscription');
      },
      width: 520,
      icon: null,
    });
  };

  const handleEdit = (scanner: CustomScanner) => {
    setEditingScanner(scanner);
    form.setFieldsValue({
      scanner_type: scanner.scanner_type,
      name: scanner.name,
      definition: scanner.definition,
      risk_level: scanner.default_risk_level,
      scan_prompt: scanner.default_scan_prompt,
      scan_response: scanner.default_scan_response,
      notes: scanner.notes,
      is_enabled: scanner.is_enabled !== false,
    });
    setModalVisible(true);
  };

  const handleToggleEnable = async (scanner: CustomScanner, enabled: boolean) => {
    try {
      await customScannersApi.update(scanner.id, { is_enabled: enabled });
      message.success(enabled ? t('customScanners.enableSuccess') : t('customScanners.disableSuccess'));
      await loadData();
    } catch (error) {
      message.error(t('customScanners.toggleFailed'));
      console.error('Failed to toggle scanner:', error);
    }
  };

  const handleDelete = (scanner: CustomScanner) => {
    Modal.confirm({
      title: t('customScanners.deleteScanner'),
      content: (
        <div>
          <p>{t('customScanners.confirmDelete')}</p>
          <p style={{ color: '#ff4d4f', fontSize: '12px' }}>
            {t('customScanners.deleteWarning')}
          </p>
        </div>
      ),
      onOk: async () => {
        try {
          await customScannersApi.delete(scanner.id);
          message.success(t('customScanners.deleteSuccess'));
          await loadData();
          // Emit event to notify other components
          eventBus.emit(EVENTS.SCANNER_DELETED, { scannerId: scanner.id, scannerTag: scanner.tag });
        } catch (error) {
          message.error(t('customScanners.deleteFailed'));
        }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      if (editingScanner) {
        await customScannersApi.update(editingScanner.id, values);
        message.success(t('customScanners.updateSuccess'));
        // Emit event to notify other components
        eventBus.emit(EVENTS.SCANNER_UPDATED, { scannerId: editingScanner.id });
      } else {
        await customScannersApi.create(values);
        message.success(t('customScanners.createSuccess'));
        // Emit event to notify other components
        eventBus.emit(EVENTS.SCANNER_CREATED);
      }

      setModalVisible(false);
      form.resetFields();
      await loadData();
    } catch (error: any) {
      if (error.errorFields) {
        // Validation error
        return;
      }
      message.error(editingScanner ? t('customScanners.updateFailed') : t('customScanners.createFailed'));
      console.error('Failed to save scanner:', error);
    } finally {
      setSaving(false);
    }
  };

  const getRiskLevelColor = (level: string) => {
    const colors: { [key: string]: string } = {
      'high_risk': 'red',
      'medium_risk': 'orange',
      'low_risk': 'green',
    };
    return colors[level] || 'default';
  };

  const getScannerTypeLabel = (type: string) => {
    const types: { [key: string]: string } = {
      'genai': t('scannerPackages.scannerTypeGenai'),
      'regex': t('scannerPackages.scannerTypeRegex'),
      'keyword': t('scannerPackages.scannerTypeKeyword'),
    };
    return types[type] || type;
  };

  const getDefinitionPlaceholder = (type: string) => {
    if (type === 'keyword') {
      return t('customScanners.keywordPlaceholder') || '';
    }
    return t(`customScanners.definitionPlaceholder.${type}` as any) || '';
  };

  const columns = [
    {
      title: t('customScanners.scannerTag'),
      dataIndex: 'tag',
      key: 'tag',
      width: 80,
      render: (tag: string) => <Tag color="purple">{tag}</Tag>,
    },
    {
      title: t('customScanners.scannerName'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (text: string) => (
        <div style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.4'
        }}>
          {text}
        </div>
      ),
    },
    {
      title: t('customScanners.scannerType'),
      dataIndex: 'scanner_type',
      key: 'scanner_type',
      width: 120,
      render: (type: string) => getScannerTypeLabel(type),
    },
    {
      title: t('customScanners.riskLevel'),
      dataIndex: 'default_risk_level',
      key: 'default_risk_level',
      width: 120,
      render: (level: string) => (
        <Tag color={getRiskLevelColor(level)}>
          {t(`risk.level.${level}`)}
        </Tag>
      ),
    },
    {
      title: t('customScanners.scannerDefinition'),
      dataIndex: 'definition',
      key: 'definition',
      render: (text: string) => (
        <div style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.4',
          flex: 1
        }}>
          {text}
        </div>
      ),
    },
    {
      title: t('customScanners.enabled'),
      dataIndex: 'is_enabled',
      key: 'is_enabled',
      width: 100,
      render: (enabled: boolean, record: CustomScanner) => (
        <Switch
          checked={enabled !== false}
          onChange={(checked) => handleToggleEnable(record, checked)}
        />
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 150,
      render: (_: any, record: CustomScanner) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="link"
            danger
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record)}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const selectedScannerType = Form.useWatch('scanner_type', form);

  // Show loading state while checking subscription
  if (subscriptionLoading) {
    return <Spin spinning={true} />;
  }

  // Show upgrade prompt if not subscribed
  if (isSubscribed === false) {
    return (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card>
          <Result
            icon={<CrownOutlined style={{ color: '#faad14', fontSize: 72 }} />}
            title={
              <Space>
                <LockOutlined />
                {t('customScanners.premiumFeatureTitle')}
              </Space>
            }
            subTitle={t('customScanners.premiumFeatureSubtitle')}
            extra={[
              <Button 
                type="primary" 
                size="large" 
                key="upgrade"
                icon={<CrownOutlined />}
                onClick={() => navigate('/subscription')}
              >
                {t('customScanners.upgradeNow')}
              </Button>,
            ]}
          >
            <div style={{ 
              textAlign: 'left', 
              maxWidth: 600, 
              margin: '0 auto',
              padding: '24px',
              background: '#fafafa',
              borderRadius: 8
            }}>
              <h3 style={{ marginBottom: 16 }}>
                <CrownOutlined style={{ color: '#faad14', marginRight: 8 }} />
                {t('customScanners.benefitsTitle')}
              </h3>
              <ul style={{ paddingLeft: 20, fontSize: 15, lineHeight: 2 }}>
                <li>{t('customScanners.feature1')}</li>
                <li>{t('customScanners.feature2')}</li>
                <li>{t('customScanners.feature3')}</li>
                <li>{t('customScanners.feature4')}</li>
                <li>{t('customScanners.feature5')}</li>
              </ul>
              <div style={{ 
                marginTop: 24, 
                padding: 16, 
                background: '#fff', 
                borderRadius: 6,
                border: '1px solid #d9d9d9'
              }}>
                <Text strong style={{ fontSize: 16 }}>
                  {t('customScanners.pricingInfo')}
                </Text>
                <div style={{ marginTop: 8, fontSize: 14, color: '#666' }}>
                  {t('customScanners.pricingDetails')}
                </div>
              </div>
            </div>
          </Result>
        </Card>
      </Space>
    );
  }

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          message={
            <Space>
              <CrownOutlined style={{ color: '#faad14' }} />
              <span>{t('customScanners.premiumActiveMessage')}</span>
            </Space>
          }
          description={t('customScanners.premiumActiveDesc')}
          type="success"
          showIcon={false}
          closable
        />
        
        <Collapse style={{ backgroundColor: '#f8f9fa' }}>
          <Collapse.Panel header={t('customScanners.usageGuideTitle')} key="1">
            <div style={{ marginBottom: 16 }}>
              <strong>{t('customScanners.whatIsCustomScanner')}</strong>
              <p style={{ marginBottom: 16 }}>
                {t('customScanners.whatIsCustomScannerDesc')}
              </p>
            </div>

            <div style={{ marginBottom: 20 }}>
              <strong>{t('customScanners.examplesTitle')}</strong>

              <div style={{ marginTop: 12, padding: 16, backgroundColor: '#fff', border: '1px solid #d9d9d9', borderRadius: 6 }}>
                <h4 style={{ margin: '0 0 8px 0', color: '#1890ff' }}>
                  {t('customScanners.example1Title')}
                </h4>
                <p style={{ margin: '0 0 8px 0', fontWeight: 'bold' }}>
                  {t('customScanners.example1Name')}
                </p>
                <p style={{ margin: '0 0 4px 0' }}>
                  <strong>{t('customScanners.scannerType')}:</strong> {t('customScanners.exampleTypeGenai')}
                </p>
                <p style={{ margin: '0 0 4px 0' }}>
                  <strong>{t('customScanners.scannerDefinition')}:</strong> {t('customScanners.example1Definition')}
                </p>
                <p style={{ margin: '0', color: '#666', fontSize: '13px' }}>
                  {t('customScanners.example1Desc')}
                </p>
              </div>

              <div style={{ marginTop: 12, padding: 16, backgroundColor: '#fff', border: '1px solid #d9d9d9', borderRadius: 6 }}>
                <h4 style={{ margin: '0 0 8px 0', color: '#1890ff' }}>
                  {t('customScanners.example2Title')}
                </h4>
                <p style={{ margin: '0 0 8px 0', fontWeight: 'bold' }}>
                  {t('customScanners.example2Name')}
                </p>
                <p style={{ margin: '0 0 4px 0' }}>
                  <strong>{t('customScanners.scannerType')}:</strong> {t('customScanners.exampleTypeGenai')}
                </p>
                <p style={{ margin: '0 0 4px 0' }}>
                  <strong>{t('customScanners.scannerDefinition')}:</strong> {t('customScanners.example2Definition')}
                </p>
                <p style={{ margin: '0', color: '#666', fontSize: '13px' }}>
                  {t('customScanners.example2Desc')}
                </p>
              </div>

              <div style={{ marginTop: 12, padding: 16, backgroundColor: '#fff', border: '1px solid #d9d9d9', borderRadius: 6 }}>
                <h4 style={{ margin: '0 0 8px 0', color: '#ff4d4f' }}>
                  {t('customScanners.example3Title')}
                </h4>
                <p style={{ margin: '0 0 8px 0', fontWeight: 'bold' }}>
                  {t('customScanners.example3Name')}
                </p>
                <p style={{ margin: '0 0 4px 0' }}>
                  <strong>{t('customScanners.scannerType')}:</strong> {t('customScanners.exampleTypeKeyword')}
                </p>
                <p style={{ margin: '0 0 4px 0' }}>
                  <strong>{t('customScanners.scannerDefinition')}:</strong> {t('customScanners.example3Definition')}
                </p>
                <p style={{ margin: '0', color: '#666', fontSize: '13px' }}>
                  {t('customScanners.example3Desc')}
                </p>
              </div>
            </div>
          </Collapse.Panel>
        </Collapse>

        <Card
          title={t('customScanners.title')}
          extra={
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
                onClick={handleCreate}
              >
                {t('customScanners.createScanner')}
              </Button>
            </Space>
          }
        >
          <Table
            columns={columns}
            dataSource={scanners}
            rowKey="id"
            pagination={{ pageSize: 20 }}
            locale={{ emptyText: t('customScanners.noScannersFound') }}
            scroll={{ x: 1000 }}
            size="middle"
          />
        </Card>

        <Modal
          title={editingScanner ? t('customScanners.editScanner') : t('customScanners.createScanner')}
          open={modalVisible}
          onOk={handleSubmit}
          onCancel={() => {
            setModalVisible(false);
            form.resetFields();
          }}
          okText={t('common.save')}
          cancelText={t('common.cancel')}
          width={700}
          confirmLoading={saving}
        >
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              scan_prompt: true,
              scan_response: true,
              is_enabled: true,
            }}
          >
            <Form.Item
              label={t('customScanners.scannerType')}
              name="scanner_type"
              rules={[{ required: true, message: t('customScanners.validationErrors.typeRequired') }]}
            >
              <Select
                placeholder={t('customScanners.selectType')}
                disabled={!!editingScanner}
                optionLabelProp="label"
              >
                <Option value="genai" label={t('customScanners.typeGenai')}>
                  <div>
                    <div><strong>{t('customScanners.typeGenai')}</strong></div>
                    <div style={{ fontSize: '12px', color: '#999' }}>{t('customScanners.typeGenaiDesc')}</div>
                  </div>
                </Option>
                <Option value="regex" label={t('customScanners.typeRegex')}>
                  <div>
                    <div><strong>{t('customScanners.typeRegex')}</strong></div>
                    <div style={{ fontSize: '12px', color: '#999' }}>{t('customScanners.typeRegexDesc')}</div>
                  </div>
                </Option>
                <Option value="keyword" label={t('customScanners.typeKeyword')}>
                  <div>
                    <div><strong>{t('customScanners.typeKeyword')}</strong></div>
                    <div style={{ fontSize: '12px', color: '#999' }}>{t('customScanners.typeKeywordDesc')} {t('customScanners.typeKeywordFormat')}</div>
                  </div>
                </Option>
              </Select>
            </Form.Item>

            
            <Form.Item
              label={t('customScanners.scannerName')}
              name="name"
              rules={[
                { required: true, message: t('customScanners.validationErrors.nameRequired') },
                { max: 200, message: t('customScanners.validationErrors.nameTooLong') },
              ]}
            >
              <Input placeholder={t('customScanners.namePlaceholder')} />
            </Form.Item>

            <Form.Item
              label={t('customScanners.scannerDefinition')}
              name="definition"
              rules={[
                { required: true, message: t('customScanners.validationErrors.definitionRequired') },
                { max: 2000, message: t('customScanners.validationErrors.definitionTooLong') },
              ]}
            >
              <TextArea
                rows={4}
                placeholder={selectedScannerType ? getDefinitionPlaceholder(selectedScannerType) : ''}
              />
            </Form.Item>

            <Form.Item
              label={t('customScanners.riskLevel')}
              name="risk_level"
              rules={[{ required: true, message: t('customScanners.validationErrors.riskLevelRequired') }]}
            >
              <Select>
                <Option value="high_risk">{t('risk.level.high_risk')}</Option>
                <Option value="medium_risk">{t('risk.level.medium_risk')}</Option>
                <Option value="low_risk">{t('risk.level.low_risk')}</Option>
              </Select>
            </Form.Item>

            <Form.Item
              label={t('customScanners.scannerNotes')}
              name="notes"
              rules={[
                { max: 1000, message: t('customScanners.validationErrors.notesTooLong') },
              ]}
            >
              <TextArea rows={3} placeholder={t('customScanners.notesPlaceholder')} />
            </Form.Item>

            <Form.Item
              label={t('customScanners.enabled')}
              name="is_enabled"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>

            {!editingScanner && (
              <Alert
                message={t('customScanners.autoTag')}
                type="info"
                showIcon
              />
            )}
          </Form>
        </Modal>
      </Space>
    </Spin>
  );
};

export default CustomScannersManagement;
