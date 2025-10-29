import React, { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, message, Tag, Select } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { configApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import type { ResponseTemplate } from '../../types';

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
    { value: 'S1', label: `S1 - ${t('category.S1')}`, riskLevel: 'medium_risk' },
    { value: 'S2', label: `S2 - ${t('category.S2')}`, riskLevel: 'high_risk' },
    { value: 'S3', label: `S3 - ${t('category.S3')}`, riskLevel: 'high_risk' },
    { value: 'S4', label: `S4 - ${t('category.S4')}`, riskLevel: 'medium_risk' },
    { value: 'S5', label: `S5 - ${t('category.S5')}`, riskLevel: 'high_risk' },
    { value: 'S6', label: `S6 - ${t('category.S6')}`, riskLevel: 'medium_risk' },
    { value: 'S7', label: `S7 - ${t('category.S7')}`, riskLevel: 'medium_risk' },
    { value: 'S8', label: `S8 - ${t('category.S8')}`, riskLevel: 'low_risk' },
    { value: 'S9', label: `S9 - ${t('category.S9')}`, riskLevel: 'high_risk' },
    { value: 'S10', label: `S10 - ${t('category.S10')}`, riskLevel: 'low_risk' },
    { value: 'S11', label: `S11 - ${t('category.S11')}`, riskLevel: 'low_risk' },
    { value: 'S12', label: `S12 - ${t('category.S12')}`, riskLevel: 'low_risk' },
    { value: 'S13', label: `S13 - ${t('category.S13')}`, riskLevel: 'low_risk' },
    { value: 'S14', label: `S14 - ${t('category.S14')}`, riskLevel: 'low_risk' },
    { value: 'S15', label: `S15 - ${t('category.S15')}`, riskLevel: 'high_risk' },
    { value: 'S16', label: `S16 - ${t('category.S16')}`, riskLevel: 'medium_risk' },
    { value: 'S17', label: `S17 - ${t('category.S17')}`, riskLevel: 'high_risk' },
    { value: 'S18', label: `S18 - ${t('category.S18')}`, riskLevel: 'low_risk' },
    { value: 'S19', label: `S19 - ${t('category.S19')}`, riskLevel: 'low_risk' },
    { value: 'default', label: t('template.defaultReject'), riskLevel: 'no_risk' },
  ];

  useEffect(() => {
    fetchData();
  }, []);

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchData();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const result = await configApi.responses.list();
      
      // Ensure each category has one reject record, if not, create a default one
      const existingCategories = result.map((item: ResponseTemplate) => item.category);
      const missingCategories = categories.filter(cat => !existingCategories.includes(cat.value));
      
      // Create default reject content for missing categories
      for (const category of missingCategories) {
        // Use internationalized default reject content
        const defaultContent = t(`template.defaultContents.${category.value}`);
        try {
          await configApi.responses.create({
            category: category.value,
            risk_level: category.riskLevel,
            template_content: defaultContent,
            is_default: true,
            is_active: true
          });
        } catch (error) {
          console.error(`Failed to create default template for ${category.value}:`, error);
        }
      }
      
      // Re-fetch data
      const updatedResult = await configApi.responses.list();
      setData(updatedResult);
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

  const columns = [
    {
      title: t('template.riskCategory'),
      dataIndex: 'category',
      key: 'category',
      render: (category: string) => (
        <Tag color={category === 'default' ? 'blue' : 'orange'}>
          {getCategoryLabel(category)}
        </Tag>
      ),
    },
    {
      title: t('results.riskLevel'),
      dataIndex: 'risk_level',
      key: 'risk_level',
      render: (level: string) => {
        const getColor = (riskLevel: string) => {
          if (riskLevel === 'high_risk' || riskLevel === '高风险') return 'red';
          if (riskLevel === 'medium_risk' || riskLevel === '中风险') return 'orange';
          if (riskLevel === 'low_risk' || riskLevel === '低风险') return 'yellow';
          return 'green';
        };
        
        return (
          <Tag color={getColor(level)}>
            {getRiskLevelLabel(level)}
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
      render: (content: any) => {
        if (typeof content === 'string') {
          return content;
        } else if (typeof content === 'object') {
          // Display only the current language content
          const currentLang = i18n.language || 'en';
          const displayContent = content[currentLang] || content['en'] || content['zh'] || '';
          return displayContent;
        }
        return '';
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
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3>{t('template.rejectAnswerLibrary')}</h3>
        <p style={{ color: '#666', marginBottom: 16 }}>
          {t('template.rejectAnswerDescription')}
        </p>
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