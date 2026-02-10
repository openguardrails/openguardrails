import React, { useState } from 'react';
import { toast } from 'sonner';
import { CreditCard, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import paymentService, { PaymentResponse } from '../../services/payment';

interface PaymentButtonProps {
  type: 'subscription' | 'package' | 'quota_purchase';
  packageId?: string;
  packageName?: string;
  tierNumber?: number;
  units?: number;
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
  tierNumber,
  units,
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
        response = await paymentService.createSubscriptionPayment(tierNumber);
      } else if (type === 'package' && packageId) {
        response = await paymentService.createPackagePayment(packageId);
      } else if (type === 'quota_purchase' && units) {
        response = await paymentService.createQuotaPurchasePayment(units);
      } else {
        throw new Error('Invalid payment type or missing required parameters');
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
        toast.error(errorMsg);
        onError?.(errorMsg);
        setLoading(false);
        setConfirmModalVisible(false);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail || error.message || t('payment.error.unknown');
      toast.error(errorMsg);
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

  const priceDisplay = paymentService.formatPrice(amount || 0, currency);

  return (
    <>
      <Button
        variant={buttonType === 'primary' ? 'default' : buttonType === 'link' ? 'link' : 'outline'}
        size={size}
        className={block ? 'w-full' : ''}
        disabled={disabled}
        onClick={showConfirmModal}
      >
        <CreditCard className="h-4 w-4 mr-2" />
        {getButtonText()}
      </Button>

      {/* Payment confirmation and loading dialog */}
      <Dialog open={confirmModalVisible} onOpenChange={!loading ? setConfirmModalVisible : undefined}>
        <DialogContent className={loading ? 'max-w-md' : 'max-w-lg'}>
          {loading ? (
            // Show loading state
            <div className="py-10 text-center">
              <Loader2 className="h-12 w-12 mx-auto animate-spin text-blue-600" />
              <div className="mt-6 text-base font-medium">
                {provider === 'alipay'
                  ? t('payment.redirecting.alipay', '正在跳转到支付宝...')
                  : t('payment.redirecting.stripe', '正在跳转到支付页面...')
                }
              </div>
              <div className="mt-3 text-sm text-muted-foreground">
                {t('payment.processing.pleaseWait', '请稍候，请勿关闭页面或刷新')}
              </div>
            </div>
          ) : (
            // Show confirmation content
            <>
              <DialogHeader>
                <DialogTitle>
                  {type === 'subscription'
                    ? t('payment.confirm.subscriptionTitle')
                    : type === 'quota_purchase'
                      ? t('payment.confirm.quotaTitle')
                      : t('payment.confirm.packageTitle')
                  }
                </DialogTitle>
                <DialogDescription>
                  {type === 'subscription'
                    ? t('payment.confirm.subscriptionContent', { price: priceDisplay })
                    : type === 'quota_purchase'
                      ? t('payment.confirm.quotaContent', { price: priceDisplay })
                      : t('payment.confirm.packageContent', { name: packageName, price: priceDisplay })
                  }
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={handleCancel}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handlePayment}>
                  {t('payment.confirm.proceed')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default PaymentButton;
