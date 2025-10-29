import React, { useState, useEffect } from 'react';
import {
  Card,
  Input,
  Button,
  Space,
  Typography,
  Alert,
  Spin,
  Divider,
  Row,
  Col,
  Tag,
  Select,
  Switch,
  message
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api, { testModelsApi } from '../../services/api';
import {
  PlayCircleOutlined,
  ClearOutlined,
  SettingOutlined,
  PictureOutlined
} from '@ant-design/icons';
import ImageUpload from '../../components/ImageUpload/ImageUpload';

const { TextArea } = Input;
const { Title, Text, Paragraph } = Typography;
const { Option } = Select;

interface TestModel {
  id: string;
  config_name: string;
  api_base_url: string;
  model_name: string;
  enabled: boolean;
  selected: boolean;  // Whether it has been selected for online testing
}

interface TestCase {
  id: string;
  name: string;
  type: 'question' | 'qa_pair';
  content: string;
  expectedRisk?: string;
  description?: string;
}

interface GuardrailResult {
  compliance: {
    risk_level: string;
    categories: string[];
  };
  security: {
    risk_level: string;
    categories: string[];
  };
  data?: {
    risk_level: string;
    categories: string[];
  };
  overall_risk_level: string;
  suggest_action: string;
  suggest_answer: string;
  error?: string; // Add error information field
}

interface ModelResponse {
  content: string;
  error?: string;
}

interface TestResult {
  guardrail: GuardrailResult;
  models: Record<string, ModelResponse>;
  original_responses: Record<string, ModelResponse>;
}

const OnlineTest: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Helper function to translate risk level
  const translateRiskLevel = (riskLevel: string) => {
    const riskLevelMap: { [key: string]: string } = {
      'high_risk': t('risk.level.high_risk'),
      'medium_risk': t('risk.level.medium_risk'),
      'low_risk': t('risk.level.low_risk'),
      'no_risk': t('risk.level.no_risk'),
    };
    return riskLevelMap[riskLevel] || riskLevel;
  };
  const [loading, setLoading] = useState(false);
  const [testInput, setTestInput] = useState('');
  const [inputType, setInputType] = useState<'question' | 'qa_pair'>('question');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [models, setModels] = useState<TestModel[]>([]);
  const [modelSelectionChanged, setModelSelectionChanged] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<string[]>([]);

  // 加载模型配置
  const loadModels = async () => {
    try {
      const modelsData = await testModelsApi.getModels();
      setModels(modelsData);
    } catch (error) {
      console.error('Failed to load models:', error);
      message.error(t('onlineTest.loadModelsFailed'));
    }
  };

  // 更新模型选择
  const updateModelSelection = async (modelId: string, selected: boolean) => {
    try {
      const newModels = models.map(model =>
        model.id === modelId ? { ...model, selected } : model
      );
      setModels(newModels);
      setModelSelectionChanged(true);

      // Save to backend
      const selections = newModels.map(model => ({
        id: model.id,
        selected: model.selected
      }));

      await testModelsApi.updateSelection(selections);
      message.success(t('onlineTest.modelSelectionUpdated'));
      setModelSelectionChanged(false);
    } catch (error) {
      console.error('Failed to update model selection:', error);
      message.error(t('onlineTest.loadModelsFailed'));
      // Roll back local state
      loadModels();
    }
  };

  // 组件挂载时加载模型配置
  useEffect(() => {
    loadModels();
  }, []);

  // Preset test cases
  const testCases: TestCase[] = [
    {
      id: '1',
      name: t('onlineTest.promptAttackExample'),
      type: 'question',
      content: t('onlineTest.testCases.promptAttackContent'),
      expectedRisk: t('risk.level.high_risk'),
      description: t('onlineTest.promptAttackExampleDesc')
    },
    {
      id: '2',
      name: t('onlineTest.violentCrimeContent'),
      type: 'question',
      content: t('onlineTest.testCases.violentCrimeContent'),
      expectedRisk: t('risk.level.high_risk'),
      description: t('onlineTest.violentCrimeContentDesc')
    },
    {
      id: '3',
      name: t('onlineTest.sensitivePoliticalTopic'),
      type: 'question',
      content: t('onlineTest.testCases.sensitivePoliticalContent'),
      expectedRisk: t('risk.level.high_risk'),
      description: t('onlineTest.sensitivePoliticalTopicDesc')
    },
    {
      id: '4',
      name: t('onlineTest.pornographicContent'),
      type: 'question',
      content: t('onlineTest.testCases.pornographicContent'),
      expectedRisk: t('risk.level.medium_risk'),
      description: t('onlineTest.pornographicContentDesc')
    },
    {
      id: '5',
      name: t('onlineTest.discriminatoryContent'),
      type: 'question',
      content: t('onlineTest.testCases.discriminatoryContent'),
      expectedRisk: t('risk.level.low_risk'),
      description: t('onlineTest.discriminatoryContentDesc')
    },
    {
      id: '6',
      name: t('onlineTest.dataLeakIdentity'),
      type: 'qa_pair',
      content: t('onlineTest.testCases.dataLeakIdentityContent'),
      expectedRisk: t('risk.level.high_risk'),
      description: t('onlineTest.dataLeakIdentityDesc')
    },
    {
      id: '7',
      name: t('onlineTest.dataLeakBanking'),
      type: 'qa_pair',
      content: t('onlineTest.testCases.dataLeakBankingContent'),
      expectedRisk: t('risk.level.high_risk'),
      description: t('onlineTest.dataLeakBankingDesc')
    },
    {
      id: '8',
      name: t('onlineTest.dataLeakEmail'),
      type: 'qa_pair',
      content: t('onlineTest.testCases.dataLeakEmailContent'),
      expectedRisk: t('risk.level.low_risk'),
      description: t('onlineTest.dataLeakEmailDesc')
    },
    {
      id: '9',
      name: t('onlineTest.safeQaPair'),
      type: 'qa_pair',
      content: t('onlineTest.testCases.safeQaPairContent'),
      expectedRisk: t('risk.level.no_risk'),
      description: t('onlineTest.safeQaPairDesc')
    }
  ];

  // Execute test
  const runTest = async () => {
    if (!testInput.trim() && uploadedImages.length === 0) {
      message.warning(t('onlineTest.pleaseEnterTestContent'));
      return;
    }

    setLoading(true);
    try {
      // Construct message format
      let messages;
      let content: any[] = []; // Promote scope to function top

      if (inputType === 'question') {
        // Construct multi-modal content
        // Add text content (if any)
        if (testInput.trim()) {
          content.push({ type: 'text', text: testInput });
        }

        // Add image content
        uploadedImages.forEach(base64Image => {
          content.push({
            type: 'image_url',
            image_url: { url: base64Image }
          });
        });

        // If there is only text, use simple format; if there are images, use multi-modal format
        if (uploadedImages.length > 0) {
          messages = [{ role: 'user', content }];
        } else {
          messages = [{ role: 'user', content: testInput }];
        }
      } else {
        // Q&A pair mode (images not supported yet)
        const lines = testInput.split('\n');
        const question = lines.find(line => line.startsWith('Q:'))?.substring(2).trim();
        const answer = lines.find(line => line.startsWith('A:'))?.substring(2).trim();

        if (!question || !answer) {
          message.error(t('onlineTest.qaPairFormatError'));
          return;
        }

        messages = [
          { role: 'user', content: question },
          { role: 'assistant', content: answer }
        ];
      }

      // Check if there are images, decide which API and model to use
      const hasImages = uploadedImages.length > 0;
      let response;

      if (hasImages) {
        // With images: Call guardrail detection via online test API, using VL model
        const requestData = {
          content: testInput,
          input_type: inputType,
          images: uploadedImages // Add image data
        };

        response = await api.post('/api/v1/test/online', requestData);

        // Use unified online test result format
        setTestResult({
          guardrail: response.data.guardrail,
          models: response.data.models || {},
          original_responses: response.data.original_responses || {}
        });
      } else {
        // Pure text: Use original online test API
        const selectedModels = models.filter(m => m.selected);
        if (inputType === 'question' && selectedModels.length === 0) {
          message.info(t('onlineTest.proxyModelHint'));
        }

        const requestData = {
          content: testInput,
          input_type: inputType
        };

        response = await api.post('/api/v1/test/online', requestData);

        setTestResult({
          guardrail: response.data.guardrail,
          models: response.data.models || {},
          original_responses: response.data.original_responses || {}
        });
      }

    } catch (error: any) {
      console.error('Test failed:', error);
      const errorMessage = error?.response?.data?.detail || error?.message || t('onlineTest.testExecutionFailed');
      const status = error?.response?.status;

      // For specific HTTP errors, display in guardrail results
      if (status === 408 || status === 429 || status === 401 || status === 500) {
        let displayMessage = errorMessage;

        // Add more friendly descriptions for specific error statuses
        if (status === 401) {
          displayMessage = t('onlineTest.apiAuthFailed');
        } else if (status === 408) {
          // 408 is timeout error, display specific timeout info
          displayMessage = errorMessage;
        } else if (status === 429) {
          // 429 is rate limit error, don't override backend's specific rate limit info
          displayMessage = errorMessage;
        } else if (status === 500) {
          displayMessage = t('onlineTest.serverError');
        }

        setTestResult({
          guardrail: {
            compliance: { risk_level: t('onlineTest.testFailed'), categories: [] },
            security: { risk_level: t('onlineTest.testFailed'), categories: [] },
            overall_risk_level: t('onlineTest.testFailed'),
            suggest_action: t('onlineTest.testFailed'),
            suggest_answer: '',
            error: displayMessage
          },
          models: {},
          original_responses: {}
        });
      } else {
        // Other errors (like network errors) still use popup notifications
        // Check if it's an axios timeout error
        if (error.code === 'ECONNABORTED' || errorMessage.includes('timeout')) {
          message.error(t('onlineTest.requestTimeout'));
        } else {
          message.error(`${t('onlineTest.testExecutionFailed')}: ${errorMessage}`);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  // Clear input
  const clearInput = () => {
    setTestInput('');
    setTestResult(null);
    setUploadedImages([]);
  };

  // Handle image upload
  const handleImageChange = (base64Images: string[]) => {
    setUploadedImages(base64Images);
  };

  // Use preset test case
  const useTestCase = (testCase: TestCase) => {
    setTestInput(testCase.content);
    setInputType(testCase.type);
    message.success(t('onlineTest.testCaseLoaded', { name: testCase.name }));
  };


  const getRiskColor = (level: string) => {
    // The backend returns standardized English values, directly match
    switch (level) {
      case 'high_risk':
        return 'red';
      case 'medium_risk':
        return 'orange';
      case 'low_risk':
        return 'yellow';
      case 'no_risk':
      case 'safe':
        return 'green';
      case 'test_failed':
      case 'detection_failed':
      case 'error':
        return 'red';
      default: 
        return 'default';
    }
  };

  const getActionColor = (action: string) => {
    // The backend returns standardized English values, directly match
    switch (action) {
      case 'reject':
        return 'red';
      case 'replace':
        return 'orange';
      case 'pass':
        return 'green';
      case 'test_failed':
      case 'error':
      case 'system_error':
        return 'red';
      default: 
        return 'default';
    }
  };

  return (
    <div>
      <Title level={2}>{t('onlineTest.title')}</Title>
      <Paragraph>{t('onlineTest.description')}</Paragraph>

      <Row gutter={[24, 24]}>
        {/* Left side: Test input area */}
        <Col span={16}>
          <Card title={t('onlineTest.testInput')} extra={
            <Space>
              <Select value={inputType} onChange={setInputType} style={{ width: 120 }}>
                <Option value="question">{t('onlineTest.singleQuestion')}</Option>
                <Option value="qa_pair">{t('onlineTest.qaPair')}</Option>
              </Select>
              <Button
                icon={<SettingOutlined />}
                onClick={() => navigate('/security-gateway')}
              >
                {t('onlineTest.manageProxyModels')}
              </Button>
            </Space>
          }>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <div>
                <TextArea
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder={
                    inputType === 'question'
                      ? t('onlineTest.questionPlaceholder')
                      : t('onlineTest.qaPairPlaceholder')
                  }
                  rows={6}
                />
              </div>

              {/* Image upload area - only shown for single question type */}
              {inputType === 'question' && (
                <Card
                  title={
                    <Space>
                      <PictureOutlined />
                      {t('onlineTest.imageDetectionOptional')}
                    </Space>
                  }
                  size="small"
                >
                  <ImageUpload
                    onChange={handleImageChange}
                    maxCount={5}
                    maxSize={10}
                  />
                  {uploadedImages.length > 0 && (
                    <Alert
                      message={t('onlineTest.imagesSelected', { count: uploadedImages.length })}
                      type="success"
                      showIcon
                      style={{ marginTop: 12 }}
                    />
                  )}
                </Card>
              )}

              {/* Proxy model selection - only shown for single question type */}
              {inputType === 'question' && (
                <div>
                  <Title level={5} style={{ marginBottom: 12 }}>{t('onlineTest.selectTestModels')}</Title>
                  {models.length === 0 ? (
                    <Alert
                      message={t('onlineTest.noProxyModels')}
                      description={
                        <span>
                          {t('onlineTest.noProxyModelsDesc').split(t('onlineTest.securityGateway'))[0]}
                          <Button
                            type="link"
                            size="small"
                            onClick={() => navigate('/security-gateway')}
                            style={{ padding: 0, margin: '0 4px' }}
                          >
                            {t('onlineTest.securityGateway')}
                          </Button>
                          {t('onlineTest.noProxyModelsDesc').split(t('onlineTest.securityGateway'))[1]}
                        </span>
                      }
                      type="info"
                      showIcon
                      style={{ marginBottom: 16 }}
                    />
                  ) : (
                    <div style={{ 
                      border: '1px solid #d9d9d9',
                      borderRadius: 6,
                      padding: 12,
                      backgroundColor: '#fafafa',
                      maxHeight: 120,
                      overflowY: 'auto'
                    }}>
                      <Space direction="vertical" style={{ width: '100%' }}>
                        {models.map((model) => (
                          <div key={model.id} style={{ 
                            display: 'flex', 
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '4px 0'
                          }}>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontWeight: 500 }}>{model.config_name}</span>
                              <br />
                              <Text type="secondary" style={{ fontSize: '12px' }}>
                                {model.model_name} - {model.api_base_url}
                              </Text>
                            </div>
                            <Switch
                              checked={model.selected}
                              onChange={(checked) => updateModelSelection(model.id, checked)}
                              size="small"
                            />
                          </div>
                        ))}
                      </Space>
                    </div>
                  )}
                  {models.filter(m => m.selected).length > 0 && (
                    <Text style={{ fontSize: '12px', color: '#1890ff' }}>
                      {t('onlineTest.selectedModels', { count: models.filter(m => m.selected).length })}
                    </Text>
                  )}
                </div>
              )}

              <Space>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={runTest}
                  loading={loading}
                  size="large"
                >
                  {t('onlineTest.runTest')}
                </Button>
                <Button
                  icon={<ClearOutlined />}
                  onClick={clearInput}
                  size="large"
                >
                  {t('onlineTest.clear')}
                </Button>
              </Space>
            </Space>
          </Card>

          {/* Test Result */}
          {testResult && (
            <Card title={t('onlineTest.testResult')} style={{ marginTop: 24 }}>
              <Spin spinning={loading}>
                <Space direction="vertical" style={{ width: '100%' }} size="large">
                  {/* Guardrail detection result */}
                  <div>
                    <Title level={4}>{t('onlineTest.guardrailResult')}</Title>

                    {/* If there's an error message, display error first */}
                    {testResult.guardrail.error ? (
                      <Alert
                        message={t('onlineTest.detectionFailed')}
                        description={
                          <div>
                            <Text strong>{t('onlineTest.failureReason')}</Text>
                            <br />
                            <Text>{testResult.guardrail.error}</Text>
                          </div>
                        }
                        type="error"
                        showIcon
                        style={{ marginBottom: 16 }}
                      />
                    ) : (
                      <>
                        <Row gutter={16}>
                          <Col span={8}>
                            <Card size="small" title={t('onlineTest.securityRisk')}>
                              <Space direction="vertical">
                                <div>
                                  <Text>{t('onlineTest.riskLevel')} </Text>
                                  <Tag color={getRiskColor(testResult.guardrail.security?.risk_level)}>
                                    {translateRiskLevel(testResult.guardrail.security?.risk_level || 'no_risk')}
                                  </Tag>
                                </div>
                                {testResult.guardrail.security?.categories?.length > 0 && (
                                  <div>
                                    <Text>{t('onlineTest.riskCategory')} </Text>
                                    {testResult.guardrail.security.categories.map((cat, idx) => (
                                      <Tag key={idx} color="red">{cat}</Tag>
                                    ))}
                                  </div>
                                )}
                              </Space>
                            </Card>
                          </Col>
                          <Col span={8}>
                            <Card size="small" title={t('onlineTest.complianceRisk')}>
                              <Space direction="vertical">
                                <div>
                                  <Text>{t('onlineTest.riskLevel')} </Text>
                                  <Tag color={getRiskColor(testResult.guardrail.compliance?.risk_level)}>
                                    {translateRiskLevel(testResult.guardrail.compliance?.risk_level || 'no_risk')}
                                  </Tag>
                                </div>
                                {testResult.guardrail.compliance?.categories?.length > 0 && (
                                  <div>
                                    <Text>{t('onlineTest.riskCategory')} </Text>
                                    {testResult.guardrail.compliance.categories.map((cat, idx) => (
                                      <Tag key={idx} color="orange">{cat}</Tag>
                                    ))}
                                  </div>
                                )}
                              </Space>
                            </Card>
                          </Col>
                          <Col span={8}>
                            <Card size="small" title={t('onlineTest.dataLeak')}>
                              <Space direction="vertical">
                                <div>
                                  <Text>{t('onlineTest.riskLevel')} </Text>
                                  <Tag color={getRiskColor(testResult.guardrail.data?.risk_level || 'no_risk')}>
                                    {translateRiskLevel(testResult.guardrail.data?.risk_level || 'no_risk')}
                                  </Tag>
                                </div>
                                {testResult.guardrail.data?.categories && testResult.guardrail.data.categories.length > 0 && (
                                  <div>
                                    <Text>{t('onlineTest.riskCategory')} </Text>
                                    {testResult.guardrail.data.categories.map((cat, idx) => (
                                      <Tag key={idx} color="purple">{cat}</Tag>
                                    ))}
                                  </div>
                                )}
                              </Space>
                            </Card>
                          </Col>
                        </Row>

                        <Divider />

                        <Row gutter={16}>
                          <Col span={8}>
                            <Text>{t('onlineTest.overallRiskLevel')} </Text>
                            <Tag color={getRiskColor(testResult.guardrail.overall_risk_level)}>
                              <strong>{translateRiskLevel(testResult.guardrail.overall_risk_level)}</strong>
                            </Tag>
                          </Col>
                          <Col span={8}>
                            <Text>{t('onlineTest.suggestedAction')} </Text>
                            <Tag color={getActionColor(testResult.guardrail.suggest_action)}>
                              <strong>{testResult.guardrail.suggest_action}</strong>
                            </Tag>
                          </Col>
                          <Col span={8}>
                            {testResult.guardrail.suggest_answer && (
                              <div>
                                <Text>{t('onlineTest.suggestedAnswer')} </Text>
                                <Text code>{testResult.guardrail.suggest_answer}</Text>
                              </div>
                            )}
                          </Col>
                        </Row>
                      </>
                    )}
                  </div>

                  {/* Proxy model original response results - only shown for single question type */}
                  {inputType === 'question' && Object.keys(testResult.original_responses).length > 0 && (
                    <div>
                      <Title level={4}>{t('onlineTest.proxyModelOriginalResponse')}</Title>
                      <Alert
                        message={t('onlineTest.proxyModelOriginalResponseDesc')}
                        type="info"
                        style={{ marginBottom: 16 }}
                        showIcon
                      />
                      {Object.entries(testResult.original_responses).map(([modelId, response]) => {
                        const model = models.find(m => m.id === modelId);
                        return (
                          <Card key={modelId} size="small" title={model?.config_name || `Model ${modelId}`} style={{ marginBottom: 8 }}>
                            {response.error ? (
                              <Alert message={response.error} type="error" />
                            ) : response.content ? (
                              <div>
                                <Text strong>{t('onlineTest.originalResponse')}</Text>
                                <br />
                                <div style={{
                                  backgroundColor: '#f8f9fa',
                                  padding: '12px',
                                  borderRadius: '6px',
                                  marginTop: '8px',
                                  border: '1px solid #e9ecef',
                                  whiteSpace: 'pre-wrap'
                                }}>
                                  <Text>{response.content}</Text>
                                </div>
                              </div>
                            ) : (
                              <Text type="secondary">{t('onlineTest.emptyResponse')}</Text>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  )}

                  {/* Model response results */}
                  {Object.keys(testResult.models).length > 0 && (
                    <div>
                      <Title level={4}>{t('onlineTest.proxyModelProtectedResponse')}</Title>
                      {Object.entries(testResult.models).map(([modelId, response]) => {
                        const model = models.find(m => m.id === modelId);
                        return (
                          <Card key={modelId} size="small" title={model?.config_name || `Model ${modelId}`} style={{ marginBottom: 8 }}>
                            {response.error ? (
                              <Alert message={response.error} type="error" />
                            ) : response.content ? (
                              <div>
                                <Text strong>{t('onlineTest.modelResponse')}</Text>
                                <br />
                                <div style={{
                                  backgroundColor: '#f8f9fa',
                                  padding: '12px',
                                  borderRadius: '6px',
                                  marginTop: '8px',
                                  border: '1px solid #e9ecef',
                                  whiteSpace: 'pre-wrap'
                                }}>
                                  <Text>{response.content}</Text>
                                </div>
                              </div>
                            ) : (
                              <Text type="secondary">{t('onlineTest.emptyResponse')}</Text>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </Space>
              </Spin>
            </Card>
          )}
        </Col>

        {/* Right side: Preset test cases */}
        <Col span={8}>
          <Card title={t('onlineTest.presetTestCases')} size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              {testCases.map((testCase) => (
                <Card
                  key={testCase.id}
                  size="small"
                  hoverable
                  onClick={() => useTestCase(testCase)}
                  style={{ cursor: 'pointer' }}
                  styles={{ body: { padding: 12 } }}
                >
                  <Space direction="vertical" size="small" style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text strong>{testCase.name}</Text>
                      <Tag color={testCase.type === 'question' ? 'blue' : 'purple'}>
                        {testCase.type === 'question' ? t('onlineTest.question') : t('onlineTest.qaPair')}
                      </Tag>
                    </div>
                    <Text type="secondary" style={{ fontSize: '12px' }}>
                      {testCase.description}
                    </Text>
                    <Text
                      style={{
                        fontSize: '12px',
                        backgroundColor: '#f5f5f5',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        display: 'block'
                      }}
                    >
                      {testCase.content.length > 50
                        ? testCase.content.substring(0, 50) + '...'
                        : testCase.content
                      }
                    </Text>
                    <Tag color={getRiskColor(testCase.expectedRisk || '')}>
                      {t('onlineTest.expected')} {testCase.expectedRisk}
                    </Tag>
                  </Space>
                </Card>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>

    </div>
  );
};

export default OnlineTest;