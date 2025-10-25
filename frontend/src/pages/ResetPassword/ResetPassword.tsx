import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Card, Typography, message, Alert, Spin } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher';
import api from '../../services/api';
import './ResetPassword.css';

const { Title, Text } = Typography;

interface ResetPasswordFormData {
  newPassword: string;
  confirmPassword: string;
}

const ResetPassword: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [verifyingToken, setVerifyingToken] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const token = searchParams.get('token');

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setTokenValid(false);
        setVerifyingToken(false);
        return;
      }

      try {
        await api.post('/api/v1/auth/verify-reset-token', null, {
          params: { token }
        });
        setTokenValid(true);
      } catch (error: any) {
        console.error('Token verification error:', error);
        setTokenValid(false);
        message.error(t('resetPassword.tokenInvalid'));
      } finally {
        setVerifyingToken(false);
      }
    };

    verifyToken();
  }, [token, t]);

  const handleSubmit = async (values: ResetPasswordFormData) => {
    if (!token) {
      message.error(t('resetPassword.tokenInvalid'));
      return;
    }

    try {
      setLoading(true);
      await api.post('/api/v1/auth/reset-password', {
        token,
        new_password: values.newPassword
      });

      setResetSuccess(true);
      message.success(t('resetPassword.resetSuccess'));

      // Redirect to login after 3 seconds
      setTimeout(() => {
        navigate('/login');
      }, 3000);
    } catch (error: any) {
      console.error('Reset password error:', error);
      message.error(error.response?.data?.detail || t('resetPassword.resetFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (verifyingToken) {
    return (
      <div className="reset-password-container">
        <div className="reset-password-content">
          <Card className="reset-password-card">
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin size="large" />
              <p style={{ marginTop: '16px' }}>{t('common.loading')}</p>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (!tokenValid) {
    return (
      <div className="reset-password-container">
        <div className="reset-password-content">
          <Card className="reset-password-card">
            {/* Language Switcher */}
            <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
              <LanguageSwitcher />
            </div>

            <div className="reset-password-header">
              <Title level={2} className="reset-password-title">
                {t('resetPassword.title')}
              </Title>
            </div>

            <Alert
              message={t('resetPassword.tokenInvalid')}
              description={t('resetPassword.tokenExpired')}
              type="error"
              showIcon
              style={{ marginBottom: 24 }}
            />

            <div className="reset-password-footer">
              <Link to="/forgot-password">
                <Button type="primary" block>
                  {t('forgotPassword.sendResetLink')}
                </Button>
              </Link>
              <div style={{ marginTop: '16px' }}>
                <Link to="/login">{t('resetPassword.backToLogin')}</Link>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (resetSuccess) {
    return (
      <div className="reset-password-container">
        <div className="reset-password-content">
          <Card className="reset-password-card">
            {/* Language Switcher */}
            <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
              <LanguageSwitcher />
            </div>

            <div className="reset-password-header">
              <Title level={2} className="reset-password-title">
                {t('resetPassword.title')}
              </Title>
              <Text type="secondary" className="reset-password-subtitle">
                {t('resetPassword.resetSuccess')}
              </Text>
            </div>

            <Alert
              message={t('resetPassword.resetSuccess')}
              description={t('resetPassword.resetSuccessDesc')}
              type="success"
              showIcon
              style={{ marginBottom: 24 }}
            />

            <div className="reset-password-footer">
              <Link to="/login">
                <Button type="primary" block>
                  {t('resetPassword.backToLogin')}
                </Button>
              </Link>
              <Text type="secondary" style={{ fontSize: '12px', marginTop: '16px', display: 'block', textAlign: 'center' }}>
                {t('resetPassword.copyright')}
              </Text>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="reset-password-container">
      <div className="reset-password-content">
        <Card className="reset-password-card">
          {/* Language Switcher */}
          <div style={{ position: 'absolute', top: '16px', right: '16px' }}>
            <LanguageSwitcher />
          </div>

          <div className="reset-password-header">
            <Title level={2} className="reset-password-title">
              {t('resetPassword.title')}
            </Title>
            <Text type="secondary" className="reset-password-subtitle">
              {t('resetPassword.subtitle')}
            </Text>
          </div>

          <Form
            name="reset-password"
            onFinish={handleSubmit}
            autoComplete="off"
            layout="vertical"
            size="large"
          >
            <Form.Item
              name="newPassword"
              rules={[
                { required: true, message: t('resetPassword.newPasswordRequired') },
                { min: 8, message: t('resetPassword.newPasswordMinLength') },
              ]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder={t('resetPassword.newPasswordPlaceholder')}
                autoComplete="new-password"
              />
            </Form.Item>

            <Form.Item
              name="confirmPassword"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: t('resetPassword.confirmPasswordRequired') },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error(t('resetPassword.passwordMismatch')));
                  },
                }),
              ]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder={t('resetPassword.confirmPasswordPlaceholder')}
                autoComplete="new-password"
              />
            </Form.Item>

            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                className="reset-password-button"
              >
                {t('resetPassword.resetButton')}
              </Button>
            </Form.Item>
          </Form>

          <div className="reset-password-footer">
            <Text type="secondary">
              <Link to="/login">{t('resetPassword.backToLogin')}</Link>
            </Text>
            <Text type="secondary" style={{ fontSize: '12px', marginTop: '16px', display: 'block', textAlign: 'center' }}>
              {t('resetPassword.copyright')}
            </Text>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default ResetPassword;
