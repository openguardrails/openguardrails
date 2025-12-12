import React, { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Switch,
  Space,
  message,
  Tag,
  Select,
  Upload,
  Card,
  Popconfirm,
  Tooltip,
  Row,
  Col,
  Alert,
  InputNumber
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  UploadOutlined,
  SearchOutlined,
  InfoCircleOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { knowledgeBaseApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useApplication } from '../../contexts/ApplicationContext';
import type { KnowledgeBase, SimilarQuestionResult } from '../../types';
import { eventBus, EVENTS } from '../../utils/eventBus';

const { TextArea } = Input;
const { Option } = Select;

const KnowledgeBaseManagement: React.FC = () => {
  const { t } = useTranslation();
  const [data, setData] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<KnowledgeBase | null>(null);
  const [form] = Form.useForm();
  const [fileUploadLoading, setFileUploadLoading] = useState(false);
  const [fileReplaceModalVisible, setFileReplaceModalVisible] = useState(false);
  const [replacingKb, setReplacingKb] = useState<KnowledgeBase | null>(null);
  const [replaceForm] = Form.useForm();
  const [searchModalVisible, setSearchModalVisible] = useState(false);
  const [searchingKb, setSearchingKb] = useState<KnowledgeBase | null>(null);
  const [searchResults, setSearchResults] = useState<SimilarQuestionResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchForm] = Form.useForm();
  const { user, onUserSwitch } = useAuth();
  const { currentApplicationId } = useApplication();

  // Available scanners for knowledge base creation
  const [availableScanners, setAvailableScanners] = useState<{
    blacklists: Array<{ value: string; label: string }>;
    whitelists: Array<{ value: string; label: string }>;
    official_scanners: Array<{ value: string; label: string }>;
    marketplace_scanners: Array<{ value: string; label: string }>;
    custom_scanners: Array<{ value: string; label: string }>;
  }>({
    blacklists: [],
    whitelists: [],
    official_scanners: [],
    marketplace_scanners: [],
    custom_scanners: []
  });

  // Selected scanner type
  const [selectedScannerType, setSelectedScannerType] = useState<string>('official_scanner');

  const categories = [
    { value: 'S1', label: `S1 - ${t('category.S1')}` },
    { value: 'S2', label: `S2 - ${t('category.S2')}` },
    { value: 'S3', label: `S3 - ${t('category.S3')}` },
    { value: 'S4', label: `S4 - ${t('category.S4')}` },
    { value: 'S5', label: `S5 - ${t('category.S5')}` },
    { value: 'S6', label: `S6 - ${t('category.S6')}` },
    { value: 'S7', label: `S7 - ${t('category.S7')}` },
    { value: 'S8', label: `S8 - ${t('category.S8')}` },
    { value: 'S9', label: `S9 - ${t('category.S9')}` },
    { value: 'S10', label: `S10 - ${t('category.S10')}` },
    { value: 'S11', label: `S11 - ${t('category.S11')}` },
    { value: 'S12', label: `S12 - ${t('category.S12')}` },
    { value: 'S13', label: `S13 - ${t('category.S13')}` },
    { value: 'S14', label: `S14 - ${t('category.S14')}` },
    { value: 'S15', label: `S15 - ${t('category.S15')}` },
    { value: 'S16', label: `S16 - ${t('category.S16')}` },
    { value: 'S17', label: `S17 - ${t('category.S17')}` },
    { value: 'S18', label: `S18 - ${t('category.S18')}` },
    { value: 'S19', label: `S19 - ${t('category.S19')}` },
    { value: 'S20', label: `S20 - ${t('category.S20')}` },
    { value: 'S21', label: `S21 - ${t('category.S21')}` },
  ];

  useEffect(() => {
    if (currentApplicationId) {
      fetchData();
      fetchAvailableScanners();
    }
  }, [currentApplicationId]);

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchData();
      fetchAvailableScanners();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  // Listen to scanner events from other components
  useEffect(() => {
    const handleScannerDeleted = (payload: { scannerId: string; scannerTag: string }) => {
      console.log('Scanner deleted event received:', payload);
      // Refresh both available scanners and knowledge base list
      fetchAvailableScanners();
      fetchData();
    };

    const handleScannerCreated = () => {
      console.log('Scanner created event received');
      // Refresh available scanners list
      fetchAvailableScanners();
    };

    const handleScannerUpdated = () => {
      console.log('Scanner updated event received');
      // Refresh available scanners list
      fetchAvailableScanners();
    };

    const handleBlacklistDeleted = (payload: { blacklistId: string; blacklistName: string }) => {
      console.log('Blacklist deleted event received:', payload);
      // Refresh both available scanners and knowledge base list
      fetchAvailableScanners();
      fetchData();
    };

    const handleBlacklistCreated = () => {
      console.log('Blacklist created event received');
      // Refresh available scanners list
      fetchAvailableScanners();
    };

    const handleWhitelistDeleted = (payload: { whitelistId: string; whitelistName: string }) => {
      console.log('Whitelist deleted event received:', payload);
      // Refresh both available scanners and knowledge base list
      fetchAvailableScanners();
      fetchData();
    };

    const handleWhitelistCreated = () => {
      console.log('Whitelist created event received');
      // Refresh available scanners list
      fetchAvailableScanners();
    };

    const handleMarketplaceScannerPurchased = (payload: { packageId: string; packageName: string }) => {
      console.log('Marketplace scanner purchased event received:', payload);
      // Refresh available scanners list
      fetchAvailableScanners();
    };

    // Subscribe to all relevant events
    const unsubscribeScannerDeleted = eventBus.on(EVENTS.SCANNER_DELETED, handleScannerDeleted);
    const unsubscribeScannerCreated = eventBus.on(EVENTS.SCANNER_CREATED, handleScannerCreated);
    const unsubscribeScannerUpdated = eventBus.on(EVENTS.SCANNER_UPDATED, handleScannerUpdated);
    const unsubscribeBlacklistDeleted = eventBus.on(EVENTS.BLACKLIST_DELETED, handleBlacklistDeleted);
    const unsubscribeBlacklistCreated = eventBus.on(EVENTS.BLACKLIST_CREATED, handleBlacklistCreated);
    const unsubscribeWhitelistDeleted = eventBus.on(EVENTS.WHITELIST_DELETED, handleWhitelistDeleted);
    const unsubscribeWhitelistCreated = eventBus.on(EVENTS.WHITELIST_CREATED, handleWhitelistCreated);
    const unsubscribeMarketplaceScannerPurchased = eventBus.on(EVENTS.MARKETPLACE_SCANNER_PURCHASED, handleMarketplaceScannerPurchased);

    // Cleanup subscriptions on unmount
    return () => {
      unsubscribeScannerDeleted();
      unsubscribeScannerCreated();
      unsubscribeScannerUpdated();
      unsubscribeBlacklistDeleted();
      unsubscribeBlacklistCreated();
      unsubscribeWhitelistDeleted();
      unsubscribeWhitelistCreated();
      unsubscribeMarketplaceScannerPurchased();
    };
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const result = await knowledgeBaseApi.list();
      setData(result);
    } catch (error) {
      console.error('Error fetching knowledge bases:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableScanners = async () => {
    try {
      const result = await knowledgeBaseApi.getAvailableScanners();
      setAvailableScanners(result);
    } catch (error) {
      console.error('Error fetching available scanners:', error);
    }
  };

  const handleAdd = async () => {
    setEditingItem(null);
    form.resetFields();
    setSelectedScannerType('official_scanner'); // Reset scanner type to default
    // Refresh available scanners list to get latest blacklists, custom scanners, etc.
    await fetchAvailableScanners();
    setModalVisible(true);
  };

  const handleEdit = (record: KnowledgeBase) => {
    setEditingItem(record);
    form.setFieldsValue({
      category: record.category,
      name: record.name,
      description: record.description,
      similarity_threshold: record.similarity_threshold,
      is_active: record.is_active,
      is_global: record.is_global,
    });
    setModalVisible(true);
  };

  // Strict file content validation
  const validateTextFile = async (file: File): Promise<boolean> => {
    try {      
      const text = await file.text();

      if (!text.trim()) {
        message.error(t('knowledge.emptyFile'));
        return false;
      }

      const lines = text.trim().split('\n').filter(line => line.trim());

      if (lines.length === 0) {
        message.error(t('knowledge.emptyFile'));
        return false;
      }

      // Strictly validate the first few lines (up to 5 lines)
      const linesToCheck = Math.min(5, lines.length);
      let validLines = 0;
      
      for (let i = 0; i < linesToCheck; i++) {
        const line = lines[i].trim();
        
        // Check if it is a JSON format
        if (!line.startsWith('{') || !line.endsWith('}')) {
          message.error(t('knowledge.formatError', { line: i + 1, error: t('knowledge.invalidJSON') }));
          return false;
        }

        try {
          const jsonObj = JSON.parse(line);

          // Check required fields
          if (!jsonObj.questionid || !jsonObj.question || !jsonObj.answer) {
            message.error(t('knowledge.missingFields', { line: i + 1 }));
            return false;
          }

          // Check field types
          if (typeof jsonObj.questionid !== 'string' ||
              typeof jsonObj.question !== 'string' ||
              typeof jsonObj.answer !== 'string') {
            message.error(t('knowledge.invalidFieldType', { line: i + 1 }));
            return false;
          }

          // Check content is not empty
          if (!jsonObj.question.trim() || !jsonObj.answer.trim()) {
            message.error(t('knowledge.emptyContent', { line: i + 1 }));
            return false;
          }

          validLines++;
        } catch (parseError: any) {
          message.error(t('knowledge.parseError', { line: i + 1, error: parseError.message }));
          return false;
        }
      }

      if (validLines === 0) {
        message.error(t('knowledge.noValidPairs'));
        return false;
      }

      message.success(t('knowledge.validationSuccess', { count: validLines }));
      return true;
    } catch (error) {
      message.error(t('knowledge.readFileFailed'));
      return false;
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingItem) {
        await knowledgeBaseApi.update(editingItem.id, values);
        message.success(t('common.updateSuccess'));
      } else {
        // Creating a knowledge base requires file upload
        if (!values.file || values.file.length === 0) {
          message.error(t('knowledge.selectFile'));
          return;
        }

        const file = values.file[0].originFileObj;

        // Validate file content
        const isValid = await validateTextFile(file);
        if (!isValid) {
          return;
        }

        const formData = new FormData();
        formData.append('file', file);

        // Support both old (category) and new (scanner_type + scanner_identifier) formats
        if (values.scanner_type && values.scanner_identifier) {
          formData.append('scanner_type', values.scanner_type);
          formData.append('scanner_identifier', values.scanner_identifier);
        } else if (values.category) {
          // Legacy format - will be converted to scanner_type=official_scanner in backend
          formData.append('category', values.category);
        }

        formData.append('name', values.name);
        formData.append('description', values.description || '');
        formData.append('similarity_threshold', values.similarity_threshold?.toString() || '0.7');
        formData.append('is_active', values.is_active ? 'true' : 'false');
        formData.append('is_global', values.is_global ? 'true' : 'false');

        setFileUploadLoading(true);
        await knowledgeBaseApi.create(formData);
        message.success(t('knowledge.uploadSuccess'));
      }

      setModalVisible(false);
      setSelectedScannerType('official_scanner'); // Reset scanner type after successful submission
      fetchData();
    } catch (error: any) {
      console.error('Error saving knowledge base:', error);
      message.error(error.response?.data?.detail || t('common.saveFailed'));
    } finally {
      setFileUploadLoading(false);
    }
  };

  const handleDelete = async (record: KnowledgeBase) => {
    try {
      await knowledgeBaseApi.delete(record.id);
      message.success(t('knowledge.deleteSuccess'));
      fetchData();
    } catch (error) {
      console.error('Error deleting knowledge base:', error);
      message.error(t('knowledge.deleteFailed'));
    }
  };

  const handleToggleDisable = async (record: KnowledgeBase) => {
    try {
      await knowledgeBaseApi.toggleDisable(record.id);
      const action = record.is_disabled_by_me ? 'enabled' : 'disabled';
      message.success(t(`knowledge.${action}Success`) || `Global knowledge base ${action} successfully`);
      fetchData();
    } catch (error: any) {
      console.error('Error toggling knowledge base disable:', error);
      message.error(error.response?.data?.detail || t('knowledge.toggleFailed') || 'Failed to toggle knowledge base');
    }
  };

  const handleReplaceFile = (record: KnowledgeBase) => {
    setReplacingKb(record);
    replaceForm.resetFields();
    setFileReplaceModalVisible(true);
  };

  const handleFileReplace = async (values: any) => {
    if (!replacingKb || !values.file || values.file.length === 0) {
      message.error(t('knowledge.selectFile'));
      return;
    }

    const file = values.file[0].originFileObj;
    
    // Validate file content
    const isValid = await validateTextFile(file);
    if (!isValid) {
      return;
    }

    try {
      setFileUploadLoading(true);
      await knowledgeBaseApi.replaceFile(replacingKb.id, file);
      message.success(t('knowledge.replaceSuccess'));
      setFileReplaceModalVisible(false);
      fetchData();
    } catch (error: any) {
      console.error('Error replacing file:', error);
      message.error(error.response?.data?.detail || t('knowledge.replaceFailed'));
    } finally {
      setFileUploadLoading(false);
    }
  };

  const handleSearch = (record: KnowledgeBase) => {
    setSearchingKb(record);
    setSearchResults([]);
    searchForm.resetFields();
    setSearchModalVisible(true);
  };

  const handleSearchQuery = async (values: any) => {
    if (!searchingKb || !values.query.trim()) {
      message.error(t('knowledge.enterSearchContent'));
      return;
    }

    try {
      setSearchLoading(true);
      const results = await knowledgeBaseApi.search(searchingKb.id, values.query.trim(), 5);
      setSearchResults(results);
      if (results.length === 0) {
        message.info(t('knowledge.noSimilarQuestions'));
      }
    } catch (error: any) {
      console.error('Error searching knowledge base:', error);
      message.error(error.response?.data?.detail || t('knowledge.searchFailed'));
    } finally {
      setSearchLoading(false);
    }
  };

  const getCategoryLabel = (kb: KnowledgeBase) => {
    // Handle new scanner type format
    if (kb.scanner_type) {
      switch (kb.scanner_type) {
        case 'blacklist':
          // Show blacklist name
          return kb.scanner_identifier
            ? `${t('config.blacklist')} - ${kb.scanner_identifier}`
            : (t('config.blacklist') || 'Blacklist');
        case 'whitelist':
          // Show whitelist name
          return kb.scanner_identifier
            ? `${t('config.whitelist')} - ${kb.scanner_identifier}`
            : (t('config.whitelist') || 'Whitelist');
        case 'official_scanner':
          // For official scanners (S1-S21 and custom official S100+)
          if (kb.scanner_identifier) {
            const item = categories.find(c => c.value === kb.scanner_identifier);
            if (item) {
              return item.label;  // S1-S21: return full label like "S1 - General Political Topics"
            }
            // For S100+ official scanners, show "tag - name" format
            if (kb.scanner_name) {
              return `${kb.scanner_identifier} - ${kb.scanner_name}`;
            }
            // Fallback to just the tag
            return kb.scanner_identifier;
          }
          return t('scannerPackages.builtinPackages') || 'Built-in Scanner';
        case 'marketplace_scanner':
          // For marketplace scanners, show "tag - name" format
          if (kb.scanner_identifier && kb.scanner_name) {
            return `${kb.scanner_identifier} - ${kb.scanner_name}`;
          }
          return kb.scanner_identifier || (t('scannerPackages.purchasedPackages') || 'Premium Scanner');
        case 'custom_scanner':
          // For custom scanners, show "tag - name" format
          if (kb.scanner_identifier && kb.scanner_name) {
            return `${kb.scanner_identifier} - ${kb.scanner_name}`;
          }
          return kb.scanner_identifier || (t('customScanners.title') || 'Custom Scanner');
        default:
          return kb.scanner_type;
      }
    }

    // Fallback to legacy category field
    if (kb.category) {
      const item = categories.find(c => c.value === kb.category);
      return item?.label || kb.category;
    }

    return '-';
  };

  const getFileName = (filePath: string) => {
    if (!filePath) return '-';
    // Extract file name from file path
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1];
    // Remove knowledge base ID prefix (kb_123_filename.jsonl -> filename.jsonl)
    const match = fileName.match(/^kb_\d+_(.+)$/);
    return match ? match[1] : fileName;
  };


  const columns = [
    {
      title: t('results.category'),
      dataIndex: 'category',
      key: 'category',
      width: 160,
      render: (_: any, record: KnowledgeBase) => (
        <Tag color="blue">
          {getCategoryLabel(record)}
        </Tag>
      ),
    },
    {
      title: t('knowledge.knowledgeBaseName'),
      dataIndex: 'name',
      key: 'name',
      width: 120,
      ellipsis: true,
    },
    {
      title: t('common.description'),
      dataIndex: 'description',
      key: 'description',
      width: 150,
      ellipsis: true,
      render: (text: string) => text || '-',
    },
    {
      title: t('knowledge.fileName'),
      dataIndex: 'file_path',
      key: 'file_name',
      width: 150,
      ellipsis: true,
      render: (filePath: string) => (
        <Tooltip title={getFileName(filePath)}>
          {getFileName(filePath)}
        </Tooltip>
      ),
    },
    {
      title: t('knowledge.qaPairsCount'),
      dataIndex: 'total_qa_pairs',
      key: 'total_qa_pairs',
      width: 100,
      align: 'center' as const,
      render: (count: number) => (
        <Tag color="green">{count}</Tag>
      ),
    },
    {
      title: t('knowledge.similarityThreshold'),
      dataIndex: 'similarity_threshold',
      key: 'similarity_threshold',
      width: 120,
      align: 'center' as const,
      render: (threshold: number) => (
        <Tag color="blue">{(threshold * 100).toFixed(0)}%</Tag>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      align: 'center' as const,
      render: (active: boolean, record: KnowledgeBase) => {
        // For global KB, if disabled by current user, show as disabled
        if (record.is_global && record.is_disabled_by_me) {
          return (
            <Tooltip title={t('knowledge.disabledByYou') || 'Disabled by you'}>
              <Tag color="orange">{t('common.disabled')}</Tag>
            </Tooltip>
          );
        }
        return (
          <Tag color={active ? 'green' : 'red'}>
            {active ? t('common.enabled') : t('common.disabled')}
          </Tag>
        );
      },
    },
    {
      title: t('entityType.sourceColumn'),
      dataIndex: 'is_global',
      key: 'is_global',
      width: 100,
      align: 'center' as const,
      render: (isGlobal: boolean) => (
        <Tag color={isGlobal ? 'blue' : 'default'}>
          {isGlobal ? t('entityType.system') : t('entityType.custom')}
        </Tag>
      ),
    },
    {
      title: t('common.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (time: string) => new Date(time).toLocaleString(),
    },
    {
      title: t('common.operation'),
      key: 'action',
      width: 400,
      fixed: 'right' as const,
      render: (_: any, record: KnowledgeBase) => (
        <Space size="small" wrap>
          {/* Show edit buttons for user's own knowledge bases or for admins on global knowledge bases */}
          {(!record.is_global || user?.is_super_admin) && (
            <>
              <Tooltip title={t('knowledge.editBasicInfo')}>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => handleEdit(record)}
                >
                  {t('common.edit')}
                </Button>
              </Tooltip>
              <Tooltip title={t('knowledge.replaceKBFile')}>
                <Button
                  type="link"
                  size="small"
                  icon={<UploadOutlined />}
                  onClick={() => handleReplaceFile(record)}
                >
                  {t('knowledge.replaceFile')}
                </Button>
              </Tooltip>
            </>
          )}
          <Tooltip title={t('knowledge.searchTest')}>
            <Button
              type="link"
              size="small"
              icon={<SearchOutlined />}
              onClick={() => handleSearch(record)}
            >
              {t('knowledge.searchTest')}
            </Button>
          </Tooltip>
          {record.is_global ? (
            <>
              {/* For global knowledge bases, show enable/disable for all users */}
              <Button
                type="link"
                size="small"
                onClick={() => handleToggleDisable(record)}
              >
                {record.is_disabled_by_me ? t('common.enable') : t('common.disable')}
              </Button>
              {/* Show delete button only for administrators */}
              {user?.is_super_admin && (
                <Popconfirm
                  title={t('knowledge.deleteConfirmKB', { name: record.name })}
                  onConfirm={() => handleDelete(record)}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                >
                  <Button
                    type="link"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                  >
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              )}
            </>
          ) : (
            /* For user's own knowledge bases, show delete button */
            <Popconfirm
              title={t('knowledge.deleteConfirmKB', { name: record.name })}
              onConfirm={() => handleDelete(record)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button
                type="link"
                danger
                size="small"
                icon={<DeleteOutlined />}
              >
                {t('common.delete')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Row justify="space-between" align="middle">
            <Col>
              <h3>{t('knowledge.knowledgeBaseManagement')}</h3>
              <p style={{ color: '#666', margin: 0 }}>
                {t('knowledge.knowledgeBaseDescription')}
              </p>
            </Col>
            <Col>
              <Space>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={async () => {
                    await fetchAvailableScanners();
                    await fetchData();
                  }}
                  loading={loading}
                >
                  {t('common.refresh')}
                </Button>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={handleAdd}
                >
                  {t('knowledge.addKnowledgeBase')}
                </Button>
              </Space>
            </Col>
          </Row>
        </div>

        <Alert
          message={t('knowledge.fileFormatDescription')}
          description={
            <div>
              <p>{t('knowledge.fileFormatDetails')}</p>
              <pre style={{ backgroundColor: '#f5f5f5', padding: '8px', borderRadius: '4px' }}>
{`{"questionid": "Unique question ID", "question": "Question content", "answer": "Answer content"}`}
              </pre>
              <p style={{ margin: 0 }}>
                <InfoCircleOutlined style={{ color: '#1890ff' }} />
                {t('knowledge.fileFormatNote')}
              </p>
            </div>
          }
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1500 }}
        />
      </Card>

      {/* Add/edit knowledge base modal */}
      <Modal
        title={editingItem ? t('knowledge.editKnowledgeBase') : t('knowledge.addKnowledgeBase')}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          setSelectedScannerType('official_scanner'); // Reset scanner type when modal is closed
        }}
        onOk={() => form.submit()}
        width={600}
        confirmLoading={fileUploadLoading}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
        >
          <Form.Item
            name="scanner_type"
            label={t('knowledge.scannerType') || 'Scanner Type'}
            rules={[{ required: !editingItem, message: t('knowledge.selectScannerType') || 'Please select scanner type' }]}
            initialValue="official_scanner"
          >
            <Select
              placeholder={t('knowledge.selectScannerTypePlaceholder') || 'Select scanner type'}
              onChange={(value) => {
                setSelectedScannerType(value);
                form.setFieldValue('scanner_identifier', undefined);
              }}
              disabled={!!editingItem}
            >
              <Option value="official_scanner">{t('scannerPackages.builtinPackages') || 'Basic Package'}</Option>
              <Option value="marketplace_scanner">{t('scannerPackages.purchasedPackages') || 'Premium Package'}</Option>
              <Option value="custom_scanner">{t('customScanners.title') || 'Custom Scanners'}</Option>
              <Option value="blacklist">{t('config.blacklist') || 'Blacklist'}</Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="scanner_identifier"
            label={t('knowledge.scanner') || 'Scanner'}
            rules={[{ required: !editingItem, message: t('knowledge.selectScanner') || 'Please select scanner' }]}
          >
            <Select
              placeholder={t('knowledge.selectScannerPlaceholder') || 'Select scanner'}
              disabled={!!editingItem}
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            >
              {selectedScannerType === 'official_scanner' &&
                availableScanners.official_scanners.map(scanner => (
                  <Option key={scanner.value} value={scanner.value} label={scanner.label}>
                    {scanner.label}
                  </Option>
                ))}
              {selectedScannerType === 'blacklist' &&
                availableScanners.blacklists.map(scanner => (
                  <Option key={scanner.value} value={scanner.value} label={scanner.label}>
                    {scanner.label}
                  </Option>
                ))}
              {selectedScannerType === 'marketplace_scanner' &&
                availableScanners.marketplace_scanners.map(scanner => (
                  <Option key={scanner.value} value={scanner.value} label={scanner.label}>
                    {scanner.label}
                  </Option>
                ))}
              {selectedScannerType === 'custom_scanner' &&
                availableScanners.custom_scanners.map(scanner => (
                  <Option key={scanner.value} value={scanner.value} label={scanner.label}>
                    {scanner.label}
                  </Option>
                ))}
            </Select>
          </Form.Item>
          
          {/* Show alert when marketplace scanner type is selected but no scanners available */}
          {selectedScannerType === 'marketplace_scanner' && availableScanners.marketplace_scanners.length === 0 && (
            <Alert
              message={t('knowledge.noPurchasedScannersTitle') || 'No Purchased Premium Scanners'}
              description={
                <span>
                  {t('knowledge.noPurchasedScannersDescription') || 'You haven\'t purchased any premium scanner packages yet. '}
                  <a href="/platform/config/official-scanners#marketplace" target="_blank" rel="noopener noreferrer">
                    {t('knowledge.goToMarketplace') || 'Go to Marketplace'}
                  </a>
                  {t('knowledge.toBrowseAndPurchase') || ' to browse and purchase scanner packages.'}
                </span>
              }
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item
            name="name"
            label={t('knowledge.knowledgeBaseName')}
            rules={[{ required: true, message: t('knowledge.knowledgeBaseNameRequired') }]}
          >
            <Input placeholder={t('knowledge.knowledgeBaseNamePlaceholder')} />
          </Form.Item>

          <Form.Item
            name="description"
            label={t('common.description')}
          >
            <TextArea
              rows={3}
              placeholder={t('knowledge.descriptionPlaceholder')}
            />
          </Form.Item>

          <Form.Item
            name="similarity_threshold"
            label={
              <span>
                {t('knowledge.similarityThreshold')}
                <Tooltip title={t('knowledge.similarityThresholdTooltip')}>
                  <InfoCircleOutlined style={{ marginLeft: 4 }} />
                </Tooltip>
              </span>
            }
            initialValue={0.7}
            rules={[
              { required: true, message: t('knowledge.similarityThresholdRequired') },
              { type: 'number', min: 0, max: 1, message: t('knowledge.similarityThresholdRange') }
            ]}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              placeholder={t('knowledge.similarityThresholdPlaceholder')}
            />
          </Form.Item>

          {!editingItem && (
            <Form.Item
              name="file"
              label={t('knowledge.file')}
              rules={[{ required: true, message: t('knowledge.selectFile') }]}
              valuePropName="fileList"
              getValueFromEvent={(e) => {
                if (Array.isArray(e)) {
                  return e;
                }
                return e && e.fileList;
              }}
            >
              <Upload
                beforeUpload={() => false}
                accept="*"
                maxCount={1}
                showUploadList={{
                  showPreviewIcon: false,
                  showRemoveIcon: true,
                  showDownloadIcon: false
                }}
              >
                <Button icon={<UploadOutlined />}>{t('knowledge.chooseFile')}</Button>
              </Upload>
            </Form.Item>
          )}

          <Form.Item
            name="is_active"
            label={t('knowledge.enableStatus')}
            valuePropName="checked"
            initialValue={true}
          >
            <Switch />
          </Form.Item>

          {user?.is_super_admin && (
            <Form.Item
              name="is_global"
              label={
                <span>
                  {t('knowledge.globalKnowledgeBase')}
                  <Tooltip title={t('knowledge.globalKnowledgeBaseTooltip')}>
                    <InfoCircleOutlined style={{ marginLeft: 4 }} />
                  </Tooltip>
                </span>
              }
              valuePropName="checked"
              initialValue={false}
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* Replace file modal */}
      <Modal
        title={t('knowledge.replaceFileTitle', { name: replacingKb?.name })}
        open={fileReplaceModalVisible}
        onCancel={() => {
          setFileReplaceModalVisible(false);
          replaceForm.resetFields();
        }}
        onOk={() => replaceForm.submit()}
        confirmLoading={fileUploadLoading}
      >
        <Alert
          message={t('knowledge.attention')}
          description={t('knowledge.replaceFileWarning')}
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Form
          form={replaceForm}
          onFinish={handleFileReplace}
        >
          <Form.Item
            name="file"
            label={t('knowledge.selectNewFile')}
            rules={[{ required: true, message: t('knowledge.selectFile') }]}
            valuePropName="fileList"
            getValueFromEvent={(e) => {
              if (Array.isArray(e)) {
                return e;
              }
              return e && e.fileList;
            }}
          >
            <Upload
              beforeUpload={() => false}
              accept="*"
              maxCount={1}
              showUploadList={{
                showPreviewIcon: false,
                showRemoveIcon: true,
                showDownloadIcon: false
              }}
            >
              <Button icon={<UploadOutlined />}>{t('knowledge.chooseFile')}</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      {/* Search test modal */}
      <Modal
        title={t('knowledge.searchTestTitle', { name: searchingKb?.name })}
        open={searchModalVisible}
        onCancel={() => {
          setSearchModalVisible(false);
          searchForm.resetFields();
          setSearchResults([]);
        }}
        footer={null}
        width={800}
      >
        <Form 
          form={searchForm}
          onFinish={handleSearchQuery} 
          layout="inline" 
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            name="query"
            style={{ flex: 1 }}
            rules={[{ required: true, message: t('knowledge.searchContent') }]}
          >
            <Input placeholder={t('knowledge.searchPlaceholder')} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={searchLoading}>
              {t('common.search')}
            </Button>
          </Form.Item>
        </Form>

        {searchResults.length > 0 && (
          <div>
            <h4>{t('knowledge.searchResults')}</h4>
            {searchResults.map((result, index) => (
              <Card key={index} size="small" style={{ marginBottom: 8 }}>
                <div>
                  <div style={{ marginBottom: 8 }}>
                    <Tag color="blue">{t('knowledge.similarity', { score: (result.similarity_score * 100).toFixed(1) })}</Tag>
                    <Tag color="green">{t('knowledge.rank', { rank: result.rank })}</Tag>
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <strong>{t('knowledge.questionLabel')}</strong>{result.question}
                  </div>
                  <div>
                    <strong>{t('knowledge.answerLabel')}</strong>{result.answer}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default KnowledgeBaseManagement;