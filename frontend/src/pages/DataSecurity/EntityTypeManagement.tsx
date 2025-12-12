import React, { useState, useEffect } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  message,
  Space,
  Tag,
  Popconfirm,
  Tooltip,
  Card,
  Typography,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, GlobalOutlined, UserOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { dataSecurityApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useApplication } from '../../contexts/ApplicationContext';

const { Option } = Select;
const { TextArea } = Input;
const { Text } = Typography;

interface EntityType {
  id: string;
  entity_type: string;
  display_name: string;
  risk_level?: string; // Frontend field name
  category?: string; // Backend field name (alias for risk_level)
  pattern: string;
  anonymization_method: string;
  anonymization_config: any;
  check_input: boolean;
  check_output: boolean;
  is_active: boolean;
  is_global: boolean;
  source_type?: string; // 'system_template', 'system_copy', 'custom'
  template_id?: string;
  created_at: string;
  updated_at: string;
}

const EntityTypeManagement: React.FC = () => {
  const { t } = useTranslation();
  
  const RISK_LEVELS = [
    { value: 'low', label: t('entityType.lowRisk'), color: 'green' },
    { value: 'medium', label: t('entityType.mediumRisk'), color: 'orange' },
    { value: 'high', label: t('entityType.highRisk'), color: 'red' },
  ];

  const ANONYMIZATION_METHODS = [
    { value: 'replace', label: t('entityType.replace') },
    { value: 'mask', label: t('entityType.mask') },
    { value: 'hash', label: t('entityType.hash') },
    { value: 'encrypt', label: t('entityType.encrypt') },
    { value: 'shuffle', label: t('entityType.shuffle') },
    { value: 'random', label: t('entityType.randomReplace') },
  ];
  const [entityTypes, setEntityTypes] = useState<EntityType[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingEntity, setEditingEntity] = useState<EntityType | null>(null);
  const [searchText, setSearchText] = useState('');
  const [riskLevelFilter, setRiskLevelFilter] = useState<string | undefined>(undefined);
  const [form] = Form.useForm();
  const { user, onUserSwitch } = useAuth();
  const { currentApplicationId } = useApplication();

  useEffect(() => {
    if (currentApplicationId) {
      loadEntityTypes();
    }
  }, [currentApplicationId]);

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadEntityTypes();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  const loadEntityTypes = async () => {
    setLoading(true);
    try {
      const response = await dataSecurityApi.getEntityTypes();
      setEntityTypes(response.items || []);
    } catch (error) {
      message.error(t('entityType.loadEntityTypesFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingEntity(null);
    form.resetFields();
    form.setFieldsValue({
      is_active: true,
      check_input: true,
      check_output: true,
      anonymization_method: 'replace',
      is_global: false, // Default to custom configuration
    });
    setModalVisible(true);
  };

  const handleEdit = (record: EntityType) => {
    setEditingEntity(record);
    form.setFieldsValue({
      ...record,
      // Map backend 'category' field to frontend 'risk_level' field
      risk_level: record.category || record.risk_level,
      anonymization_config_text: JSON.stringify(record.anonymization_config || {}, null, 2),
      // Explicitly set check_input and check_output to ensure they are properly bound
      check_input: record.check_input,
      check_output: record.check_output,
    });
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await dataSecurityApi.deleteEntityType(id);
      message.success(t('common.deleteSuccess'));
      loadEntityTypes();
    } catch (error) {
      message.error(t('common.deleteFailed'));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();

      // Parse JSON config
      let anonymization_config = {};

      try {
        anonymization_config = JSON.parse(values.anonymization_config_text || '{}');
      } catch (e) {
        message.error(t('entityType.invalidJsonConfig'));
        return;
      }

      const data = {
        entity_type: values.entity_type,
        display_name: values.display_name,
        risk_level: values.risk_level,
        pattern: values.pattern,
        anonymization_method: values.anonymization_method,
        anonymization_config,
        check_input: values.check_input !== undefined ? values.check_input : true,
        check_output: values.check_output !== undefined ? values.check_output : true,
        is_active: values.is_active !== undefined ? values.is_active : true,
      };

      if (editingEntity) {
        await dataSecurityApi.updateEntityType(editingEntity.id, data);
        message.success(t('common.updateSuccess'));
      } else {
        // Determine which API to call based on is_global field
        if (values.is_global && user?.is_super_admin) {
          await dataSecurityApi.createGlobalEntityType(data);
          message.success(t('entityType.createGlobalSuccess'));
        } else {
          await dataSecurityApi.createEntityType(data);
          message.success(t('common.createSuccess'));
        }
      }

      setModalVisible(false);
      loadEntityTypes();
    } catch (error) {
      console.error('Submit error:', error);
    }
  };

  const columns = [
    {
      title: t('entityType.entityTypeColumn'),
      dataIndex: 'entity_type',
      key: 'entity_type',
      width: 150,
    },
    {
      title: t('entityType.displayNameColumn'),
      dataIndex: 'display_name',
      key: 'display_name',
      width: 120,
    },
    {
      title: t('entityType.riskLevelColumn'),
      dataIndex: 'risk_level',
      key: 'risk_level',
      width: 100,
      render: (_: any, record: EntityType) => {
        const risk_level = record.category || record.risk_level;
        const level = RISK_LEVELS.find((l) => l.value === risk_level);
        return <Tag color={level?.color}>{level?.label || risk_level}</Tag>;
      },
    },
    {
      title: t('entityType.recognitionRulesColumn'),
      dataIndex: 'pattern',
      key: 'pattern',
      width: 200,
      ellipsis: true,
      render: (pattern: string) => (
        <Tooltip title={pattern}>
          <code style={{ fontSize: '12px' }}>{pattern}</code>
        </Tooltip>
      ),
    },
    {
      title: t('entityType.desensitizationMethodColumn'),
      dataIndex: 'anonymization_method',
      key: 'anonymization_method',
      width: 100,
      render: (method: string) => {
        const m = ANONYMIZATION_METHODS.find((a) => a.value === method);
        return m?.label;
      },
    },
    {
      title: t('entityType.detectionScopeColumn'),
      key: 'check_scope',
      width: 100,
      render: (_: any, record: EntityType) => (
        <Space size={4}>
          {record.check_input && <Tag color="blue" style={{ margin: 0 }}>{t('entityType.input')}</Tag>}
          {record.check_output && <Tag color="green" style={{ margin: 0 }}>{t('entityType.output')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('entityType.statusColumn'),
      dataIndex: 'is_active',
      key: 'is_active',
      width: 80,
      render: (is_active: boolean) => (
        <Tag color={is_active ? 'green' : 'default'}>{is_active ? t('common.enabled') : t('common.disabled')}</Tag>
      ),
    },
    {
      title: t('entityType.sourceColumn'),
      dataIndex: 'source_type',
      key: 'source_type',
      width: 100,
      render: (_: any, record: EntityType) => {
        const sourceType = record.source_type || (record.is_global ? 'system_template' : 'custom');
        
        if (sourceType === 'system_template') {
          return (
            <Tag icon={<GlobalOutlined />} color="blue">
              {t('entityType.systemTemplate')}
            </Tag>
          );
        } else if (sourceType === 'system_copy') {
          return (
            <Tag icon={<GlobalOutlined />} color="cyan">
              {t('entityType.systemCopy')}
            </Tag>
          );
        } else {
          return (
            <Tag icon={<UserOutlined />} color="default">
              {t('entityType.custom')}
            </Tag>
          );
        }
      },
    },
    {
      title: t('entityType.operationColumn'),
      key: 'action',
      width: 120,
      render: (_: any, record: EntityType) => {
        const sourceType = record.source_type || (record.is_global ? 'system_template' : 'custom');
        const canEdit = sourceType === 'system_template' 
          ? user?.is_super_admin 
          : true; // system_copy and custom can be edited by owner
        const canDelete = sourceType === 'system_template'
          ? user?.is_super_admin
          : sourceType === 'custom'; // system_copy cannot be deleted
        
        return (
          <Space size="small">
            <Tooltip title={canEdit ? t('common.edit') : t('entityType.noEditPermission')}>
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => handleEdit(record)}
                disabled={!canEdit}
              />
            </Tooltip>
            <Tooltip title={canDelete ? t('common.delete') : (sourceType === 'system_copy' ? t('entityType.cannotDeleteSystemCopy') : t('entityType.noDeletePermission'))}>
              <Popconfirm 
                title={t('common.confirmDelete')} 
                onConfirm={() => handleDelete(record.id)}
                disabled={!canDelete}
              >
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={!canDelete}
                />
              </Popconfirm>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  // Filter data
  const filteredEntityTypes = entityTypes.filter(item => {
    const matchesSearch = !searchText ||
      item.entity_type.toLowerCase().includes(searchText.toLowerCase()) ||
      item.display_name.toLowerCase().includes(searchText.toLowerCase()) ||
      item.pattern.toLowerCase().includes(searchText.toLowerCase());

    const risk_level = item.category || item.risk_level;
    const matchesRiskLevel = !riskLevelFilter || risk_level === riskLevelFilter;

    return matchesSearch && matchesRiskLevel;
  });

  return (
    <div>
      <Card
        title={t('entityType.entityTypeConfig')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('entityType.addEntityTypeConfig')}
          </Button>
        }
        bordered={false}
      >
        <Space style={{ marginBottom: 16, width: '100%' }} direction="vertical">
          <Space>
            <Input.Search
              placeholder={t('entityType.searchPlaceholder')}
              allowClear
              style={{ width: 300 }}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <Select
              placeholder={t('entityType.filterRiskLevel')}
              allowClear
              style={{ width: 150 }}
              onChange={(value) => setRiskLevelFilter(value)}
            >
              {RISK_LEVELS.map((level) => (
                <Option key={level.value} value={level.value}>
                  {level.label}
                </Option>
              ))}
            </Select>
          </Space>
        </Space>

        <Table
          columns={columns}
          dataSource={filteredEntityTypes}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 10,
            showTotal: (total) => t('banPolicy.totalRecords', { total }),
          }}
        />
      </Card>

      <Modal
        title={editingEntity ? t('entityType.editEntityType') : t('entityType.addEntityType')}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        width={800}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="entity_type"
            label={t('entityType.entityTypeCode')}
            rules={[{ required: true, message: t('entityType.entityTypeCodeRequired') }]}
          >
            <Input 
              placeholder={t('entityType.entityTypeCodePlaceholder')} 
              disabled={!!editingEntity} 
            />
          </Form.Item>
          
          {editingEntity && editingEntity.source_type === 'system_copy' && (
            <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#e6f7ff', borderRadius: 4 }}>
              <InfoCircleOutlined style={{ marginRight: 8, color: '#1890ff' }} />
              <Text type="secondary">{t('entityType.systemCopyEditHint')}</Text>
            </div>
          )}

          <Form.Item
            name="display_name"
            label={t('entityType.displayNameLabel')}
            rules={[{ required: true, message: t('entityType.displayNameRequired') }]}
          >
            <Input placeholder={t('entityType.displayNamePlaceholder')} />
          </Form.Item>

          <Form.Item name="risk_level" label={t('entityType.riskLevelLabel')} rules={[{ required: true, message: t('entityType.riskLevelRequired') }]}>
            <Select placeholder={t('entityType.riskLevelPlaceholder')}>
              {RISK_LEVELS.map((level) => (
                <Option key={level.value} value={level.value}>
                  {level.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="pattern"
            label={t('entityType.recognitionRuleLabel')}
            rules={[{ required: true, message: t('entityType.recognitionRuleRequired') }]}
            tooltip={t('entityType.recognitionRuleTooltip')}
          >
            <TextArea
              rows={3}
              placeholder={t('entityType.recognitionRulePlaceholder')}
              style={{ fontFamily: 'monospace' }}
            />
          </Form.Item>

          <Form.Item
            name="anonymization_method"
            label={t('entityType.anonymizationMethodLabel')}
            rules={[{ required: true, message: t('entityType.anonymizationMethodRequired') }]}
          >
            <Select placeholder={t('entityType.anonymizationMethodPlaceholder')}>
              {ANONYMIZATION_METHODS.map((method) => (
                <Option key={method.value} value={method.value}>
                  {method.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="anonymization_config_text"
            label={t('entityType.anonymizationConfigLabel')}
          >
            <TextArea
              rows={4}
              placeholder={t('entityType.anonymizationConfigPlaceholder')}
              style={{ fontFamily: 'monospace' }}
            />
            <Card size="small" style={{ marginTop: 8, backgroundColor: '#f5f5f5' }}>
              <Text strong style={{ fontSize: 12 }}>{t('entityType.anonymizationMethodConfigDesc')}</Text>
              <ul style={{ margin: '8px 0', paddingLeft: 20, fontSize: 11 }}>
                <li><Text code>replace</Text> - {t('entityType.replaceDesc')}
                  <br /><Text type="secondary">{t('entityType.replaceExample')}</Text>
                </li>
                <li><Text code>mask</Text> - {t('entityType.maskDesc')}
                  <br /><Text type="secondary">{t('entityType.maskExample')}</Text>
                  <br /><Text type="secondary">{t('entityType.maskExample2')}</Text>
                </li>
                <li><Text code>hash</Text> - {t('entityType.hashDesc')}
                  <br /><Text type="secondary">{t('entityType.hashExample')}</Text>
                </li>
                <li><Text code>encrypt</Text> - {t('entityType.encryptDesc')}
                  <br /><Text type="secondary">{t('entityType.encryptExample')}</Text>
                </li>
                <li><Text code>shuffle</Text> - {t('entityType.shuffleDesc')}
                  <br /><Text type="secondary">{t('entityType.shuffleExample')}</Text>
                </li>
                <li><Text code>random</Text> - {t('entityType.randomDesc')}
                  <br /><Text type="secondary">{t('entityType.randomExample')}</Text>
                </li>
              </ul>
            </Card>
          </Form.Item>

          <Form.Item label={t('entityType.detectionScopeLabel')}>
            <Space>
              <Form.Item name="check_input" valuePropName="checked" noStyle>
                <Switch checkedChildren={t('entityType.inputSwitch')} unCheckedChildren={t('entityType.inputSwitch')} />
              </Form.Item>
              <Form.Item name="check_output" valuePropName="checked" noStyle>
                <Switch checkedChildren={t('entityType.outputSwitch')} unCheckedChildren={t('entityType.outputSwitch')} />
              </Form.Item>
            </Space>
          </Form.Item>

          <Form.Item name="is_active" label={t('entityType.enableStatusLabel')} valuePropName="checked">
            <Switch />
          </Form.Item>

          {user?.is_super_admin && (
            <Form.Item
              name="is_global"
              label={
                <span>
                  {t('entityType.systemConfigLabel')}
                  <Tooltip title={t('entityType.systemConfigTooltip')}>
                    <InfoCircleOutlined style={{ marginLeft: 4 }} />
                  </Tooltip>
                </span>
              }
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default EntityTypeManagement;
