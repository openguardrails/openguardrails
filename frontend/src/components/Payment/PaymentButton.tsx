import React, { useState } from 'react';
import { Button, message, Modal } from 'antd';
import { CreditCardOutlined, AlipayCircleOutlined } from '@ant-design/icons';
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
  const [loading, setLoading] = useState(false);

  const handlePayment = async () => {
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
        // Redirect to payment page
        paymentService.redirectToPayment(response);
        onSuccess?.();
      } else {
        const errorMsg = response.error || t('payment.error.createFailed');
        message.error(errorMsg);
        onError?.(errorMsg);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail || error.message || t('payment.error.unknown');
      message.error(errorMsg);
      onError?.(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const confirmPayment = () => {
    const priceDisplay = paymentService.formatPrice(amount || 0, currency);

    Modal.confirm({
      title: type === 'subscription'
        ? t('payment.confirm.subscriptionTitle')
        : t('payment.confirm.packageTitle'),
      content: type === 'subscription'
        ? t('payment.confirm.subscriptionContent', { price: priceDisplay })
        : t('payment.confirm.packageContent', { name: packageName, price: priceDisplay }),
      okText: t('payment.confirm.proceed'),
      cancelText: t('common.cancel'),
      onOk: handlePayment
    });
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

  return (
    <Button
      type={buttonType}
      size={size}
      block={block}
      disabled={disabled}
      loading={loading}
      icon={getIcon()}
      onClick={confirmPayment}
    >
      {getButtonText()}
    </Button>
  );
};

export default PaymentButton;
