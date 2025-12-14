import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Button, Divider, Collapse, Tag, Alert, Anchor } from 'antd';
import { BookOutlined, ApiOutlined, RocketOutlined, SettingOutlined, SafetyCertificateOutlined, CodeOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authService, UserInfo } from '../../services/auth';
import { getSystemConfig } from '../../config';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

// Get base URL from import.meta.env or default to /platform/
const BASE_URL = import.meta.env.BASE_URL || '/platform/';

const Documentation: React.FC = () => {
  const { t } = useTranslation();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [apiDomain, setApiDomain] = useState<string>('http://localhost:5001');

  useEffect(() => {
    const fetchMe = async () => {
      try {
        const me = await authService.getCurrentUser();
        setUser(me);
      } catch (e) {
        console.error('Failed to fetch user info', e);
      }
    };
    fetchMe();

    // Get API domain from system config
    try {
      const config = getSystemConfig();
      setApiDomain(config.apiDomain);
    } catch (e) {
      console.error('Failed to get system config', e);
    }
  }, []);

  return (
    <div style={{ display: 'flex', gap: 24 }}>
      {/* Left sidebar - Table of Contents */}
      <Card style={{ width: 240, height: 'fit-content', position: 'sticky', top: 24 }}>
        <Anchor
          affix={false}
          items={[
            {
              key: 'quick-start',
              href: '#quick-start',
              title: t('docs.quickStart'),
              children: [
                { key: 'application-management', href: '#application-management', title: t('docs.applicationManagement') },
                { key: 'quick-test', href: '#quick-test', title: t('docs.quickTest') },
                { key: 'api-usage', href: '#api-usage', title: t('docs.apiUsage') },
                { key: 'gateway-usage', href: '#gateway-usage', title: t('docs.gatewayUsage') },
                { key: 'dify-integration', href: '#dify-integration', title: t('docs.difyIntegration') },
                { key: 'n8n-integration', href: '#n8n-integration', title: t('docs.n8nIntegration') },
                { key: 'protection-config', href: '#protection-config', title: t('docs.protectionConfig') },
              ],
            },
            {
              key: 'api-reference',
              href: '#api-reference',
              title: t('docs.apiReference'),
              children: [
                { key: 'api-overview', href: '#api-overview', title: t('docs.apiOverview') },
                { key: 'api-authentication', href: '#api-authentication', title: t('docs.apiAuthentication') },
                { key: 'api-endpoints', href: '#api-endpoints', title: t('docs.apiEndpoints') },
                { key: 'api-errors', href: '#api-errors', title: t('docs.apiErrors') },
              ],
            },
            {
              key: 'detailed-guide',
              href: '#detailed-guide',
              title: t('docs.detailedGuide'),
              children: [
                { key: 'detection-capabilities', href: '#detection-capabilities', title: t('docs.detectionCapabilities') },
                { key: 'usage-modes', href: '#usage-modes', title: t('docs.usageModes') },
                { key: 'client-libraries', href: '#client-libraries', title: t('docs.clientLibraries') },
                { key: 'multimodal-detection', href: '#multimodal-detection', title: t('docs.multimodalDetection') },
                { key: 'data-leak-detection', href: '#data-leak-detection', title: t('docs.dataLeakDetection') },
                { key: 'ban-policy', href: '#ban-policy', title: t('docs.banPolicy') },
                { key: 'knowledge-base', href: '#knowledge-base', title: t('docs.knowledgeBase') },
                { key: 'sensitivity-config', href: '#sensitivity-config', title: t('docs.sensitivityConfig') },
              ],
            },
          ]}
        />
      </Card>

      {/* Main content */}
      <Card style={{ flex: 1 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Header */}
          <Space align="center">
            <BookOutlined style={{ fontSize: 32, color: '#1890ff' }} />
            <Title level={2} style={{ margin: 0 }}>{t('docs.title')}</Title>
          </Space>

          <Divider />

          {/* Quick Start Section */}
          <div id="quick-start">
            <Space align="center" style={{ marginBottom: 16 }}>
              <RocketOutlined style={{ fontSize: 24, color: '#52c41a' }} />
              <Title level={3} style={{ margin: 0 }}>{t('docs.quickStart')}</Title>
            </Space>

            {/* Application Management */}
            <div id="application-management" style={{ marginTop: 24 }}>
              <Title level={4}>{t('docs.applicationManagement')}</Title>
              <Paragraph>
                {t('docs.applicationManagementDesc')}
              </Paragraph>

              <Alert
                message={t('docs.applicationManagementFeature')}
                description={t('docs.applicationManagementFeatureDesc')}
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.applicationUseCases')}:</Text>
                <ul style={{ marginTop: 8 }}>
                  <li>{t('docs.applicationUseCase1')}</li>
                  <li>{t('docs.applicationUseCase2')}</li>
                  <li>{t('docs.applicationUseCase3')}</li>
                  <li>{t('docs.applicationUseCase4')}</li>
                </ul>
              </div>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.applicationIsolation')}:</Text>
                <ul style={{ marginTop: 8 }}>
                  <li>{t('docs.applicationIsolation1')}</li>
                  <li>{t('docs.applicationIsolation2')}</li>
                  <li>{t('docs.applicationIsolation3')}</li>
                  <li>{t('docs.applicationIsolation4')}</li>
                  <li>{t('docs.applicationIsolation5')}</li>
                  <li>{t('docs.applicationIsolation6')}</li>
                </ul>
              </div>

              <Alert
                message={t('docs.applicationManagementTip')}
                description={t('docs.applicationManagementTipDesc')}
                type="info"
                showIcon
                style={{ marginTop: 16 }}
              />
            </div>

            {/* Quick Test */}
            <div id="quick-test" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.quickTest')}</Title>
              <Paragraph>
                {t('docs.quickTestDesc')}
              </Paragraph>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.quickTestMacLinux')}:</Text>
                <pre style={{
                  backgroundColor: '#f6f8fa',
                  padding: 16,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                  marginTop: 8
                }}>
{`curl -X POST "${apiDomain}/v1/guardrails" \\
  -H "Authorization: Bearer ${user?.api_key || 'your-api-key'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "OpenGuardrails-Text",
    "messages": [
      {"role": "user", "content": "How to make a bomb?"}
    ]
  }'`}
                </pre>
              </div>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.quickTestWindows')}:</Text>
                <pre style={{
                  backgroundColor: '#f6f8fa',
                  padding: 16,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                  marginTop: 8
                }}>
{`curl.exe -X POST "${apiDomain}/v1/guardrails" \`
  -H "Authorization: Bearer ${user?.api_key || 'your-api-key'}" \`
  -H "Content-Type: application/json" \`
  -d '{"model": "OpenGuardrails-Text", "messages": [{"role": "user", "content": "How to make a bomb?"}]}'`}
                </pre>
              </div>
            </div>

            {/* API Usage */}
            <div id="api-usage" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.apiUsage')}</Title>
              <Paragraph>
                {t('docs.apiUsageDesc')}
              </Paragraph>

              <Alert
                message={t('docs.getApiKeyTip')}
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <Text strong>{t('docs.pythonExample')}:</Text>
              <pre style={{
                backgroundColor: '#f6f8fa',
                padding: 16,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8
              }}>
{`# 1. Install client library
pip install openguardrails

# 2. Use the library
from openguardrails import OpenGuardrails

client = OpenGuardrails("${user?.api_key || 'your-api-key'}")

# Single-turn detection
response = client.check_prompt("Teach me how to make a bomb")
if response.suggest_action == "pass":
    print("Safe")
else:
    print(f"Unsafe: {response.suggest_answer}")
`}
              </pre>
            </div>

            {/* Gateway Usage */}
            <div id="gateway-usage" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.gatewayUsage')}</Title>
              <Paragraph>
                {t('docs.gatewayUsageDesc')}
              </Paragraph>

              <Alert
                message={t('docs.gatewayBenefit')}
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <Text strong>{t('docs.gatewayExample')}:</Text>
              <pre style={{
                backgroundColor: '#f6f8fa',
                padding: 16,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8
              }}>
{`from openai import OpenAI

# Just change base_url and api_key
client = OpenAI(
    base_url="${apiDomain}/v1/gateway/<upstream_api_id>/",
    api_key="${user?.api_key || 'your-api-key'}"
)

# Use as normal - automatic safety protection!
# No need to change the model name - use your original upstream model name
response = client.chat.completions.create(
    model="gpt-4",  # Your original upstream model name
    messages=[{"role": "user", "content": "Hello"}]
)

# Note: For private deployment, the API domain is automatically configured
`}
              </pre>

              <Alert
                message={t('docs.gatewayResponseHandling')}
                description={t('docs.gatewayResponseHandlingDesc')}
                type="warning"
                showIcon
                style={{ marginTop: 16, marginBottom: 16 }}
              />

              <Text strong>{t('docs.gatewayResponseExample')}:</Text>
              <pre style={{
                backgroundColor: '#f6f8fa',
                padding: 16,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8
              }}>
{`from openai import OpenAI

client = OpenAI(
    base_url="${apiDomain}/v1/gateway/<upstream_api_id>/",
    api_key="${user?.api_key || 'your-api-key'}"
)

def chat_with_openai(prompt, model="gpt-4", system="You are a helpful assistant."):
    completion = client.chat.completions.create(
        model=model,  # Use your original upstream model name
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ]
    )

    # IMPORTANT: Check finish_reason first!
    # When content is blocked or replaced, finish_reason will be 'content_filter'
    # In this case, reasoning_content may not exist
    if completion.choices[0].finish_reason == 'content_filter':
        # Blocked/replaced content - only message.content is available
        return "", completion.choices[0].message.content
    else:
        # Normal response - both reasoning_content and content may be available
        reasoning = completion.choices[0].message.reasoning_content or ""
        content = completion.choices[0].message.content
        return reasoning, content

# Example usage
thinking, result = chat_with_openai("How to make a bomb?")
print("Thinking:", thinking)
print("Result:", result)
# Output: Result: "I'm sorry, I can't answer questions involving violent crime."

# Note: For private deployment, the API domain is automatically configured
`}
              </pre>
            </div>

            {/* Dify Integration */}
            <div id="dify-integration" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.difyIntegration')}</Title>
              <Paragraph>
                {t('docs.difyIntegrationDesc')}
              </Paragraph>

              <div style={{ textAlign: 'center', marginTop: 16, marginBottom: 16 }}>
                <img
                  src={`${BASE_URL}dify-moderation.png`}
                  alt="Dify Moderation"
                  style={{
                    maxWidth: '60%',
                    height: 'auto',
                    borderRadius: 8,
                    border: '1px solid #f0f0f0',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                  }}
                />
              </div>

              <Paragraph>
                {t('docs.difyModerationOptions')}
              </Paragraph>

              <ol style={{ marginTop: 8 }}>
                <li>
                  <Text strong>{t('docs.difyOpenAIModeration')}</Text> — {t('docs.difyOpenAIModerationDesc')}
                </li>
                <li>
                  <Text strong>{t('docs.difyCustomKeywords')}</Text> — {t('docs.difyCustomKeywordsDesc')}
                </li>
                <li>
                  <Text strong>{t('docs.difyApiExtension')}</Text> — {t('docs.difyApiExtensionDesc')}
                </li>
              </ol>

              <div style={{ textAlign: 'center', marginTop: 16, marginBottom: 16 }}>
                <img
                  src={`${BASE_URL}dify-moderation-extension.png`}
                  alt="Dify Moderation API Extension"
                  style={{
                    maxWidth: '60%',
                    height: 'auto',
                    borderRadius: 8,
                    border: '1px solid #f0f0f0',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                  }}
                />
              </div>

              <div style={{ marginTop: 24 }}>
                <Text strong style={{ fontSize: 16 }}>{t('docs.difyAddExtension')}</Text>
                <ol style={{ marginTop: 12 }}>
                  <li>
                    <Text strong>{t('docs.difyStep1Title')}</Text>
                    <br />
                    <Text>{t('docs.difyStep1NewDesc')}</Text>
                  </li>
                  <li style={{ marginTop: 12 }}>
                    <Text strong>{t('docs.difyStep2Title')}</Text>
                    <br />
                    <Text>{t('docs.difyStep2NewDesc')}</Text>
                    <pre style={{
                      backgroundColor: '#f6f8fa',
                      padding: 12,
                      borderRadius: 6,
                      marginTop: 8,
                      fontSize: 13
                    }}>
{`${apiDomain}/v1/dify/moderation`}
                    </pre>
                  </li>
                  <li style={{ marginTop: 12 }}>
                    <Text strong>{t('docs.difyStep3NewTitle')}</Text>
                    <br />
                    <Text>{t('docs.difyStep3NewDesc1')} </Text>
                    <a href="https://openguardrails.com/platform/" target="_blank" rel="noopener noreferrer">
                      openguardrails.com
                    </a>
                    <Text>{t('docs.difyStep3NewDesc2')}</Text>
                    {user?.api_key && (
                      <div style={{ marginTop: 8 }}>
                        <Text>{t('docs.yourApiKey')}: </Text>
                        <Text code>{user.api_key}</Text>
                      </div>
                    )}
                  </li>
                </ol>
              </div>

              <Alert
                message={t('docs.difyIntegrationBenefit')}
                type="success"
                showIcon
                style={{ marginTop: 24, marginBottom: 16 }}
              />

              <div style={{ marginTop: 16, padding: 16, backgroundColor: '#f6f8fa', borderRadius: 6 }}>
                <Text strong>{t('docs.difyAdvantages')}:</Text>
                <ul style={{ marginTop: 8, marginBottom: 0 }}>
                  <li>{t('docs.difyAdvantage1')}</li>
                  <li>{t('docs.difyAdvantage2')}</li>
                  <li>{t('docs.difyAdvantage3')}</li>
                  <li>{t('docs.difyAdvantage4')}</li>
                  <li>{t('docs.difyAdvantage5')}</li>
                </ul>
              </div>
            </div>

            {/* n8n Integration */}
            <div id="n8n-integration" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.n8nIntegration')}</Title>
              <Paragraph>
                {t('docs.n8nIntegrationDesc')}
              </Paragraph>

              {/* Step 1: Create Credential */}
              <div style={{ marginTop: 24 }}>
                <Text strong style={{ fontSize: 16 }}>{t('docs.n8nCreateCredential')}</Text>
                <Paragraph style={{ marginTop: 8 }}>
                  {t('docs.n8nCreateCredentialDesc')}
                </Paragraph>

                <ol style={{ marginTop: 12 }}>
                  <li style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.n8nCredentialStep1')}</Text>
                    <br />
                    <Text>{t('docs.n8nCredentialStep1Desc')}</Text>
                    <div style={{ textAlign: 'center', marginTop: 8 }}>
                      <img
                        src={`${BASE_URL}n8n-1.png`}
                        alt="n8n Create Credential"
                        style={{
                          maxWidth: '60%',
                          height: 'auto',
                          borderRadius: 8,
                          border: '1px solid #f0f0f0',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                      />
                    </div>
                  </li>

                  <li style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.n8nCredentialStep2')}</Text>
                    <br />
                    <Text>{t('docs.n8nCredentialStep2Desc')}</Text>
                    <div style={{ textAlign: 'center', marginTop: 8 }}>
                      <img
                        src={`${BASE_URL}n8n-2.png`}
                        alt="n8n Select Bearer Auth"
                        style={{
                          maxWidth: '60%',
                          height: 'auto',
                          borderRadius: 8,
                          border: '1px solid #f0f0f0',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                      />
                    </div>
                  </li>

                  <li style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.n8nCredentialStep3')}</Text>
                    <br />
                    <Text>{t('docs.n8nCredentialStep3Desc')}</Text>
                    <div style={{ textAlign: 'center', marginTop: 8 }}>
                      <img
                        src={`${BASE_URL}n8n-3.png`}
                        alt="OpenGuardrails Application Management"
                        style={{
                          maxWidth: '80%',
                          height: 'auto',
                          borderRadius: 8,
                          border: '1px solid #f0f0f0',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                      />
                    </div>
                  </li>

                  <li style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.n8nCredentialStep4')}</Text>
                    <br />
                    <Text>{t('docs.n8nCredentialStep4Desc')}</Text>
                    <div style={{ textAlign: 'center', marginTop: 8 }}>
                      <img
                        src={`${BASE_URL}n8n-4.png`}
                        alt="Copy API Key"
                        style={{
                          maxWidth: '80%',
                          height: 'auto',
                          borderRadius: 8,
                          border: '1px solid #f0f0f0',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                      />
                    </div>
                  </li>

                  <li style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.n8nCredentialStep5')}</Text>
                    <br />
                    <Text>{t('docs.n8nCredentialStep5Desc')}</Text>
                    <div style={{ textAlign: 'center', marginTop: 8 }}>
                      <img
                        src={`${BASE_URL}n8n-5.png`}
                        alt="Paste API Key in n8n"
                        style={{
                          maxWidth: '80%',
                          height: 'auto',
                          borderRadius: 8,
                          border: '1px solid #f0f0f0',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                      />
                    </div>
                  </li>

                  <li style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.n8nCredentialStep6')}</Text>
                    <br />
                    <Text>{t('docs.n8nCredentialStep6Desc')}</Text>
                    <div style={{ textAlign: 'center', marginTop: 8 }}>
                      <img
                        src={`${BASE_URL}n8n-6.png`}
                        alt="Credential Created"
                        style={{
                          maxWidth: '80%',
                          height: 'auto',
                          borderRadius: 8,
                          border: '1px solid #f0f0f0',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                        }}
                      />
                    </div>
                  </li>
                </ol>
              </div>

              {/* Step 2: Choose Integration Method */}
              <Alert
                message={t('docs.n8nTwoMethods')}
                description={t('docs.n8nTwoMethodsDesc')}
                type="info"
                showIcon
                style={{ marginTop: 24, marginBottom: 16 }}
              />

              <div style={{ marginTop: 24 }}>
                <Text strong style={{ fontSize: 16 }}>{t('docs.n8nMethod1')}</Text>

                <div style={{ marginTop: 12 }}>
                  <Text strong>{t('docs.n8nMethod1Installation')}:</Text>
                  <ol style={{ marginTop: 8 }}>
                    <li>{t('docs.n8nMethod1InstallStep1')}</li>
                    <li>{t('docs.n8nMethod1InstallStep2')}</li>
                    <li>{t('docs.n8nMethod1InstallStep3')}</li>
                  </ol>
                </div>

                <div style={{ marginTop: 12 }}>
                  <Text strong>{t('docs.n8nMethod1Features')}:</Text>
                  <ul style={{ marginTop: 8 }}>
                    <li>{t('docs.n8nMethod1Feature1')}</li>
                    <li>{t('docs.n8nMethod1Feature2')}</li>
                    <li>{t('docs.n8nMethod1Feature3')}</li>
                    <li>{t('docs.n8nMethod1Feature4')}</li>
                  </ul>
                </div>

                <div style={{ marginTop: 16, padding: 16, backgroundColor: '#f6f8fa', borderRadius: 6 }}>
                  <Text strong>{t('docs.n8nExampleWorkflow')}:</Text>
                  <pre style={{ marginTop: 8, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
{t('docs.n8nExampleStep1')}
{t('docs.n8nExampleStep2')}
{t('docs.n8nExampleStep3')}
{t('docs.n8nExampleStep3Yes')}
{t('docs.n8nExampleStep3No')}
{t('docs.n8nExampleStep4')}
{t('docs.n8nExampleStep5')}
{t('docs.n8nExampleStep6')}
{t('docs.n8nExampleStep6Yes')}
{t('docs.n8nExampleStep6No')}
                  </pre>
                </div>

                <div style={{ marginTop: 12 }}>
                  <Text strong>{t('docs.n8nDetectionOptions')}:</Text>
                  <ul style={{ marginTop: 8 }}>
                    <li>{t('docs.n8nDetectionOption1')}</li>
                    <li>{t('docs.n8nDetectionOption2')}</li>
                    <li>{t('docs.n8nDetectionOption3')}</li>
                    <li>{t('docs.n8nDetectionOption4')}</li>
                  </ul>
                </div>
              </div>

              <div style={{ marginTop: 24 }}>
                <Text strong style={{ fontSize: 16 }}>{t('docs.n8nMethod2')}</Text>
                <Paragraph style={{ marginTop: 8 }}>
                  {t('docs.n8nMethod2Desc')}
                </Paragraph>

                <Text strong>{t('docs.n8nMethod2SetupSteps')}:</Text>
                <ul style={{ marginTop: 12 }}>
                  <li>{t('docs.n8nMethod2Step1')}</li>
                  <li>{t('docs.n8nMethod2Step2Method')}</li>
                  <li>{t('docs.n8nMethod2Step2Url')}</li>
                  <li>{t('docs.n8nMethod2Step2Auth')}</li>
                </ul>

                <div style={{ marginTop: 16 }}>
                  <Text strong>{t('docs.n8nMethod2RequestBody')}:</Text>
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 12,
                    borderRadius: 6,
                    marginTop: 8,
                    fontSize: 13
                  }}>
{`{
  "model": "OpenGuardrails-Text",
  "messages": [
    {
      "role": "user",
      "content": "{{ $json.userInput }}"
    }
  ],
  "enable_security": true,
  "enable_compliance": true,
  "enable_data_security": true
}`}
                  </pre>
                </div>

                <Alert
                  message={t('docs.n8nImportWorkflows')}
                  description={t('docs.n8nImportWorkflowsDesc')}
                  type="success"
                  showIcon
                  style={{ marginTop: 16 }}
                />
              </div>
            </div>

            {/* Protection Configuration */}
            <div id="protection-config" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.protectionConfig')}</Title>
              <Paragraph>
                {t('docs.protectionConfigDesc')}
              </Paragraph>

              <ul>
                <li><Text strong>{t('docs.riskTypeConfig')}:</Text> {t('docs.riskTypeConfigDesc')}</li>
                <li><Text strong>{t('docs.blacklistWhitelist')}:</Text> {t('docs.blacklistWhitelistDesc')}</li>
                <li><Text strong>{t('docs.responseTemplates')}:</Text> {t('docs.responseTemplatesDesc')}</li>
                <li><Text strong>{t('docs.sensitivityThreshold')}:</Text> {t('docs.sensitivityThresholdDesc')}</li>
              </ul>
            </div>
          </div>

          <Divider />

          {/* API Reference Section */}
          <div id="api-reference">
            <Space align="center" style={{ marginBottom: 16 }}>
              <ApiOutlined style={{ fontSize: 24, color: '#722ed1' }} />
              <Title level={3} style={{ margin: 0 }}>{t('docs.apiReference')}</Title>
            </Space>

            {/* API Overview */}
            <div id="api-overview" style={{ marginTop: 24 }}>
              <Title level={4}>{t('docs.apiOverview')}</Title>
              <Paragraph>{t('docs.apiOverviewDesc')}</Paragraph>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.service')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.port')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.purpose')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="blue">{t('docs.adminService')}</Tag></td>
                    <td style={{ padding: 12 }}><Text code>5000</Text></td>
                    <td style={{ padding: 12 }}>{t('docs.adminServiceDesc')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="green">{t('docs.detectionService')}</Tag></td>
                    <td style={{ padding: 12 }}><Text code>5001</Text></td>
                    <td style={{ padding: 12 }}>{t('docs.detectionServiceDesc')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="purple">{t('docs.proxyService')}</Tag></td>
                    <td style={{ padding: 12 }}><Text code>5002</Text></td>
                    <td style={{ padding: 12 }}>{t('docs.proxyServiceDesc')}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* API Authentication */}
            <div id="api-authentication" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.apiAuthentication')}</Title>
              <Paragraph>{t('docs.apiAuthenticationDesc')}</Paragraph>

              <Alert
                message={t('docs.apiKeyLocation')}
                description={t('docs.apiKeyLocationDesc')}
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <Text strong>{t('docs.authenticationExample')}:</Text>
              <pre style={{
                backgroundColor: '#f6f8fa',
                padding: 16,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8
              }}>
{`# Using cURL
curl -X POST "${apiDomain}/v1/guardrails" \\
  -H "Authorization: Bearer ${user?.api_key || 'your-api-key'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "OpenGuardrails-Text",
    "messages": [
      {"role": "user", "content": "Test content"}
    ]
  }'

# Using Python requests
import requests

headers = {
    "Authorization": "Bearer ${user?.api_key || 'your-api-key'}",
    "Content-Type": "application/json"
}

response = requests.post(
    "${apiDomain}/v1/guardrails",
    headers=headers,
    json={
        "model": "OpenGuardrails-Text",
        "messages": [{"role": "user", "content": "Test content"}]
    }
)

# Note: For private deployment, the API domain is automatically configured
`}
              </pre>
            </div>

            {/* API Endpoints */}
            <div id="api-endpoints" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.apiEndpoints')}</Title>
              <Paragraph>{t('docs.apiEndpointsDesc')}</Paragraph>

              <Collapse ghost style={{ marginTop: 16 }}>
                <Panel header={
                  <Space>
                    <Tag color="green">POST</Tag>
                    <Text strong>/v1/guardrails</Text>
                    <Text type="secondary">- {t('docs.guardrailsEndpointDesc')}</Text>
                  </Space>
                } key="guardrails">
                  <div style={{ marginBottom: 16 }}>
                    <Text strong>{t('docs.requestBody')}:</Text>
                    <pre style={{
                      backgroundColor: '#f6f8fa',
                      padding: 16,
                      borderRadius: 6,
                      overflow: 'auto',
                      fontSize: 13,
                      lineHeight: 1.5,
                      marginTop: 8
                    }}>
{`{
  "model": "optional-model-name",
  "messages": [
    {
      "role": "user",
      "content": "User message content"
    },
    {
      "role": "assistant",
      "content": "Assistant response"
    }
  ],
  "skip_input_guardrails": false,
  "skip_output_guardrails": false
}`}
                    </pre>
                  </div>

                  <div>
                    <Text strong>{t('docs.responseExample')}:</Text>
                    <pre style={{
                      backgroundColor: '#f6f8fa',
                      padding: 16,
                      borderRadius: 6,
                      overflow: 'auto',
                      fontSize: 13,
                      lineHeight: 1.5,
                      marginTop: 8
                    }}>
{`{
  "id": "det_xxxxxxxx",
  "result": {
    "compliance": {
      "risk_level": "high_risk",
      "categories": ["Violent Crime"],
      "score": 0.85
    },
    "security": {
      "risk_level": "no_risk",
      "categories": [],
      "score": 0.12
    },
    "data": {
      "risk_level": "no_risk",
      "categories": [],
      "entities": [],
      "score": 0.00
    }
  },
  "overall_risk_level": "high_risk",
  "suggest_action": "Decline",
  "suggest_answer": "Sorry, I cannot answer questions involving violent crime.",
  "score": 0.85
}`}
                    </pre>
                  </div>
                </Panel>

                <Panel header={
                  <Space>
                    <Tag color="green">POST</Tag>
                    <Text strong>/v1/guardrails/input</Text>
                    <Text type="secondary">- {t('docs.inputEndpointDesc')}</Text>
                  </Space>
                } key="input">
                  <Text>{t('docs.inputEndpointDetail')}</Text>
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginTop: 8
                  }}>
{`{
  "input": "User input text to detect",
  "model": "optional-model-name"
}`}
                  </pre>
                </Panel>

                <Panel header={
                  <Space>
                    <Tag color="green">POST</Tag>
                    <Text strong>/v1/guardrails/output</Text>
                    <Text type="secondary">- {t('docs.outputEndpointDesc')}</Text>
                  </Space>
                } key="output">
                  <Text>{t('docs.outputEndpointDetail')}</Text>
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginTop: 8
                  }}>
{`{
  "output": "Model output text to detect",
  "model": "optional-model-name"
}`}
                  </pre>
                </Panel>

                <Panel header={
                  <Space>
                    <Tag color="blue">GET</Tag>
                    <Text strong>/api/v1/dashboard/stats</Text>
                    <Text type="secondary">- {t('docs.statsEndpointDesc')}</Text>
                  </Space>
                } key="stats">
                  <Text>{t('docs.statsEndpointDetail')}</Text>
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginTop: 8
                  }}>
{`{
  "total_detections": 12450,
  "total_blocked": 342,
  "total_passed": 12108,
  "risk_distribution": {
    "no_risk": 11850,
    "low_risk": 258,
    "medium_risk": 180,
    "high_risk": 162
  }
}`}
                  </pre>
                </Panel>
              </Collapse>
            </div>

            {/* API Error Handling */}
            <div id="api-errors" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.apiErrors')}</Title>
              <Paragraph>{t('docs.apiErrorsDesc')}</Paragraph>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.statusCode')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.meaning')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.commonCauses')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="green">200</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.status200')}</td>
                    <td style={{ padding: 12 }}>{t('docs.status200Cause')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="orange">400</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.status400')}</td>
                    <td style={{ padding: 12 }}>{t('docs.status400Cause')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="red">401</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.status401')}</td>
                    <td style={{ padding: 12 }}>{t('docs.status401Cause')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="red">403</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.status403')}</td>
                    <td style={{ padding: 12 }}>{t('docs.status403Cause')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="orange">429</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.status429')}</td>
                    <td style={{ padding: 12 }}>{t('docs.status429Cause')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}><Tag color="red">500</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.status500')}</td>
                    <td style={{ padding: 12 }}>{t('docs.status500Cause')}</td>
                  </tr>
                </tbody>
              </table>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.errorResponseFormat')}:</Text>
                <pre style={{
                  backgroundColor: '#f6f8fa',
                  padding: 16,
                  borderRadius: 6,
                  overflow: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                  marginTop: 8
                }}>
{`{
  "detail": "Error message description",
  "error_code": "ERROR_CODE",
  "status_code": 400
}`}
                </pre>
              </div>
            </div>
          </div>

          <Divider />

          {/* Detailed Guide Section */}
          <div id="detailed-guide">
            <Space align="center" style={{ marginBottom: 16 }}>
              <BookOutlined style={{ fontSize: 24, color: '#1890ff' }} />
              <Title level={3} style={{ margin: 0 }}>{t('docs.detailedGuide')}</Title>
            </Space>

            {/* Detection Capabilities */}
            <div id="detection-capabilities" style={{ marginTop: 24 }}>
              <Title level={4}>{t('docs.detectionCapabilities')}</Title>
              <Paragraph>{t('docs.detectionCapabilitiesDesc')}</Paragraph>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.category')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.riskLevel')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.examples')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.violenceCrime')}</td>
                    <td style={{ padding: 12 }}><Tag color="red">{t('docs.highRisk')}</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.violenceCrimeExample')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.promptAttack')}</td>
                    <td style={{ padding: 12 }}><Tag color="red">{t('docs.highRisk')}</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.promptAttackExample')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.illegalActivities')}</td>
                    <td style={{ padding: 12 }}><Tag color="orange">{t('docs.mediumRisk')}</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.illegalActivitiesExample')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.discrimination')}</td>
                    <td style={{ padding: 12 }}><Tag color="yellow">{t('docs.lowRisk')}</Tag></td>
                    <td style={{ padding: 12 }}>{t('docs.discriminationExample')}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Usage Modes */}
            <div id="usage-modes" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.usageModes')}</Title>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.apiCallMode')}:</Text>
                <Paragraph style={{ marginTop: 8 }}>
                  {t('docs.apiCallModeDesc')}
                </Paragraph>
                <ul>
                  <li>{t('docs.apiCallModeBenefit1')}</li>
                  <li>{t('docs.apiCallModeBenefit2')}</li>
                  <li>{t('docs.apiCallModeBenefit3')}</li>
                </ul>
              </div>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.securityGatewayMode')}:</Text>
                <Paragraph style={{ marginTop: 8 }}>
                  {t('docs.securityGatewayModeDesc')}
                </Paragraph>
                <ul>
                  <li>{t('docs.gatewayModeBenefit1')}</li>
                  <li>{t('docs.gatewayModeBenefit2')}</li>
                  <li>{t('docs.gatewayModeBenefit3')}</li>
                </ul>
              </div>
            </div>

            {/* Client Libraries */}
            <div id="client-libraries" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.clientLibraries')}</Title>
              <Paragraph>{t('docs.clientLibrariesDesc')}</Paragraph>

              <Collapse ghost>
                <Panel header={<Space><Tag color="blue">Python</Tag><Text>{t('docs.pythonClientDesc')}</Text></Space>} key="python">
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5
                  }}>
{`# Synchronous usage
from openguardrails import OpenGuardrails

client = OpenGuardrails("${user?.api_key || 'your-api-key'}")
response = client.check_prompt("test content")

# Asynchronous usage
import asyncio
from openguardrails import AsyncOpenGuardrails

async def main():
    async with AsyncOpenGuardrails("${user?.api_key || 'your-api-key'}") as client:
        response = await client.check_prompt("test content")

asyncio.run(main())
`}
                  </pre>
                </Panel>

                <Panel header={<Space><Tag color="green">Node.js</Tag><Text>{t('docs.nodejsClientDesc')}</Text></Space>} key="nodejs">
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5
                  }}>
{`const { OpenGuardrails } = require('openguardrails');

const client = new OpenGuardrails('${user?.api_key || 'your-api-key'}');

async function checkContent() {
    const response = await client.checkPrompt('test content');
    console.log(response.suggest_action);
}

checkContent();
`}
                  </pre>
                </Panel>

                <Panel header={<Space><Tag color="red">Java</Tag><Text>{t('docs.javaClientDesc')}</Text></Space>} key="java">
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5
                  }}>
{`import com.openguardrails.OpenGuardrails;
import com.openguardrails.model.CheckResponse;

public class Example {
    public static void main(String[] args) {
        OpenGuardrails client = new OpenGuardrails("${user?.api_key || 'your-api-key'}");
        CheckResponse response = client.checkPrompt("test content");
        System.out.println(response.getSuggestAction());
    }
}
`}
                  </pre>
                </Panel>

                <Panel header={<Space><Tag color="cyan">Go</Tag><Text>{t('docs.goClientDesc')}</Text></Space>} key="go">
                  <pre style={{
                    backgroundColor: '#f6f8fa',
                    padding: 16,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 13,
                    lineHeight: 1.5
                  }}>
{`package main

import (
    "fmt"
    "github.com/openguardrails/openguardrails-go"
)

func main() {
    client := openguardrails.NewClient("${user?.api_key || 'your-api-key'}")
    response, _ := client.CheckPrompt("test content")
    fmt.Println(response.SuggestAction)
}
`}
                  </pre>
                </Panel>
              </Collapse>
            </div>

            {/* Multimodal Detection */}
            <div id="multimodal-detection" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.multimodalDetection')}</Title>
              <Paragraph>{t('docs.multimodalDetectionDesc')}</Paragraph>

              <Alert
                message={t('docs.multimodalFeature')}
                description={t('docs.multimodalFeatureDesc')}
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <Text strong>{t('docs.imageDetectionExample')}:</Text>
              <pre style={{
                backgroundColor: '#f6f8fa',
                padding: 16,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8
              }}>
{`import base64
from openguardrails import OpenGuardrails

client = OpenGuardrails("${user?.api_key || 'your-api-key'}")

# Encode image to base64
with open("image.jpg", "rb") as f:
    image_base64 = base64.b64encode(f.read()).decode("utf-8")

# Check image safety
response = client.check_messages([
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "Is this image safe?"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}
            }
        ]
    }
])

print(f"Risk Level: {response.overall_risk_level}")
`}
              </pre>
            </div>

            {/* Data Leak Detection */}
            <div id="data-leak-detection" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.dataLeakDetection')}</Title>
              <Paragraph>{t('docs.dataLeakDetectionDesc')}</Paragraph>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.supportedDataTypes')}:</Text>
                <ul style={{ marginTop: 8 }}>
                  <li>{t('docs.dataTypeIdCard')}</li>
                  <li>{t('docs.dataTypePhone')}</li>
                  <li>{t('docs.dataTypeEmail')}</li>
                  <li>{t('docs.dataTypeBankCard')}</li>
                  <li>{t('docs.dataTypePassport')}</li>
                  <li>{t('docs.dataTypeIpAddress')}</li>
                </ul>
              </div>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.maskingMethods')}:</Text>
                <ul style={{ marginTop: 8 }}>
                  <li><Text code>Replace</Text>: {t('docs.maskingReplace')}</li>
                  <li><Text code>Mask</Text>: {t('docs.maskingMask')}</li>
                  <li><Text code>Hash</Text>: {t('docs.maskingHash')}</li>
                  <li><Text code>Encrypt</Text>: {t('docs.maskingEncrypt')}</li>
                </ul>
              </div>
            </div>

            {/* Ban Policy */}
            <div id="ban-policy" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.banPolicy')}</Title>
              <Paragraph>{t('docs.banPolicyDesc')}</Paragraph>

              <Alert
                message={t('docs.banPolicyFeature')}
                description={t('docs.banPolicyFeatureDesc')}
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.banPolicyConfig')}:</Text>
                <ul style={{ marginTop: 8 }}>
                  <li>{t('docs.banPolicyRiskLevel')}</li>
                  <li>{t('docs.banPolicyTriggerCount')}</li>
                  <li>{t('docs.banPolicyTimeWindow')}</li>
                  <li>{t('docs.banPolicyDuration')}</li>
                </ul>
              </div>
            </div>

            {/* Knowledge Base */}
            <div id="knowledge-base" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.knowledgeBase')}</Title>
              <Paragraph>{t('docs.knowledgeBaseDesc')}</Paragraph>

              <div style={{ marginTop: 16 }}>
                <Text strong>{t('docs.knowledgeBaseFeatures')}:</Text>
                <ul style={{ marginTop: 8 }}>
                  <li>{t('docs.knowledgeBaseFeature1')}</li>
                  <li>{t('docs.knowledgeBaseFeature2')}</li>
                  <li>{t('docs.knowledgeBaseFeature3')}</li>
                </ul>
              </div>

              <Text strong style={{ display: 'block', marginTop: 16 }}>{t('docs.knowledgeBaseFormat')}:</Text>
              <pre style={{
                backgroundColor: '#f6f8fa',
                padding: 16,
                borderRadius: 6,
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.5,
                marginTop: 8
              }}>
{`{"questionid": "q1", "question": "What is AI?", "answer": "AI is artificial intelligence..."}
{"questionid": "q2", "question": "How to protect privacy?", "answer": "Use encryption..."}`}
              </pre>
            </div>

            {/* Sensitivity Configuration */}
            <div id="sensitivity-config" style={{ marginTop: 32 }}>
              <Title level={4}>{t('docs.sensitivityConfig')}</Title>
              <Paragraph>{t('docs.sensitivityConfigDesc')}</Paragraph>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #f0f0f0' }}>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.sensitivityLevel')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.threshold')}</th>
                    <th style={{ padding: 12, textAlign: 'left' }}>{t('docs.useCase')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.highSensitivity')}</td>
                    <td style={{ padding: 12 }}>≥ 0.40</td>
                    <td style={{ padding: 12 }}>{t('docs.highSensitivityUse')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.mediumSensitivity')}</td>
                    <td style={{ padding: 12 }}>≥ 0.60</td>
                    <td style={{ padding: 12 }}>{t('docs.mediumSensitivityUse')}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: 12 }}>{t('docs.lowSensitivity')}</td>
                    <td style={{ padding: 12 }}>≥ 0.95</td>
                    <td style={{ padding: 12 }}>{t('docs.lowSensitivityUse')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Footer */}
          <Divider />

          <Divider />
          <div style={{ textAlign: 'center', color: '#666' }}>
            <Text type="secondary">
              {t('docs.needHelp')} <a href="mailto:thomas@openguardrails.com">thomas@openguardrails.com</a>
            </Text>
          </div>
        </Space>
      </Card>
    </div>
  );
};

export default Documentation;
