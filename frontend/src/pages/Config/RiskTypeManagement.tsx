import React, { useState, useEffect } from 'react';
import { Card, Switch, message, Spin, Typography, Divider, Space, Row, Col } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getRiskConfig, updateRiskConfig } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

const { Title, Text } = Typography;

interface RiskTypeConfig {
  s1_enabled: boolean;
  s2_enabled: boolean;
  s3_enabled: boolean;
  s4_enabled: boolean;
  s5_enabled: boolean;
  s6_enabled: boolean;
  s7_enabled: boolean;
  s8_enabled: boolean;
  s9_enabled: boolean;
  s10_enabled: boolean;
  s11_enabled: boolean;
  s12_enabled: boolean;
  s13_enabled: boolean;
  s14_enabled: boolean;
  s15_enabled: boolean;
  s16_enabled: boolean;
  s17_enabled: boolean;
  s18_enabled: boolean;
  s19_enabled: boolean;
  s20_enabled: boolean;
  s21_enabled: boolean;
}

const RiskTypeManagement: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<RiskTypeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { onUserSwitch } = useAuth();

  // Risk types definition - sorted by risk level (high > medium > low)
  const RISK_TYPES = [
    // High risk
    { key: 's2_enabled', code: 'S2', name: t('config.riskTypes.s2'), level: t('risk.level.high_risk'), color: '#f5222d', priority: 1 },
    { key: 's3_enabled', code: 'S3', name: t('config.riskTypes.s3'), level: t('risk.level.high_risk'), color: '#f5222d', priority: 1 },
    { key: 's5_enabled', code: 'S5', name: t('config.riskTypes.s5'), level: t('risk.level.high_risk'), color: '#f5222d', priority: 1 },
    { key: 's9_enabled', code: 'S9', name: t('config.riskTypes.s9'), level: t('risk.level.high_risk'), color: '#f5222d', priority: 1 },
    { key: 's15_enabled', code: 'S15', name: t('config.riskTypes.s15'), level: t('risk.level.high_risk'), color: '#f5222d', priority: 1 },
    { key: 's17_enabled', code: 'S17', name: t('config.riskTypes.s17'), level: t('risk.level.high_risk'), color: '#f5222d', priority: 1 },
    // Medium risk
    { key: 's4_enabled', code: 'S4', name: t('config.riskTypes.s4'), level: t('risk.level.medium_risk'), color: '#fa8c16', priority: 2 },
    { key: 's6_enabled', code: 'S6', name: t('config.riskTypes.s6'), level: t('risk.level.medium_risk'), color: '#fa8c16', priority: 2 },
    { key: 's7_enabled', code: 'S7', name: t('config.riskTypes.s7'), level: t('risk.level.medium_risk'), color: '#fa8c16', priority: 2 },
    { key: 's16_enabled', code: 'S16', name: t('config.riskTypes.s16'), level: t('risk.level.medium_risk'), color: '#fa8c16', priority: 2 },
    // Low risk
    { key: 's1_enabled', code: 'S1', name: t('config.riskTypes.s1'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's8_enabled', code: 'S8', name: t('config.riskTypes.s8'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's10_enabled', code: 'S10', name: t('config.riskTypes.s10'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's11_enabled', code: 'S11', name: t('config.riskTypes.s11'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's12_enabled', code: 'S12', name: t('config.riskTypes.s12'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's13_enabled', code: 'S13', name: t('config.riskTypes.s13'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's14_enabled', code: 'S14', name: t('config.riskTypes.s14'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's18_enabled', code: 'S18', name: t('config.riskTypes.s18'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's19_enabled', code: 'S19', name: t('config.riskTypes.s19'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's20_enabled', code: 'S20', name: t('config.riskTypes.s20'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
    { key: 's21_enabled', code: 'S21', name: t('config.riskTypes.s21'), level: t('risk.level.low_risk'), color: '#52c41a', priority: 3 },
  ];

  useEffect(() => {
    loadRiskConfig();
  }, []);

  // 监听用户切换事件，自动刷新配置
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadRiskConfig();
    });
    return unsubscribe;
  }, [onUserSwitch]);

  const loadRiskConfig = async () => {
    try {
      setLoading(true);
      const data = await getRiskConfig();
      setConfig(data);
    } catch (error) {
      message.error(t('riskType.loadFailed'));
      console.error('Failed to load risk config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (key: keyof RiskTypeConfig, checked: boolean) => {
    if (!config) return;

    try {
      setSaving(true);
      const newConfig = { ...config, [key]: checked };

      await updateRiskConfig(newConfig);
      setConfig(newConfig);

      const riskType = RISK_TYPES.find(type => type.key === key);
      const statusText = checked ? t('common.enabled') : t('common.disabled');
      message.success(`${riskType?.code} ${riskType?.name} ${statusText}`);
    } catch (error) {
      message.error(t('riskType.updateFailed'));
      console.error('Failed to update risk config:', error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!config) {
    return <div>{t('riskType.loadConfigFailed')}</div>;
  }

  const enabledCount = Object.values(config).filter(Boolean).length;
  const totalCount = Object.keys(config).length;

  return (
    <div>
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Title level={4}>
              <InfoCircleOutlined style={{ marginRight: 8 }} />
              {t('riskType.title')}
            </Title>
            <Text type="secondary">
              {t('riskType.description')}
              <br />
              {t('riskType.currentEnabled', { enabled: enabledCount, total: totalCount })}
            </Text>
          </div>

          <Divider />

          {/* Risk level grouping */}
          {[
            { level: t('risk.level.high_risk'), priority: 1, bgColor: '#fff2f0', borderColor: '#ffccc7' },
            { level: t('risk.level.medium_risk'), priority: 2, bgColor: '#fff7e6', borderColor: '#ffd591' },
            { level: t('risk.level.low_risk'), priority: 3, bgColor: '#f6ffed', borderColor: '#d9f7be' }
          ].map((group) => {
            const groupRiskTypes = RISK_TYPES.filter(type => type.priority === group.priority);
            return (
              <div key={group.level} style={{ marginBottom: '24px' }}>
                <div
                  style={{
                    padding: '12px 16px',
                    backgroundColor: group.bgColor,
                    border: `1px solid ${group.borderColor}`,
                    borderRadius: '8px',
                    marginBottom: '16px'
                  }}
                >
                  <Text strong style={{ fontSize: '16px', color: '#262626' }}>
                    {group.level} ({t('riskType.itemCount', { count: groupRiskTypes.length })})
                  </Text>
                </div>
                <Row gutter={[16, 16]}>
                  {groupRiskTypes.map((riskType) => (
                    <Col xs={24} sm={12} md={8} lg={6} key={riskType.key}>
                      <Card
                        size="small"
                        style={{
                          borderColor: config[riskType.key as keyof RiskTypeConfig] ? riskType.color : '#d9d9d9',
                          backgroundColor: config[riskType.key as keyof RiskTypeConfig] ? '#fafafa' : '#f5f5f5'
                        }}
                      >
                        <Space direction="vertical" size="small" style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text strong style={{ fontSize: '14px' }}>
                              {riskType.name}
                            </Text>
                            <Switch
                              checked={config[riskType.key as keyof RiskTypeConfig]}
                              onChange={(checked) => handleToggle(riskType.key as keyof RiskTypeConfig, checked)}
                              loading={saving}
                              size="small"
                            />
                          </div>
                          <Text style={{ fontSize: '12px', color: '#666' }}>
                            {riskType.code}
                          </Text>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text
                              style={{
                                fontSize: '11px',
                                color: riskType.color,
                                fontWeight: 'bold'
                              }}
                            >
                              {riskType.level}
                            </Text>
                            <Text
                              style={{
                                fontSize: '11px',
                                color: config[riskType.key as keyof RiskTypeConfig] ? '#52c41a' : '#ff4d4f'
                              }}
                            >
                              {config[riskType.key as keyof RiskTypeConfig] ? t('common.enabled') : t('common.disabled')}
                            </Text>
                          </div>
                        </Space>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </div>
            );
          })}

          <Divider />

          <Card size="small" style={{ backgroundColor: '#f6ffed', borderColor: '#b7eb8f' }}>
            <Space direction="vertical" size="small">
              <Text style={{ fontSize: '13px', fontWeight: 'bold', color: '#389e0d' }}>
                ⚠️ {t('riskType.importantNotice')}
              </Text>
              <Text style={{ fontSize: '12px', color: '#666' }}>
                • {t('riskType.notice1')}
              </Text>
              <Text style={{ fontSize: '12px', color: '#666' }}>
                • {t('riskType.notice2')}
              </Text>
              <Text style={{ fontSize: '12px', color: '#666' }}>
                • {t('riskType.notice3')}
              </Text>
            </Space>
          </Card>
        </Space>
      </Card>
    </div>
  );
};

export default RiskTypeManagement;