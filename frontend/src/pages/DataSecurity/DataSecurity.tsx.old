import React from 'react';
import { Card, Alert, Typography, Space, Tag, Collapse } from 'antd';
import { SafetyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import EntityTypeManagement from './EntityTypeManagement';

const { Paragraph, Text } = Typography;

const DataSecurity: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div>
      <Card
        title={
          <Space>
            <SafetyOutlined />
            <span>{t('dataSecurity.dataLeakPrevention')}</span>
          </Space>
        }
        bordered={false}
      >
        <Alert
          message={
            <Space>
              <InfoCircleOutlined />
              <Text>{t('dataSecurity.dataLeakPreventionDesc')}</Text>
            </Space>
          }
          type="info"
          showIcon={false}
          style={{ marginBottom: 16 }}
        />

        <Collapse
          ghost
          style={{ marginBottom: 24, background: '#fafafa' }}
          items={[
            {
              key: '1',
              label: <Text strong style={{ fontSize: 14 }}>💡 {t('dataSecurity.functionalityGuide')}</Text>,
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <div>
                    <Text strong style={{ fontSize: 13 }}>📥 {t('dataSecurity.inputDataPrevention')}</Text>
                    <Paragraph style={{ marginTop: 4, marginBottom: 8, fontSize: 13 }}>
                      {t('dataSecurity.inputDataPreventionDesc')}
                    </Paragraph>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                      <li>{t('dataSecurity.enterpriseDeployment')}</li>
                      <li>{t('dataSecurity.publicService')}</li>
                    </ul>
                  </div>

                  <div>
                    <Text strong style={{ fontSize: 13 }}>📤 {t('dataSecurity.outputDataPrevention')}</Text>
                    <Paragraph style={{ marginTop: 4, marginBottom: 8, fontSize: 13 }}>
                      {t('dataSecurity.outputDataPreventionDesc')}
                    </Paragraph>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                      <li>{t('dataSecurity.enterpriseInternal')}</li>
                      <li>{t('dataSecurity.publicServiceOutput')}</li>
                    </ul>
                  </div>

                  <div>
                    <Text strong style={{ fontSize: 13 }}>📋 {t('sensitivity.usageSteps')}</Text>
                    <ol style={{ marginTop: 4, marginBottom: 0, paddingLeft: 20, fontSize: 12 }}>
                      <li>{t('sensitivity.configEntityTypes')}</li>
                      <li>{t('sensitivity.setRecognitionRules')}</li>
                      <li>{t('sensitivity.selectDesensitizationMethod')}</li>
                      <li>{t('sensitivity.configDetectionScope')}</li>
                    </ol>
                  </div>
                </Space>
              ),
            },
          ]}
        />

        <EntityTypeManagement />
      </Card>
    </div>
  );
};

export default DataSecurity;
