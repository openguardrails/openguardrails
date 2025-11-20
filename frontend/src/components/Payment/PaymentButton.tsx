import React, { useState } from 'react';
import { Button, message, Modal, Spin } from 'antd';
import { CreditCardOutlined, AlipayCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import paymentService, { PaymentResponse } from '../../services/payment';

interface PaymentButtonProps {
  type: 'subscription' | 'package';
  packageId?: string;
  packageName?: string;
  amount?: number;
  currency?: string;
  provider?: 'alipay' | 'stripe';
  onSuccess?: () => void;
  onError?: (error: string) => void;
  buttonText?: string;
  buttonType?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
  size?: 'small' | 'middle' | 'large';
  block?: boolean;
  disabled?: boolean;
}

const PaymentButton: React.FC<PaymentButtonProps> = ({
  type,
  packageId,
  packageName,
  amount,
  currency = 'USD',
  provider = 'stripe',
  onSuccess,
  onError,
  buttonText,
  buttonType = 'primary',
  size = 'middle',
  block = false,
  disabled = false
}) => {
  const { t } = useTranslation();
  const [confirmModalVisible, setConfirmModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  const handlePayment = async () => {
    // Show loading state in the same modal
    setLoading(true);

    try {
      let response: PaymentResponse;

      if (type === 'subscription') {
        response = await paymentService.createSubscriptionPayment();
      } else if (type === 'package' && packageId) {
        response = await paymentService.createPackagePayment(packageId);
      } else {
        throw new Error('Invalid payment type or missing package ID');
      }

      if (response.success) {
        // Keep the modal open while redirecting
        // Small delay to ensure the UI updates before redirect
        setTimeout(() => {
          // Redirect to payment page
          paymentService.redirectToPayment(response);
          onSuccess?.();
        }, 500);
      } else {
        const errorMsg = response.error || t('payment.error.createFailed');
        message.error(errorMsg);
        onError?.(errorMsg);
        setLoading(false);
        setConfirmModalVisible(false);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail || error.message || t('payment.error.unknown');
      message.error(errorMsg);
      onError?.(errorMsg);
      setLoading(false);
      setConfirmModalVisible(false);
    }
  };

  const showConfirmModal = () => {
    setConfirmModalVisible(true);
  };

  const handleCancel = () => {
    if (!loading) {
      setConfirmModalVisible(false);
    }
  };

  const getButtonText = () => {
    if (buttonText) return buttonText;

    if (type === 'subscription') {
      return t('payment.button.subscribe');
    }
    return t('payment.button.purchase');
  };

  const getIcon = () => {
    if (provider === 'alipay') {
      return <AlipayCircleOutlined />;
    }
    return <CreditCardOutlined />;
  };

  const priceDisplay = paymentService.formatPrice(amount || 0, currency);

  return (
    <>
      <Button
        type={buttonType}
        size={size}
        block={block}
        disabled={disabled}
        icon={getIcon()}
        onClick={showConfirmModal}
      >
        {getButtonText()}
      </Button>

      {/* Payment confirmation and loading modal */}
      <Modal
        title={loading ? null : (type === 'subscription'
          ? t('payment.confirm.subscriptionTitle')
          : t('payment.confirm.packageTitle'))}
        open={confirmModalVisible}
        onOk={handlePayment}
        onCancel={handleCancel}
        okText={t('payment.confirm.proceed')}
        cancelText={t('common.cancel')}
        confirmLoading={loading}
        closable={!loading}
        maskClosable={!loading}
        keyboard={!loading}
        centered
        width={loading ? 400 : 500}
        zIndex={2000}
      >
        {loading ? (
          // Show loading state
          <div style={{ 
            padding: '40px 20px',
            textAlign: 'center'
          }}>
            <Spin
              indicator={<LoadingOutlined style={{ fontSize: 48, color: '#1890ff' }} spin />}
              size="large"
            />
            <div style={{ 
              marginTop: 24, 
              fontSize: 16, 
              fontWeight: 500,
              color: '#262626'
            }}>
              {provider === 'alipay' 
                ? t('payment.redirecting.alipay', '正在跳转到支付宝...') 
                : t('payment.redirecting.stripe', '正在跳转到支付页面...')
              }
            </div>
            <div style={{ 
              marginTop: 12, 
              fontSize: 14, 
              color: '#8c8c8c'
            }}>
              {t('payment.processing.pleaseWait', '请稍候，请勿关闭页面或刷新')}
            </div>
          </div>
        ) : (
          // Show confirmation content
          <div style={{ padding: '20px 0' }}>
            {type === 'subscription'
              ? t('payment.confirm.subscriptionContent', { price: priceDisplay })
              : t('payment.confirm.packageContent', { name: packageName, price: priceDisplay })
            }
          </div>
        )}
      </Modal>
    </>
  );
};

export default PaymentButton;
