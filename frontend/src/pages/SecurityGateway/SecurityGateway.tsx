import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Modal, Form, Input, Switch, message, Space, Popconfirm, Descriptions, Tag, Alert, Typography } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined, ApiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { proxyModelsApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

const { Paragraph, Text } = Typography;

interface ProxyModel {
  id: string;
  config_name: string;
  is_active: boolean;  // Backend uses 'is_active' not 'enabled'
  block_on_input_risk: boolean;
  block_on_output_risk: boolean;
  enable_reasoning_detection: boolean;
  stream_chunk_size: number;
  created_at: string;
}

interface ProxyModelFormData {
  config_name: string;
  api_base_url: string;
  api_key: string;
  is_active?: boolean;  // Backend uses 'is_active' not 'enabled'
  block_on_input_risk?: boolean;
  block_on_output_risk?: boolean;
  enable_reasoning_detection?: boolean;
  stream_chunk_size?: number;
}

const ProxyModelManagement: React.FC = () => {
  const { t } = useTranslation();
  const [models, setModels] = useState<ProxyModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isViewModalVisible, setIsViewModalVisible] = useState(false);
  const [editingModel, setEditingModel] = useState<ProxyModel | null>(null);
  const [viewingModel, setViewingModel] = useState<ProxyModel | null>(null);
  const [formKey, setFormKey] = useState(0); // For forcing form re-rendering
  const [form] = Form.useForm();
  const { onUserSwitch } = useAuth();
  const [maskedApiKey, setMaskedApiKey] = useState<string>(''); // Store masked API key for editing mode
  
  // Directly manage switch states (minimal configuration)
  const [switchStates, setSwitchStates] = useState({
    is_active: true,  // Backend field name
    block_on_input_risk: false,  // Default not block
    block_on_output_risk: false, // Default not block
    enable_reasoning_detection: true, // Default enable
    stream_chunk_size: 50, // Default check every 50 chunks
  });

  // Get model list
  const fetchModels = async () => {
    setLoading(true);
    try {
      const response = await proxyModelsApi.list();
      
      if (response.success) {
        setModels(response.data);
      } else {
        message.error(t('proxy.fetchModelsFailed'));
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
      message.error(t('proxy.fetchModelsFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchModels();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  // Get model detailed information (for editing)
  const fetchModelDetail = async (modelId: string) => {
    try {
      const response = await proxyModelsApi.get(modelId);
      
      if (response.success) {
        return response.data;
      } else {
        message.error(t('proxy.fetchModelDetailFailed'));
        return null;
      }
    } catch (error) {
      console.error('Failed to fetch model detail:', error);
      message.error(t('proxy.fetchModelDetailFailed'));
      return null;
    }
  };

  // Show create/edit modal
  const showModal = async (model?: ProxyModel) => {
    setEditingModel(model || null);
    
    if (model) {
      // Editing mode: first get complete data, then show modal
      const modelDetail = await fetchModelDetail(model.id);
      if (modelDetail) {
        console.log('=== Editing mode - data from server ===');
        console.log('is_active:', modelDetail.is_active, typeof modelDetail.is_active);
        console.log('block_on_input_risk:', modelDetail.block_on_input_risk, typeof modelDetail.block_on_input_risk);
        console.log('block_on_output_risk:', modelDetail.block_on_output_risk, typeof modelDetail.block_on_output_risk);
        console.log('enable_reasoning_detection:', modelDetail.enable_reasoning_detection, typeof modelDetail.enable_reasoning_detection);

        // Sync set form values and switch states (minimal configuration)
        const formValues = {
          config_name: modelDetail.config_name,
          api_base_url: modelDetail.api_base_url,
        };

        const switchValues = {
          is_active: modelDetail.is_active,
          block_on_input_risk: modelDetail.block_on_input_risk,
          block_on_output_risk: modelDetail.block_on_output_risk,
          enable_reasoning_detection: modelDetail.enable_reasoning_detection !== false,
          stream_chunk_size: modelDetail.stream_chunk_size || 50,
        };

        // Store masked API key for display
        setMaskedApiKey(modelDetail.api_key_masked || '');

        // Reset form and set values
        form.resetFields();
        form.setFieldsValue(formValues);
        setSwitchStates(switchValues);
        
        // Update form key and show modal
        setFormKey(prev => prev + 1);
        setIsModalVisible(true);
      } else {
        message.error(t('proxy.fetchModelDetailFailedCannotEdit'));
      }
    } else {
      // Create mode: directly set default values and show modal
      console.log('=== Create mode - set default values ===');
      
      // Reset form and switch states
      form.resetFields();
      setMaskedApiKey(''); // Clear masked API key for create mode
      setSwitchStates({
        is_active: true,  // Backend field name
        block_on_input_risk: false,  // Default not block
        block_on_output_risk: false, // Default not block
        enable_reasoning_detection: true, // Default enable
        stream_chunk_size: 50, // Default check every 50 chunks
      });
      
      // Update form key and show modal
      setFormKey(prev => prev + 1);
      setIsModalVisible(true);
    }
  };

  // Show view modal
  const showViewModal = (model: ProxyModel) => {
    setViewingModel(model);
    setIsViewModalVisible(true);
  };

  // Cancel editing - close modal and reset form state
  const handleCancel = () => {
    setIsModalVisible(false);
    setIsViewModalVisible(false);
    setEditingModel(null);
    setViewingModel(null);
    // Do not reset form immediately, wait for modal animation to complete
    setTimeout(() => {
      form.resetFields();
    }, 300);
  };

  // After success, close modal
  const handleClose = () => {
    setIsModalVisible(false);
    setIsViewModalVisible(false);
    setEditingModel(null);
    setViewingModel(null);
    // Do not reset form immediately, wait for modal animation to complete
    setTimeout(() => {
      form.resetFields();
    }, 300);
  };

  // Check if proxy model name is duplicate
  const checkConfigNameDuplicate = (configName: string): boolean => {
    return models.some(model => 
      model.config_name === configName && 
      (!editingModel || model.id !== editingModel.id)
    );
  };

  // Custom validator: check if proxy model name is duplicate
  const validateConfigName = async (_: any, value: string) => {
    if (value && checkConfigNameDuplicate(value)) {
      throw new Error(t('proxy.duplicateConfigName'));
    }
  };

  // Custom validator: check if API Base URL format is valid
  const validateApiBaseUrl = async (_: any, value: string) => {
    if (value && !value.match(/^https?:\/\/.+/)) {
      throw new Error(t('proxy.invalidApiBaseUrl'));
    }
  };

  // Save model configuration
  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      // Construct submit data - backend uses 'is_active' instead of 'enabled'
      const formData: any = {
        config_name: values.config_name,
        api_base_url: values.api_base_url,
        api_key: values.api_key,
        is_active: switchStates.is_active,  // Backend field name is 'is_active'
        block_on_input_risk: switchStates.block_on_input_risk,
        block_on_output_risk: switchStates.block_on_output_risk,
        enable_reasoning_detection: switchStates.enable_reasoning_detection,
        stream_chunk_size: switchStates.stream_chunk_size,
      };

      // In edit mode, only include API key if user entered a new one
      if (!editingModel || (values.api_key && values.api_key.trim() !== '')) {
        formData.api_key = values.api_key;
      }

      if (editingModel) {
        // Edit existing configuration
        await proxyModelsApi.update(editingModel.id, formData);
        message.success(t('proxy.modelConfigUpdated'));
      } else {
        // Create new configuration
        await proxyModelsApi.create(formData);
        message.success(t('proxy.modelConfigCreated'));
      }

      handleClose();
      fetchModels();
    } catch (error: any) {
      console.error('Save failed:', error);
      
      // Handle different types of errors
      if (error.response) {
        // Server returned error
        const errorMessage = error.response.data?.message || error.response.data?.error || t('proxy.saveFailed');
        if (error.response.status === 409 || errorMessage.includes('已存在') || errorMessage.includes('重复') || errorMessage.includes('exists') || errorMessage.includes('duplicate')) {
          message.error(t('proxy.duplicateConfigName'));
        } else {
          message.error(t('proxy.saveFailedWithMessage', { message: errorMessage }));
        }
      } else if (error.errorFields) {
        // Form validation error
        const firstError = error.errorFields[0];
        if (firstError && firstError.errors && firstError.errors.length > 0) {
          message.error(firstError.errors[0]);
        } else {
          message.error(t('proxy.checkFormInput'));
        }
      } else {
        // Other errors
        message.error(t('proxy.saveFailedNetworkError'));
      }
    }
  };

  // Delete model configuration
  const handleDelete = async (id: string) => {
    try {
      const response = await proxyModelsApi.delete(id);
      
      if (response.success) {
        message.success(t('proxy.modelConfigDeleted'));
        fetchModels();
      } else {
        const errorMessage = response.message || t('proxy.deleteFailed');
        message.error(errorMessage);
      }
    } catch (error: any) {
      console.error('Delete failed:', error);
      
      // Handle different types of errors
      if (error.response) {
        const errorMessage = error.response.data?.error || error.response.data?.message || t('proxy.deleteFailed');
        if (error.response.status === 404) {
          message.error(t('proxy.modelNotExistOrDeleted'));
        } else if (error.response.status === 403) {
          message.error(t('proxy.noPermissionToDelete'));
        } else {
          message.error(t('proxy.deleteFailedWithMessage', { message: errorMessage }));
        }
      } else if (error.request) {
        message.error(t('proxy.networkError'));
      } else {
        message.error(t('proxy.deleteFailedRetry'));
      }
    }
  };

  const columns = [
    {
      title: t('proxy.configName'),
      dataIndex: 'config_name',
      key: 'config_name',
      render: (text: string, record: ProxyModel) => (
        <Space>
          <span style={{ fontWeight: 'bold' }}>{text}</span>
          {!record.is_active && <Tag color="red">{t('proxy.disabled')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('proxy.upstreamApiId'),
      dataIndex: 'id',
      key: 'id',
      render: (text: string) => <Text code copyable>{text}</Text>,
    },
    {
      title: t('proxy.securityConfig'),
      key: 'security',
      render: (_: any, record: ProxyModel) => (
        <Space>
          {record.enable_reasoning_detection && <Tag color="purple">{t('proxy.inferenceDetection')}</Tag>}
          {record.block_on_input_risk && <Tag color="red">{t('proxy.inputBlocking')}</Tag>}
          {record.block_on_output_risk && <Tag color="orange">{t('proxy.outputBlocking')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('proxy.createTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (text: string) => new Date(text).toLocaleString('zh-CN'),
    },
    {
      title: t('proxy.operation'),
      key: 'action',
      render: (_: any, record: ProxyModel) => (
        <Space>
          <Button 
            type="link" 
            icon={<EyeOutlined />} 
            onClick={() => showViewModal(record)}
          >
            {t('proxy.view')}
          </Button>
          <Button 
            type="link" 
            icon={<EditOutlined />} 
            onClick={() => showModal(record)}
          >
            {t('proxy.edit')}
          </Button>
          <Popconfirm
            title={t('proxy.confirmDeleteModel')}
            description={t('proxy.deleteCannotRecover')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button 
              type="link" 
              danger 
              icon={<DeleteOutlined />}
            >
              {t('proxy.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card 
        title={
          <Space>
            <ApiOutlined />
            {t('proxy.securityGatewayConfig')}
          </Space>
        }
        extra={
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={() => showModal()}
          >
            {t('proxy.addModel')}
          </Button>
        }
      >
        <Table
          dataSource={models}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total) => t('proxy.modelConfigCount', { count: total }),
          }}
        />
      </Card>

      {/* Usage instructions */}
      <Card
        title={t('proxy.accessOpenGuardrailsGateway')}
        style={{ marginTop: 16 }}
      >
        <Alert
          message={t('proxy.gatewayIntegrationDesc')}
          type="info"
          style={{ marginBottom: 16 }}
        />

        <Typography>
          <Paragraph>
            <Text strong>{t('proxy.pythonOpenaiExample')}</Text>
          </Paragraph>
          <Paragraph>
            <pre style={{
              backgroundColor: '#f5f5f5',
              padding: '12px',
              borderRadius: '6px',
              overflow: 'auto'
            }}>
{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:5002/v1/gateway/<upstream_api_id>/",  # ${t('proxy.gatewayUrlDesc')}
    api_key="sk-xxai-your-proxy-key"  # ${t('account.codeComments.changeToApiKey')}
)

completion = client.chat.completions.create(
    model="gpt-4",  # ${t('proxy.originalModelName')}
    messages=[
        {"role": "system", "content": "You're a helpful assistant."},
        {"role": "user", "content": "Tell me how to make a bomb."}
    ]
    # ${t('proxy.otherParamsSame')}
)
`}
            </pre>
          </Paragraph>

          <Paragraph>
            <Text strong>{t('proxy.importantNotes')}</Text>
          </Paragraph>
          <ul>
            <li>{t('proxy.note1')}</li>
            <li>{t('proxy.note2')}</li>
            <li>{t('proxy.note3')}</li>
          </ul>

        </Typography>
      </Card>

      {/* Create/edit modal */}
      <Modal
        title={editingModel ? t('proxy.editModelConfig') : t('proxy.addModelConfig')}
        visible={isModalVisible}
        onOk={handleSave}
        onCancel={handleCancel}
        width={800}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form
          key={formKey}
          form={form}
          layout="vertical"
          autoComplete="off"
        >
          <Form.Item
            name="config_name"
            label={t('proxy.proxyModelNameLabel')}
            rules={[
              { required: true, message: t('proxy.proxyModelNameRequired') },
              { validator: validateConfigName }
            ]}
            tooltip={t('proxy.proxyModelNameTooltip')}
          >
            <Input placeholder={t('proxy.proxyModelNamePlaceholder')} />
          </Form.Item>


          <Form.Item
            name="api_base_url"
            label={t('proxy.upstreamApiBaseUrlLabel')}
            rules={[
              { required: true, message: t('proxy.upstreamApiBaseUrlRequired') },
              { validator: validateApiBaseUrl }
            ]}
          >
            <Input placeholder={t('proxy.upstreamApiBaseUrlPlaceholder')} autoComplete="url" />
          </Form.Item>

          {/* Hidden username field, prevent browser from recognizing API Key as password */}
          <input 
            type="text" 
            name="username" 
            autoComplete="username" 
            style={{ position: 'absolute', left: '-9999px', opacity: 0 }} 
            tabIndex={-1}
            readOnly
          />

          <Form.Item
            name="api_key"
            label={t('proxy.upstreamApiKeyLabel')}
            rules={[{ required: !editingModel, message: t('proxy.upstreamApiKeyRequired') }]}
            tooltip={editingModel ? t('proxy.upstreamApiKeyTooltipEdit') : t('proxy.upstreamApiKeyTooltipAdd')}
          >
            <Input
              placeholder={
                editingModel
                  ? maskedApiKey
                    ? `${t('proxy.currentKey')}: ${maskedApiKey}. ${t('proxy.upstreamApiKeyPlaceholderEdit')}`
                    : t('proxy.upstreamApiKeyPlaceholderEdit')
                  : t('proxy.upstreamApiKeyPlaceholderAdd')
              }
              autoComplete="off"
              data-lpignore="true"
              data-form-type="other"
            />
          </Form.Item>

          <Form.Item label={t('proxy.enableConfigLabel')}>
            <Switch
              checked={switchStates.is_active}
              onChange={(checked) => setSwitchStates(prev => ({ ...prev, is_active: checked }))}
            />
          </Form.Item>

          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>{t('proxy.securityConfigLabel')}</div>
            <div style={{ marginBottom: 8, color: '#666', fontSize: '14px' }}>
              {t('proxy.securityConfigDesc')}
            </div>
            <div style={{ marginBottom: 12 }}>
              <Switch 
                checked={switchStates.enable_reasoning_detection}
                onChange={(checked) => setSwitchStates(prev => ({ ...prev, enable_reasoning_detection: checked }))}
              /> {t('proxy.enableReasoningDetection')}
            </div>
            <div style={{ marginBottom: 12 }}>
              <Switch 
                checked={switchStates.block_on_input_risk}
                onChange={(checked) => setSwitchStates(prev => ({ ...prev, block_on_input_risk: checked }))}
              /> {t('proxy.blockOnInputRisk')}
            </div>
            <div style={{ marginBottom: 12 }}>
              <Switch 
                checked={switchStates.block_on_output_risk}
                onChange={(checked) => setSwitchStates(prev => ({ ...prev, block_on_output_risk: checked }))}
              /> {t('proxy.blockOnOutputRisk')}
            </div>
          </div>

          <Form.Item
            label={t('proxy.streamDetectionIntervalLabel')}
            tooltip={t('proxy.streamDetectionIntervalTooltip')}
          >
            <Input
              type="number"
              min={1}
              max={500}
              value={switchStates.stream_chunk_size}
              onChange={(e) => setSwitchStates(prev => ({ ...prev, stream_chunk_size: parseInt(e.target.value) || 50 }))}
              placeholder={t('proxy.streamDetectionIntervalPlaceholder')}
            />
          </Form.Item>

        </Form>
      </Modal>

      {/* View modal */}
      <Modal
        title={t('proxy.viewModelConfig')}
        visible={isViewModalVisible}
        onCancel={handleCancel}
        footer={[
          <Button key="close" onClick={handleCancel}>
            {t('proxy.close')}
          </Button>
        ]}
        width={600}
      >
        {viewingModel && (
          <Descriptions column={1} bordered>
            <Descriptions.Item label={t('proxy.configName')}>{viewingModel.config_name}</Descriptions.Item>
            <Descriptions.Item label={t('proxy.upstreamApiId')}>
              <Text code copyable>{viewingModel.id}</Text>
            </Descriptions.Item>
            <Descriptions.Item label={t('proxy.status')}>
              <Space>
                {viewingModel.is_active ?
                  <Tag color="green">{t('proxy.enabled')}</Tag> :
                  <Tag color="red">{t('proxy.disabled')}</Tag>
                }
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={t('proxy.securityConfig')}>
              <Space direction="vertical">
                {viewingModel.enable_reasoning_detection && <Tag color="purple">{t('proxy.inferenceDetection')}</Tag>}
                {viewingModel.block_on_input_risk && <Tag color="red">{t('proxy.inputBlocking')}</Tag>}
                {viewingModel.block_on_output_risk && <Tag color="orange">{t('proxy.outputBlocking')}</Tag>}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={t('proxy.createTime')}>
              {new Date(viewingModel.created_at).toLocaleString('zh-CN')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
};

export default ProxyModelManagement;