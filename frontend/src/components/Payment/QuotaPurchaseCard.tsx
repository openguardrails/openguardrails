import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart, Minus, Plus, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { PaymentButton } from './index';
import type { QuotaPurchaseConfig } from '../../services/payment';

interface QuotaPurchaseCardProps {
  quotaConfig: QuotaPurchaseConfig;
  currentQuota: number;
  quotaExpiresAt: string | null;
  onSuccess?: () => void;
}

const QuotaPurchaseCard: React.FC<QuotaPurchaseCardProps> = ({
  quotaConfig,
  currentQuota,
  quotaExpiresAt,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [units, setUnits] = useState(1);

  const totalCalls = units * quotaConfig.calls_per_unit;
  const totalPrice = units * quotaConfig.price_per_unit;

  const handleUnitsChange = (value: number) => {
    const newValue = Math.max(quotaConfig.min_units, Math.floor(value));
    setUnits(newValue);
  };

  const isExpired = quotaExpiresAt && new Date(quotaExpiresAt) < new Date();
  const hasQuota = currentQuota > 0 && !isExpired;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingCart className="h-5 w-5" />
          {t('billing.purchaseQuota')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Current Quota Status */}
        <div className="p-4 rounded-lg border bg-gray-50">
          <p className="text-sm font-medium text-gray-600 mb-2">{t('billing.purchasedQuota')}</p>
          {hasQuota ? (
            <div className="space-y-1">
              <p className="text-2xl font-bold text-green-600">
                {currentQuota.toLocaleString()} <span className="text-sm font-normal text-gray-500">{t('billing.calls')}</span>
              </p>
              <p className="text-sm text-gray-500">
                {t('billing.quotaExpiresOn', {
                  date: new Date(quotaExpiresAt!).toLocaleDateString(),
                })}
              </p>
            </div>
          ) : (
            <p className="text-gray-400">{isExpired ? t('billing.quotaExpired') : t('billing.noPurchasedQuota')}</p>
          )}
        </div>

        {/* Purchase Selector */}
        <div className="space-y-4">
          <p className="text-sm font-medium">
            {t('billing.quotaPriceInfo', {
              price: `¥${quotaConfig.price_per_unit}`,
              calls: quotaConfig.calls_per_unit.toLocaleString(),
            })}
          </p>

          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">{t('billing.quotaUnits')}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleUnitsChange(units - 1)}
                disabled={units <= quotaConfig.min_units}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                value={units}
                onChange={(e) => handleUnitsChange(Number(e.target.value) || 1)}
                min={quotaConfig.min_units}
                className="w-20 text-center h-8"
              />
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleUnitsChange(units + 1)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex gap-4 text-sm">
            <div>
              <span className="text-gray-600">{t('billing.quotaTotalCalls')}: </span>
              <span className="font-semibold">{totalCalls.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-gray-600">{t('billing.quotaTotalPrice')}: </span>
              <span className="font-semibold text-blue-600">¥{totalPrice}</span>
            </div>
          </div>
        </div>

        {/* Warnings */}
        <div className="space-y-2 text-xs text-gray-500">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            <span>{t('billing.quotaValidityNote', { days: quotaConfig.validity_days })}</span>
          </div>
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            <span>{t('billing.quotaNoRefund')}</span>
          </div>
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            <span>{t('billing.quotaStackNote')}</span>
          </div>
        </div>

        {/* Buy Button */}
        <PaymentButton
          type="quota_purchase"
          units={units}
          amount={totalPrice}
          currency="CNY"
          provider="alipay"
          buttonText={`${t('billing.buyQuota')} - ¥${totalPrice}`}
          block
          onSuccess={onSuccess}
        />
      </CardContent>
    </Card>
  );
};

export default QuotaPurchaseCard;
