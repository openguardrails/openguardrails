import React, { useEffect, useState, useMemo } from 'react';
import { Table, Button, Modal, Form, Input, message, Tag, Select } from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { configApi, knowledgeBaseApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useApplication } from '../../contexts/ApplicationContext';
import type { ResponseTemplate } from '../../types';
import { eventBus, EVENTS } from '../../utils/eventBus';

const { TextArea } = Input;
const { Option } = Select;

const ResponseTemplateManagement: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<ResponseTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<ResponseTemplate | null>(null);
  const [form] = Form.useForm();
  const { onUserSwitch } = useAuth();
  const { currentApplicationId } = useApplication();
  const [currentLang, setCurrentLang] = useState(i18n.language || 'en');

  // Available scanners for template creation
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

  const getRiskLevelLabel = (riskLevel: string) => {
    const riskLevelMap: { [key: string]: string } = {
      // English values (current format)
      'high_risk': t('risk.level.high_risk'),
      'medium_risk': t('risk.level.medium_risk'),
      'low_risk': t('risk.level.low_risk'),
      'no_risk': t('risk.level.no_risk'),
      // Chinese values (legacy format)
      '高风险': t('risk.level.high_risk'),
      '中风险': t('risk.level.medium_risk'),
      '低风险': t('risk.level.low_risk'),
      '无风险': t('risk.level.no_risk'),
    };
    return riskLevelMap[riskLevel] || riskLevel;
  };

  const categories = [
    { value: 'S2', label: `S2 - ${t('category.S2')}`, riskLevel: 'high_risk' },
    { value: 'S3', label: `S3 - ${t('category.S3')}`, riskLevel: 'high_risk' },
    { value: 'S5', label: `S5 - ${t('category.S5')}`, riskLevel: 'high_risk' },
    { value: 'S9', label: `S9 - ${t('category.S9')}`, riskLevel: 'high_risk' },
    { value: 'S15', label: `S15 - ${t('category.S15')}`, riskLevel: 'high_risk' },
    { value: 'S17', label: `S17 - ${t('category.S17')}`, riskLevel: 'high_risk' },
    { value: 'S4', label: `S4 - ${t('category.S4')}`, riskLevel: 'medium_risk' },
    { value: 'S6', label: `S6 - ${t('category.S6')}`, riskLevel: 'medium_risk' },
    { value: 'S7', label: `S7 - ${t('category.S7')}`, riskLevel: 'medium_risk' },
    { value: 'S16', label: `S16 - ${t('category.S16')}`, riskLevel: 'medium_risk' },
    { value: 'S1', label: `S1 - ${t('category.S1')}`, riskLevel: 'low_risk' },
    { value: 'S8', label: `S8 - ${t('category.S8')}`, riskLevel: 'low_risk' },
    { value: 'S10', label: `S10 - ${t('category.S10')}`, riskLevel: 'low_risk' },
    { value: 'S11', label: `S11 - ${t('category.S11')}`, riskLevel: 'low_risk' },
    { value: 'S12', label: `S12 - ${t('category.S12')}`, riskLevel: 'low_risk' },
    { value: 'S13', label: `S13 - ${t('category.S13')}`, riskLevel: 'low_risk' },
    { value: 'S14', label: `S14 - ${t('category.S14')}`, riskLevel: 'low_risk' },
    { value: 'S18', label: `S18 - ${t('category.S18')}`, riskLevel: 'low_risk' },
    { value: 'S19', label: `S19 - ${t('category.S19')}`, riskLevel: 'low_risk' },
    { value: 'S20', label: `S20 - ${t('category.S20')}`, riskLevel: 'low_risk' },
    { value: 'S21', label: `S21 - ${t('category.S21')}`, riskLevel: 'low_risk' },
    { value: 'default', label: t('template.defaultReject'), riskLevel: 'no_risk' },
  ];

  useEffect(() => {
    if (currentApplicationId) {
      loadAllData();
    }
  }, [currentApplicationId]);

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadAllData();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  // Listen to scanner events from other components
  useEffect(() => {
    const handleScannerDeleted = (payload: { scannerId: string; scannerTag: string }) => {
      console.log('Scanner deleted event received in ResponseTemplateManagement:', payload);
      // Refresh both available scanners and response templates list
      loadAllData();
    };

    const handleScannerCreated = () => {
      console.log('Scanner created event received in ResponseTemplateManagement');
      // Refresh available scanners list
      loadAllData();
    };

    const handleScannerUpdated = () => {
      console.log('Scanner updated event received in ResponseTemplateManagement');
      // Refresh available scanners list
      loadAllData();
    };

    const handleBlacklistDeleted = (payload: { blacklistId: string; blacklistName: string }) => {
      console.log('Blacklist deleted event received in ResponseTemplateManagement:', payload);
      // Refresh both available scanners and response templates list
      loadAllData();
    };

    const handleBlacklistCreated = () => {
      console.log('Blacklist created event received in ResponseTemplateManagement');
      // Refresh available scanners list
      loadAllData();
    };

    const handleWhitelistDeleted = (payload: { whitelistId: string; whitelistName: string }) => {
      console.log('Whitelist deleted event received in ResponseTemplateManagement:', payload);
      // Refresh both available scanners and response templates list
      loadAllData();
    };

    const handleWhitelistCreated = () => {
      console.log('Whitelist created event received in ResponseTemplateManagement');
      // Refresh available scanners list
      loadAllData();
    };

    const handleMarketplaceScannerPurchased = (payload: { packageId: string; packageName: string }) => {
      console.log('Marketplace scanner purchased event received in ResponseTemplateManagement:', payload);
      // Refresh available scanners list
      loadAllData();
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

  const loadAllData = async () => {
    // First fetch available scanners, then fetch and create templates
    await fetchAvailableScanners();
    await fetchData();
  };

  const fetchAvailableScanners = async () => {
    try {
      const result = await knowledgeBaseApi.getAvailableScanners();
      setAvailableScanners(result);
    } catch (error) {
      console.error('Error fetching available scanners:', error);
    }
  };

  // Listen to language change events to update currentLang state
  useEffect(() => {
    const handleLanguageChange = (lng: string) => {
      setCurrentLang(lng);
    };

    i18n.on('languageChanged', handleLanguageChange);

    return () => {
      i18n.off('languageChanged', handleLanguageChange);
    };
  }, [i18n]);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Simply fetch and display existing templates
      // No automatic creation - templates are created when scanners/blacklists are created
      const result = await configApi.responses.list();
      setData(result);
    } catch (error) {
      console.error('Error fetching response templates:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (record: ResponseTemplate) => {
    setEditingItem(record);

    // Get current language
    const currentLang = i18n.language || 'en';
    let currentContent = '';

    if (typeof record.template_content === 'string') {
      // Old format: single string
      currentContent = record.template_content;
    } else if (typeof record.template_content === 'object') {
      // New format: JSON object with language keys
      currentContent = record.template_content[currentLang] || '';
    }

    form.setFieldsValue({
      category: record.category,
      template_content: currentContent
    });
    setModalVisible(true);
  };


  const handleSubmit = async (values: any) => {
    try {
      if (!editingItem) {
        message.error(t('template.invalidOperation'));
        return;
      }

      // Get current language
      const currentLang = i18n.language || 'en';

      // Preserve existing content from other languages
      const existingContent = typeof editingItem.template_content === 'object'
        ? { ...editingItem.template_content }
        : {};

      // Update only the current language content
      const multilingualContent: Record<string, string> = {
        ...existingContent,
        [currentLang]: values.template_content
      };

      // Validate that content is provided
      if (!values.template_content || !values.template_content.trim()) {
        message.error(t('template.contentRequired'));
        return;
      }

      // Update reject content, keep the original category and risk level
      const submissionData = {
        category: editingItem.category,
        risk_level: editingItem.risk_level,
        template_content: multilingualContent,
        is_default: true,
        is_active: true
      };

      await configApi.responses.update(editingItem.id, submissionData);
      message.success(t('template.updateSuccess'));

      setModalVisible(false);
      fetchData();
    } catch (error) {
      console.error('Error updating reject response:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const getCategoryLabel = (category: string) => {
    const item = categories.find(c => c.value === category);
    return item?.label || category;
  };

  // Use useMemo to ensure columns re-render when language changes
  const columns = useMemo(() => [
    {
      title: t('template.riskCategory'),
      dataIndex: 'category',
      key: 'category',
      render: (category: string, record: ResponseTemplate) => {
        // If scanner_type is blacklist, show blacklist name
        if (record.scanner_type === 'blacklist' && record.scanner_identifier) {
          return (
            <Tag color="purple">
              {t('config.blacklist')} - {record.scanner_identifier}
            </Tag>
          );
        }
        // If scanner_type is whitelist, show whitelist name
        if (record.scanner_type === 'whitelist' && record.scanner_identifier) {
          return (
            <Tag color="green">
              {t('config.whitelist')} - {record.scanner_identifier}
            </Tag>
          );
        }
        // If scanner_type is custom_scanner, show "tag - name"
        if (record.scanner_type === 'custom_scanner' && record.scanner_identifier) {
          const displayText = record.scanner_name
            ? `${record.scanner_identifier} - ${record.scanner_name}`
            : record.scanner_identifier;
          return (
            <Tag color="cyan">
              {displayText}
            </Tag>
          );
        }
        // If scanner_type is official_scanner or marketplace_scanner, show "tag - name"
        if ((record.scanner_type === 'official_scanner' || record.scanner_type === 'marketplace_scanner') && record.scanner_identifier) {
          const displayText = record.scanner_name
            ? `${record.scanner_identifier} - ${record.scanner_name}`
            : record.scanner_identifier;
          return (
            <Tag color="blue">
              {displayText}
            </Tag>
          );
        }
        // Otherwise show standard category
        return (
          <Tag color={category === 'default' ? 'blue' : 'orange'}>
            {getCategoryLabel(category)}
          </Tag>
        );
      },
    },
    {
      title: t('results.riskLevel'),
      dataIndex: 'risk_level',
      key: 'risk_level',
      render: (riskLevel: string) => {
        // Use the risk_level directly from the record instead of looking up by category
        // This ensures blacklist and custom scanners show correct risk level
        const actualRiskLevel = riskLevel || 'no_risk';

        const getColor = (riskLevel: string) => {
          if (riskLevel === 'high_risk' || riskLevel === '高风险') return 'red';
          if (riskLevel === 'medium_risk' || riskLevel === '中风险') return 'orange';
          if (riskLevel === 'low_risk' || riskLevel === '低风险') return 'yellow';
          return 'green';
        };

        return (
          <Tag color={getColor(actualRiskLevel)}>
            {getRiskLevelLabel(actualRiskLevel)}
          </Tag>
        );
      },
    },
    {
      title: t('template.rejectContent'),
      dataIndex: 'template_content',
      key: 'template_content',
      ellipsis: true,
      width: 400,
      render: (content: any, record: ResponseTemplate) => {
        let displayText = '';

        if (typeof content === 'string') {
          displayText = content;
        } else if (typeof content === 'object') {
          // Display only the current language content
          // Use currentLang from component scope to ensure reactivity
          const displayContent = content[currentLang];

          if (displayContent) {
            displayText = displayContent;
          } else {
            // Show placeholder when content doesn't exist for current language
            const availableLangs = Object.keys(content);
            if (availableLangs.length > 0) {
              return (
                <span style={{ color: '#999', fontStyle: 'italic' }}>
                  {t('template.noContentForLanguage', {
                    language: currentLang === 'zh' ? '中文' : 'English'
                  })} ({t('template.clickEditToAdd')})
                </span>
              );
            }
            return '';
          }
        }

        // Replace {scanner_name} placeholder with actual scanner name (not tag)
        if (displayText) {
          if (record.scanner_type === 'blacklist' || record.scanner_type === 'whitelist') {
            // For blacklist/whitelist, use scanner_identifier (which is the list name)
            displayText = displayText.replace(/{scanner_name}/g, record.scanner_identifier || '');
          } else if (record.scanner_name) {
            // For custom/marketplace scanners, use scanner_name (not tag)
            displayText = displayText.replace(/{scanner_name}/g, record.scanner_name);
          } else if (record.scanner_identifier) {
            // Fallback to scanner_identifier if scanner_name is not available
            displayText = displayText.replace(/{scanner_name}/g, record.scanner_identifier);
          }
        }

        return displayText || '';
      }
    },
    {
      title: t('common.updatedAt'),
      dataIndex: 'updated_at',
      key: 'updated_at',
      render: (time: string) => new Date(time).toLocaleString(),
    },
    {
      title: t('common.operation'),
      key: 'action',
      render: (_: any, record: ResponseTemplate) => (
        <Button
          type="link"
          icon={<EditOutlined />}
          onClick={() => handleEdit(record)}
        >
          {t('template.editRejectContent')}
        </Button>
      ),
    },
  ], [currentLang, t]);

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3>{t('template.rejectAnswerLibrary')}</h3>
          <p style={{ color: '#666', marginBottom: 16 }}>
            {t('template.rejectAnswerDescription')}
          </p>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={loadAllData}
          loading={loading}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={false}
      />

      <Modal
        title={t('template.editRejectContent')}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
        >
          <Form.Item
            name="category"
            label={t('template.riskCategory')}
          >
            <Select disabled>
              {categories.map(category => (
                <Option key={category.value} value={category.value}>
                  {category.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="template_content"
            label={t('template.rejectContent')}
            rules={[{ required: true, message: t('template.contentRequired') }]}
            extra={
              <div style={{ color: '#666', fontSize: '12px', marginTop: '8px' }}>
                {t('template.editLanguageHint', {
                  language: i18n.language === 'zh' ? '中文' : 'English'
                })}
              </div>
            }
          >
            <TextArea
              rows={6}
              placeholder={
                i18n.language === 'zh'
                  ? t('template.rejectContentPlaceholderZh')
                  : t('template.rejectContentPlaceholderEn')
              }
              showCount
              maxLength={500}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ResponseTemplateManagement;