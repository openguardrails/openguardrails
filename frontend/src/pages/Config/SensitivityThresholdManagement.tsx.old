import React, { useState, useEffect } from 'react';
import {
  Card,
  InputNumber,
  message,
  Spin,
  Typography,
  Space,
  Button,
  Table,
  Tag,
  Alert,
  Modal,
  Select,
} from 'antd';
import {
  InfoCircleOutlined,
  EditOutlined,
  CheckOutlined
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { sensitivityThresholdApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useApplication } from '../../contexts/ApplicationContext';

const { Title, Text, Paragraph } = Typography;

interface SensitivityThresholdConfig {
  high_sensitivity_threshold: number;
  medium_sensitivity_threshold: number;
  low_sensitivity_threshold: number;
  sensitivity_trigger_level: string;
}

interface SensitivityLevel {
  key: string;
  name: string;
  threshold: number;
  description: string;
  target: string;
}

const SensitivityThresholdManagement: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<SensitivityThresholdConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingLevels, setEditingLevels] = useState<SensitivityLevel[]>([]);
  const [saving, setSaving] = useState(false);
  const { onUserSwitch } = useAuth();
  const { currentApplicationId } = useApplication();

  useEffect(() => {
    if (currentApplicationId) {
      loadConfig();
    }
  }, [currentApplicationId]);

  // Listen to user switch event, automatically refresh config
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadConfig();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const data = await sensitivityThresholdApi.get();
      setConfig(data);
    } catch (error) {
      message.error(t('sensitivity.fetchFailed'));
      console.error('Failed to load sensitivity threshold config:', error);
    } finally {
      setLoading(false);
    }
  };

  // Get sensitivity level data
  const getSensitivityLevels = (): SensitivityLevel[] => {
    if (!config) return [];

    return [
      {
        key: 'high',
        name: t('sensitivity.high'),
        threshold: config.high_sensitivity_threshold,
        description: t('sensitivity.strictestDetection'),
        target: t('sensitivity.highSensitivityTarget')
      },
      {
        key: 'medium',
        name: t('sensitivity.medium'),
        threshold: config.medium_sensitivity_threshold,
        description: t('sensitivity.balancedDetection'),
        target: t('sensitivity.mediumSensitivityTarget')
      },
      {
        key: 'low',
        name: t('sensitivity.low'),
        threshold: config.low_sensitivity_threshold,
        description: t('sensitivity.loosestDetection'),
        target: t('sensitivity.lowSensitivityTarget')
      }
    ];
  };

  // Open edit modal
  const handleEdit = () => {
    const levels = getSensitivityLevels();
    setEditingLevels(levels);
    setEditModalVisible(true);
  };

  // Validate threshold settings
  const validateThresholds = (levels: SensitivityLevel[]): boolean => {
    const sortedLevels = [...levels].sort((a, b) => b.threshold - a.threshold);
    // Threshold must be between 0 and 1
    if (sortedLevels[0].threshold < 0 || sortedLevels[0].threshold > 1) {
      message.error(t('sensitivity.invalidThreshold'));
      return false;
    }

    // Check if sorted from high to low
    if (sortedLevels[0].key !== 'low' || sortedLevels[1].key !== 'medium' || sortedLevels[2].key !== 'high') {
      message.error(t('sensitivity.thresholdOrder'));
      return false;
    }

    // Check if there is overlap
    for (let i = 0; i < sortedLevels.length - 1; i++) {
      if (sortedLevels[i].threshold <= sortedLevels[i + 1].threshold) {
        message.error(t('sensitivity.thresholdOrder'));
        return false;
      }
    }

    return true;
  };

  // Save config
  const handleSave = async () => {
    if (!validateThresholds(editingLevels)) return;

    try {
      setSaving(true);

      const newConfig: SensitivityThresholdConfig = {
        high_sensitivity_threshold: editingLevels.find(l => l.key === 'high')!.threshold,
        medium_sensitivity_threshold: editingLevels.find(l => l.key === 'medium')!.threshold,
        low_sensitivity_threshold: editingLevels.find(l => l.key === 'low')!.threshold,
        sensitivity_trigger_level: config?.sensitivity_trigger_level || 'medium'
      };

      await sensitivityThresholdApi.update(newConfig);
      setConfig(newConfig);
      setEditModalVisible(false);
      message.success(t('sensitivity.saveSuccess'));
    } catch (error) {
      message.error(t('sensitivity.fetchFailed'));
      console.error('Failed to update sensitivity threshold config:', error);
    } finally {
      setSaving(false);
    }
  };

  // Handle current sensitivity level change
  const handleTriggerLevelChange = async (value: string) => {
    if (!config) return;

    try {
      setSaving(true);
      const newConfig = { ...config, sensitivity_trigger_level: value };

      await sensitivityThresholdApi.update(newConfig);
      setConfig(newConfig);

      const levelNames = { low: t('sensitivity.low'), medium: t('sensitivity.medium'), high: t('sensitivity.high') };
      message.success(t('sensitivity.levelChangeSuccess', { level: levelNames[value as keyof typeof levelNames] }));
    } catch (error) {
      message.error(t('sensitivity.fetchFailed'));
      console.error('Failed to update sensitivity trigger level:', error);
    } finally {
      setSaving(false);
    }
  };

  // Table column definition
  const columns = [
    {
      title: t('sensitivity.levelName'),
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => {
        const colors = { [t('sensitivity.high')]: '#f5222d', [t('sensitivity.medium')]: '#fa8c16', [t('sensitivity.low')]: '#52c41a' };
        return <Tag color={colors[text as keyof typeof colors]}>{text}</Tag>;
      }
    },
    {
      title: t('sensitivity.threshold'),
      dataIndex: 'threshold',
      key: 'threshold',
      render: (value: number) => <Text code>{value.toFixed(2)}</Text>
    },
    {
      title: t('common.description'),
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: t('sensitivity.targetScenario'),
      dataIndex: 'target',
      key: 'target',
    }
  ];

  // Edit modal table column
  const editColumns = [
    {
      title: t('sensitivity.sensitivityLevel'),
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => {
        const colors = { [t('sensitivity.high')]: '#f5222d', [t('sensitivity.medium')]: '#fa8c16', [t('sensitivity.low')]: '#52c41a' };
        return <Tag color={colors[text as keyof typeof colors]}>{text}</Tag>;
      }
    },
    {
      title: t('sensitivity.probabilityThreshold'),
      dataIndex: 'threshold',
      key: 'threshold',
      render: (value: number, _: SensitivityLevel, index: number) => (
        <InputNumber
          value={value}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          style={{ width: '100%' }}
          onChange={(newValue) => {
            if (newValue !== null) {
              const newLevels = [...editingLevels];
              newLevels[index] = { ...newLevels[index], threshold: newValue };
              setEditingLevels(newLevels);
            }
          }}
        />
      )
    }
  ];

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!config) {
    return <div>{t('sensitivity.fetchFailed')}</div>;
  }

  const sensitivityLevels = getSensitivityLevels();

  return (
    <div>
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Title level={4}>
              <InfoCircleOutlined style={{ marginRight: 8 }} />
              {t('sensitivity.title')}
            </Title>
            <Paragraph type="secondary">
              {t('sensitivity.description')}
            </Paragraph>
          </div>

          {/* Current config table */}
          <Card
            title={t('sensitivity.currentSensitivityLevel')}
            extra={
              <Button
                type="primary"
                icon={<EditOutlined />}
                onClick={handleEdit}
              >
                {t('sensitivity.editThresholds')}
              </Button>
            }
          >
            <Table
              columns={columns}
              dataSource={sensitivityLevels}
              rowKey="key"
              pagination={false}
              size="small"
            />
          </Card>

          {/* Current sensitivity level config */}
          <Card title={t('sensitivity.currentSensitivityLevel')}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                message={t('sensitivity.configurationExplanation')}
                description={
                  <Space direction="vertical" size="small">
                    <Text style={{ fontSize: '12px' }}>
                      • {t('sensitivity.highSensitivityDesc', { threshold: config.high_sensitivity_threshold })}
                    </Text>
                    <Text style={{ fontSize: '12px' }}>
                      • {t('sensitivity.mediumSensitivityDesc', { threshold: config.medium_sensitivity_threshold })}
                    </Text>
                    <Text style={{ fontSize: '12px' }}>
                      • {t('sensitivity.lowSensitivityDesc', { threshold: config.low_sensitivity_threshold })}
                    </Text>
                  </Space>
                }
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Text strong>{t('sensitivity.currentLevel')}：</Text>
                <Select
                  value={config?.sensitivity_trigger_level}
                  onChange={handleTriggerLevelChange}
                  disabled={saving}
                  style={{ width: 200 }}
                  options={[
                    {
                      value: 'high',
                      label: (
                        <span>
                          <Tag color="#f5222d" style={{ border: 'none', margin: 0 }}>{t('sensitivity.high')}</Tag>
                          <span style={{ marginLeft: '4px' }}>{t('sensitivity.sensitivityLabel')}</span>
                        </span>
                      )
                    },
                    {
                      value: 'medium',
                      label: (
                        <span>
                          <Tag color="#fa8c16" style={{ border: 'none', margin: 0 }}>{t('sensitivity.medium')}</Tag>
                          <span style={{ marginLeft: '4px' }}>{t('sensitivity.sensitivityLabel')}</span>
                        </span>
                      )
                    },
                    {
                      value: 'low',
                      label: (
                        <span>
                          <Tag color="#52c41a" style={{ border: 'none', margin: 0 }}>{t('sensitivity.low')}</Tag>
                          <span style={{ marginLeft: '4px' }}>{t('sensitivity.sensitivityLabel')}</span>
                        </span>
                      )
                    }
                  ]}
                />
              </div>

              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#f9f9f9', borderRadius: '4px', border: '1px dashed #d9d9d9' }}>
                <Text style={{ fontSize: '12px', color: '#666' }}>
                  {config?.sensitivity_trigger_level === 'high' && t('sensitivity.currentDetectionRule', { threshold: config.high_sensitivity_threshold })}
                  {config?.sensitivity_trigger_level === 'medium' && t('sensitivity.currentDetectionRule', { threshold: config.medium_sensitivity_threshold })}
                  {config?.sensitivity_trigger_level === 'low' && t('sensitivity.currentDetectionRule', { threshold: config.low_sensitivity_threshold })}
                </Text>
              </div>
            </Space>
          </Card>

          {/* Edit modal */}
          <Modal
            title={t('sensitivity.editThresholds')}
            open={editModalVisible}
            onCancel={() => setEditModalVisible(false)}
            footer={[
              <Button key="cancel" onClick={() => setEditModalVisible(false)}>
                {t('common.cancel')}
              </Button>,
              <Button
                key="save"
                type="primary"
                loading={saving}
                onClick={handleSave}
                icon={<CheckOutlined />}
              >
                {t('common.save')}
              </Button>
            ]}
            width={800}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                message={t('sensitivity.editInstructions')}
                description={
                  <Space direction="vertical" size="small">
                    <Text style={{ fontSize: '12px' }}>
                      • {t('sensitivity.editDescription1')}
                    </Text>
                    <Text style={{ fontSize: '12px' }}>
                      • {t('sensitivity.editDescription2')}
                    </Text>
                  </Space>
                }
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <Table
                columns={editColumns}
                dataSource={editingLevels}
                rowKey="key"
                pagination={false}
                size="small"
              />
            </Space>
          </Modal>
        </Space>
      </Card>
    </div>
  );
};

export default SensitivityThresholdManagement;