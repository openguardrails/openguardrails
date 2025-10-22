import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, message, Space, Alert } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher';
import './Login.css';

const { Title, Text } = Typography;

interface LoginFormData {
  email: string;
  password: string;
}

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  const from = (location.state as any)?.from?.pathname || '/dashboard';

  const handleSubmit = async (values: LoginFormData) => {
    try {
      setLoading(true);
      setShowVerificationAlert(false);
      // Get current language from localStorage
      const currentLanguage = localStorage.getItem('i18nextLng') || 'en';
      await login(values.email, values.password, currentLanguage);
      message.success(t('login.loginSuccess'));
      navigate(from, { replace: true });
    } catch (error: any) {
      console.error('Login error:', error);
      console.error('Error details:', {
        status: error.response?.status,
        data: error.response?.data,
        config: error.config
      });

      const errorMessage = error.response?.data?.detail || t('login.loginFailed');

      // Check if account is not activated
      if (error.response?.status === 403 && errorMessage.includes('not activated')) {
        setUnverifiedEmail(values.email);
        setShowVerificationAlert(true);
      } else {
        message.error(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-content">
        <Card className="login-card">
          {/* Language Switcher */}
          <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
            <LanguageSwitcher />
          </div>
          
          <div className="login-header">
            <Title level={2} className="login-title">
              {t('login.title')}
            </Title>
            <Text type="secondary" className="login-subtitle">
              {t('login.subtitle')}
            </Text>
          </div>

          {showVerificationAlert && (
            <Alert
              message={t('login.accountNotActivated')}
              description={
                <div>
                  <p>{t('login.accountNotActivatedDesc', { email: unverifiedEmail })}</p>
                  <Space>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => navigate(`/verify?email=${encodeURIComponent(unverifiedEmail)}`)}
                    >
                      {t('login.goToVerifyPage')}
                    </Button>
                    <span>|</span>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setShowVerificationAlert(false)}
                    >
                      {t('login.closeReminder')}
                    </Button>
                  </Space>
                </div>
              }
              type="warning"
              showIcon
              style={{ marginBottom: 24 }}
            />
          )}

          <Form
            name="login"
            onFinish={handleSubmit}
            autoComplete="off"
            layout="vertical"
            size="large"
          >
            <Form.Item
              name="email"
              rules={[
                { required: true, message: t('login.emailRequired') },
                { type: 'email', message: t('login.emailInvalid') },
              ]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder={t('login.emailPlaceholder')}
                autoComplete="email"
              />
            </Form.Item>

            <Form.Item
              name="password"
              rules={[
                { required: true, message: t('login.passwordRequired') },
              ]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder={t('login.passwordPlaceholder')}
                autoComplete="current-password"
              />
            </Form.Item>

            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                className="login-button"
              >
                {t('login.loginButton')}
              </Button>
            </Form.Item>
          </Form>

          <div className="login-footer">
            <Space direction="vertical" align="center">
              <Space>
                <Text type="secondary">
                  {t('login.noAccount')} <Link to="/register">{t('login.registerNow')}</Link>
                </Text>
                <Text type="secondary">|</Text>
                <Text type="secondary">
                  {t('login.needVerifyEmail')} <Link to="/verify">{t('login.verifyPage')}</Link>
                </Text>
              </Space>
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

export default Login;