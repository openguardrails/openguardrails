import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, message, Alert } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher';
import api from '../../services/api';
import './ForgotPassword.css';

const { Title, Text } = Typography;

interface ForgotPasswordFormData {
  email: string;
}

const ForgotPassword: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const { t, i18n } = useTranslation();

  const handleSubmit = async (values: ForgotPasswordFormData) => {
    try {
      setLoading(true);
      const currentLanguage = i18n.language || localStorage.getItem('i18nextLng') || 'en';

      await api.post('/api/v1/auth/forgot-password', {
        email: values.email,
        language: currentLanguage
      });

      setSubmittedEmail(values.email);
      setEmailSent(true);
    } catch (error: any) {
      console.error('Forgot password error:', error);
      message.error(error.response?.data?.detail || t('forgotPassword.sendFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (emailSent) {
    return (
      <div className="forgot-password-container">
        <div className="forgot-password-content">
          <Card className="forgot-password-card">
            {/* Language Switcher */}
            <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
              <LanguageSwitcher />
            </div>

            <div className="forgot-password-header">
              <Title level={2} className="forgot-password-title">
                {t('forgotPassword.title')}
              </Title>
              <Text type="secondary" className="forgot-password-subtitle">
                {t('forgotPassword.emailSent')}
              </Text>
            </div>

            <Alert
              message={t('forgotPassword.emailSent')}
              description={
                <div>
                  <p>{t('forgotPassword.emailSentDesc', { email: submittedEmail })}</p>
                  <p style={{ marginTop: '16px' }}>
                    {t('forgotPassword.checkSpam')}
                  </p>
                </div>
              }
              type="success"
              showIcon
              style={{ marginBottom: 24 }}
            />

            <div className="forgot-password-footer">
              <Link to="/login">
                <Button type="primary" block>
                  {t('forgotPassword.backToLogin')}
                </Button>
              </Link>
              <Text type="secondary" style={{ fontSize: '12px', marginTop: '16px', display: 'block', textAlign: 'center' }}>
                {t('forgotPassword.copyright')}
              </Text>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="forgot-password-container">
      <div className="forgot-password-content">
        <Card className="forgot-password-card">
          {/* Language Switcher */}
          <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
            <LanguageSwitcher />
          </div>

          <div className="forgot-password-header">
            <Title level={2} className="forgot-password-title">
              {t('forgotPassword.title')}
            </Title>
            <Text type="secondary" className="forgot-password-subtitle">
              {t('forgotPassword.subtitle')}
            </Text>
          </div>

          <Form
            name="forgot-password"
            onFinish={handleSubmit}
            autoComplete="off"
            layout="vertical"
            size="large"
          >
            <Form.Item
              name="email"
              rules={[
                { required: true, message: t('forgotPassword.emailRequired') },
                { type: 'email', message: t('forgotPassword.emailInvalid') },
              ]}
            >
              <Input
                prefix={<MailOutlined />}
                placeholder={t('forgotPassword.emailPlaceholder')}
                autoComplete="email"
              />
            </Form.Item>

            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                className="forgot-password-button"
              >
                {t('forgotPassword.sendResetLink')}
              </Button>
            </Form.Item>
          </Form>

          <div className="forgot-password-footer">
            <Text type="secondary">
              <Link to="/login">{t('forgotPassword.backToLogin')}</Link>
            </Text>
            <Text type="secondary" style={{ fontSize: '12px', marginTop: '16px', display: 'block', textAlign: 'center' }}>
              {t('forgotPassword.copyright')}
            </Text>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default ForgotPassword;
