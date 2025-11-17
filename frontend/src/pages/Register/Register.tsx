import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Card, Typography, message, Space, Steps } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined, SafetyOutlined } from '@ant-design/icons';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher';
import './Register.css';

const { Title, Text } = Typography;
const { Step } = Steps;

interface RegisterFormData {
  email: string;
  password: string;
  confirmPassword: string;
}

interface VerifyFormData {
  verificationCode: string;
}

const Register: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [userEmail, setUserEmail] = useState('');
  const [countdown, setCountdown] = useState(0);
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();

  // 倒计时处理
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

  const handleResendCode = async () => {
    try {
      setResendLoading(true);

      const response = await fetch('/api/v1/users/resend-verification-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: userEmail,
          language: i18n.language,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || t('register.registerFailed'));
      }

      setCountdown(60);
      message.success(t('register.resendCodeSuccess'));
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setResendLoading(false);
    }
  };

  const handleRegister = async (values: RegisterFormData) => {
    try {
      setLoading(true);

      const response = await fetch('/api/v1/users/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: values.email,
          password: values.password,
          language: i18n.language,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || t('register.registerFailed'));
      }

      setUserEmail(values.email);
      setCurrentStep(1);
      setCountdown(60);
      message.success(t('register.registerSuccess'));
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (values: VerifyFormData) => {
    try {
      setLoading(true);

      const response = await fetch('/api/v1/users/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: userEmail,
          verification_code: values.verificationCode,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || t('register.verifyFailed'));
      }

      message.success(t('register.verifySuccess'));
      setTimeout(() => {
        navigate('/login');
      }, 1500);
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const validatePassword = (_: any, value: string) => {
    if (!value) {
      return Promise.reject(new Error(t('register.passwordRequired')));
    }

    if (value.length < 8) {
      return Promise.reject(new Error(t('register.passwordMinLength')));
    }

    if (!/[A-Z]/.test(value)) {
      return Promise.reject(new Error(t('register.passwordUppercase')));
    }

    if (!/[a-z]/.test(value)) {
      return Promise.reject(new Error(t('register.passwordLowercase')));
    }

    if (!/\d/.test(value)) {
      return Promise.reject(new Error(t('register.passwordNumber')));
    }

    return Promise.resolve();
  };

  const renderRegisterForm = () => (
    <Form
      name="register"
      onFinish={handleRegister}
      autoComplete="off"
      layout="vertical"
      size="large"
    >
      <Form.Item
        name="email"
        rules={[
          { required: true, message: t('register.emailRequired') },
          { type: 'email', message: t('register.emailInvalid') },
        ]}
      >
        <Input
          prefix={<MailOutlined />}
          placeholder={t('register.emailPlaceholder')}
          autoComplete="email"
        />
      </Form.Item>

      <Form.Item
        name="password"
        rules={[
          { validator: validatePassword },
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder={t('register.passwordPlaceholder')}
          autoComplete="new-password"
        />
      </Form.Item>

      <Form.Item
        name="confirmPassword"
        dependencies={['password']}
        rules={[
          { required: true, message: t('register.confirmPasswordRequired') },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('password') === value) {
                return Promise.resolve();
              }
              return Promise.reject(new Error(t('register.passwordMismatch')));
            },
          }),
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder={t('register.confirmPasswordPlaceholder')}
          autoComplete="new-password"
        />
      </Form.Item>

      <Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          loading={loading}
          block
          className="register-button"
        >
          {t('register.registerButton')}
        </Button>
      </Form.Item>
    </Form>
  );

  const renderVerifyForm = () => (
    <Form
      name="verify"
      onFinish={handleVerify}
      autoComplete="off"
      layout="vertical"
      size="large"
    >
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <Text type="secondary">
          {t('register.verificationCodeSentTo')} <strong>{userEmail}</strong>
        </Text>
        <br />
        <Text type="secondary" style={{ fontSize: '12px' }}>
          {t('register.verifyLaterNote')} <Link to={`/verify?email=${encodeURIComponent(userEmail)}`}>{t('register.verifyLaterLink')}</Link>
        </Text>
      </div>

      <Form.Item
        name="verificationCode"
        rules={[
          { required: true, message: t('register.verificationCodeRequired') },
          { len: 6, message: t('register.verificationCodeLength') },
        ]}
      >
        <Input
          prefix={<SafetyOutlined />}
          placeholder={t('register.verificationCodePlaceholder')}
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
          {t('register.verifyButton')}
        </Button>
      </Form.Item>

      <Form.Item>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Text type="secondary">{t('register.resendCodeQuestion')}</Text>
            <Button
              type="link"
              onClick={handleResendCode}
              loading={resendLoading}
              disabled={countdown > 0}
              style={{ padding: '0 4px' }}
            >
              {countdown > 0 ? t('register.resendCodeCountdown', { count: countdown }) : t('register.resendCode')}
            </Button>
          </div>
          <Button
            type="link"
            onClick={() => setCurrentStep(0)}
            block
          >
            {t('register.backToRegister')}
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );

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
              {t('register.title')}
            </Title>
            <Text type="secondary" className="register-subtitle">
              {t('register.subtitle')}
            </Text>
          </div>

          <Steps current={currentStep} className="register-steps">
            <Step title={t('register.stepFillInfo')} description={t('register.stepFillInfoDesc')} />
            <Step title={t('register.stepVerifyEmail')} description={t('register.stepVerifyEmailDesc')} />
          </Steps>

          <div className="register-form">
            {currentStep === 0 ? renderRegisterForm() : renderVerifyForm()}
          </div>

          <div className="register-footer">
            <Space direction="vertical" align="center">
              <Text type="secondary">
                {t('register.alreadyHaveAccount')} <Link to="/login">{t('register.loginNow')}</Link>
              </Text>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {t('register.copyright')}
              </Text>
            </Space>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Register;