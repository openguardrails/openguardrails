import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Card, Typography, message, Space } from 'antd';
import { MailOutlined, SafetyOutlined } from '@ant-design/icons';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher';
import '../Register/Register.css';

const { Title, Text } = Typography;

interface VerifyFormData {
  email: string;
  verificationCode: string;
}

const Verify: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const initialEmail = searchParams.get('email') || '';

  // Countdown processing
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (countdown > 0) {
      timer = setTimeout(() => {
        setCountdown(countdown - 1);
      }, 1000);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [countdown]);

  const handleVerify = async (values: VerifyFormData) => {
    try {
      setLoading(true);

      const response = await fetch('/api/v1/users/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: values.email,
          verification_code: values.verificationCode,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || t('verify.verifyFailed'));
      }

      message.success(t('verify.verifySuccess'));
      setTimeout(() => {
        navigate('/login');
      }, 1500);
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async (email: string) => {
    try {
      setResendLoading(true);

      const response = await fetch('/api/v1/users/resend-verification-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || t('verify.resendFailed'));
      }

      setCountdown(60); // Set 60 seconds countdown
      message.success(t('verify.resendSuccess'));
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <div className="register-container">
      <div className="register-content">
        <Card className="register-card">
          {/* Language Switcher */}
          <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
            <LanguageSwitcher />
          </div>
          
          <div className="register-header">
            <Title level={2} className="register-title">
              {t('login.title')}
            </Title>
            <Text type="secondary" className="register-subtitle">
              {t('verify.title')}
            </Text>
          </div>

          <div className="register-form">
            <Form
              name="verify"
              onFinish={handleVerify}
              autoComplete="off"
              layout="vertical"
              size="large"
              initialValues={{ email: initialEmail }}
            >
              <Form.Item
                name="email"
                label={t('register.email')}
                rules={[
                  { required: true, message: t('verify.emailRequired') },
                  { type: 'email', message: t('verify.emailInvalid') },
                ]}
              >
                <Input
                  prefix={<MailOutlined />}
                  placeholder={t('verify.emailPlaceholder')}
                  autoComplete="email"
                />
              </Form.Item>

              <Form.Item
                name="verificationCode"
                label={t('register.verificationCode')}
                rules={[
                  { required: true, message: t('verify.verificationCodeRequired') },
                  { len: 6, message: t('verify.verificationCodeLength') },
                ]}
              >
                <Input
                  prefix={<SafetyOutlined />}
                  placeholder={t('verify.verificationCodePlaceholder')}
                  maxLength={6}
                  style={{ textAlign: 'center', fontSize: '18px', letterSpacing: '4px' }}
                />
              </Form.Item>

              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  className="verify-button"
                >
                  {t('verify.verifyButton')}
                </Button>
              </Form.Item>

              <Form.Item>
                <Space direction="vertical" style={{ width: '100%' }} align="center">
                  <div style={{ textAlign: 'center' }}>
                    <Text type="secondary">{t('register.resendCodeQuestion')}</Text>
                    <Form.Item
                      noStyle
                      shouldUpdate={(prevValues, currentValues) => prevValues.email !== currentValues.email}
                    >
                      {({ getFieldValue }) => (
                        <Button
                          type="link"
                          onClick={() => handleResendCode(getFieldValue('email'))}
                          loading={resendLoading}
                          disabled={countdown > 0 || !getFieldValue('email')}
                          style={{ padding: '0 4px' }}
                        >
                          {countdown > 0 ? t('verify.resendCodeCountdown', { count: countdown }) : t('verify.resendCode')}
                        </Button>
                      )}
                    </Form.Item>
                  </div>

                  <Space>
                    <Link to="/register">{t('register.backToRegister')}</Link>
                    <Text type="secondary">|</Text>
                    <Link to="/login">{t('register.alreadyHaveAccount')} {t('register.loginNow')}</Link>
                  </Space>
                </Space>
              </Form.Item>
            </Form>
          </div>

          <div className="register-footer">
            <Space direction="vertical" align="center">
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {t('login.copyright')}
              </Text>
            </Space>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Verify;
