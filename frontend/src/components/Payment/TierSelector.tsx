import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { PaymentButton } from './';
import type { SubscriptionTier } from '../../services/payment';
import paymentService from '../../services/payment';

interface TierSelectorProps {
  tiers: SubscriptionTier[];
  currency: string;
  provider: 'alipay' | 'stripe';
  currentTier: number;
  onSuccess?: () => void;
}

const TierSelector: React.FC<TierSelectorProps> = ({
  tiers,
  currency,
  provider,
  currentTier,
  onSuccess,
}) => {
  const { t } = useTranslation();

  if (!tiers || tiers.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">{t('billing.tierSelector')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {tiers.map((tier) => {
          const isCurrent = tier.tier_number === currentTier;
          return (
            <Card
              key={tier.tier_number}
              className={`relative ${isCurrent ? 'border-blue-500 border-2' : 'border'}`}
            >
              <CardContent className="pt-4 pb-4 space-y-3">
                {isCurrent && (
                  <Badge className="absolute -top-2 right-3 bg-blue-600">
                    {t('billing.currentTier')}
                  </Badge>
                )}
                <div>
                  <h4 className="font-bold text-lg">{tier.tier_name}</h4>
                  <p className="text-sm text-gray-500">
                    {tier.monthly_quota.toLocaleString()} {t('billing.callsPerMonth')}
                  </p>
                </div>
                <div className="text-2xl font-bold">
                  {paymentService.formatPrice(tier.price, currency)}
                  <span className="text-sm font-normal text-gray-500">/{t('billing.month')}</span>
                </div>
                {isCurrent ? (
                  <div className="flex items-center gap-1 text-blue-600 text-sm font-medium">
                    <Check className="h-4 w-4" />
                    {t('billing.currentTier')}
                  </div>
                ) : (
                  <PaymentButton
                    type="subscription"
                    tierNumber={tier.tier_number}
                    amount={tier.price}
                    currency={currency}
                    provider={provider}
                    buttonText={t('billing.selectTier')}
                    block
                    onSuccess={onSuccess}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

export default TierSelector;
