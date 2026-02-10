import React, { useEffect, useState } from 'react'
import { CreditCard, Calendar, TrendingUp, RefreshCw, CheckCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useSearchParams } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { confirmDialog } from '@/utils/confirm-dialog'
import { billingService } from '../../services/billing'
import { configApi } from '../../services/api'
import paymentService, { PaymentConfig, SubscriptionStatus } from '../../services/payment'
import { PaymentButton, TierSelector, QuotaPurchaseCard } from '../../components/Payment'
import { usePaymentSuccess } from '../../hooks/usePaymentSuccess'
import type { Subscription as SubscriptionType, UsageInfo } from '../../types/billing'

interface SystemInfo {
  support_email: string | null
  app_name: string
  app_version: string
}

const Subscription: React.FC = () => {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [subscription, setSubscription] = useState<SubscriptionType | null>(undefined)
  const [usageInfo, setUsageInfo] = useState<UsageInfo | null>(null)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [cancelLoading, setCancelLoading] = useState(false)

  const fetchSubscription = async () => {
    setLoading(true)
    try {
      const sub = await billingService.getCurrentSubscription()
      setSubscription(sub)
    } catch (e: any) {
      console.error('Fetch subscription failed', e)
      setSubscription(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchUsageInfo = async () => {
    try {
      const usage = await billingService.getCurrentUsage()
      setUsageInfo(usage)
    } catch (e: any) {
      console.error('Fetch usage info failed', e)
    }
  }

  const fetchSystemInfo = async () => {
    try {
      const info = await configApi.getSystemInfo()
      setSystemInfo(info)
    } catch (e) {
      console.error('Fetch system info failed', e)
    }
  }

  const fetchPaymentConfig = async () => {
    try {
      const config = await paymentService.getConfig()
      setPaymentConfig(config)
    } catch (e) {
      console.error('Fetch payment config failed', e)
    }
  }

  const fetchSubscriptionStatus = async () => {
    try {
      const status = await paymentService.getSubscriptionStatus()
      setSubscriptionStatus(status)
    } catch (e) {
      console.error('Fetch subscription status failed', e)
    }
  }

  const handleCancelSubscription = async () => {
    const confirmed = await confirmDialog({
      title: t('payment.cancel.title'),
      description: t('payment.cancel.content'),
    })

    if (!confirmed) return

    setCancelLoading(true)
    try {
      const result = await paymentService.cancelSubscription()
      if (result.success) {
        toast.success(t('payment.cancel.success'))
        fetchSubscriptionStatus()
        fetchSubscription()
      }
    } catch (e: any) {
      toast.error(e.response?.data?.detail || t('payment.cancel.failed'))
    } finally {
      setCancelLoading(false)
    }
  }

  // Handle payment success with polling verification
  const handlePaymentSuccess = React.useCallback((result: any) => {
    if (result.order_type === 'subscription' || result.order_type === 'quota_purchase') {
      fetchSubscription()
      fetchSubscriptionStatus()
      fetchUsageInfo()
    }
  }, [])

  usePaymentSuccess({
    onSuccess: handlePaymentSuccess,
  })

  useEffect(() => {
    fetchSubscription()
    fetchUsageInfo()
    fetchSystemInfo()
    fetchPaymentConfig()
    fetchSubscriptionStatus()

    const paymentStatus = searchParams.get('payment')
    if (paymentStatus === 'cancelled') {
      toast.info(t('payment.cancelled'))
      setSearchParams({})
    }
  }, [])

  const handleRefresh = () => {
    fetchSubscription()
    fetchUsageInfo()
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (subscription === null) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <CreditCard className="h-6 w-6 text-blue-600" />
              <h2 className="text-2xl font-bold">{t('billing.subscriptionManagement')}</h2>
            </div>
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="font-semibold text-yellow-900">{t('billing.subscriptionNotFound')}</p>
              <p className="text-sm text-yellow-800 mt-2">
                {t('billing.subscriptionNotFoundDesc', {
                  email: systemInfo?.support_email || 'support@openguardrails.com',
                })}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!subscription) {
    return null
  }

  const resetDate = new Date(subscription.usage_reset_at)
  const daysUntilReset = Math.ceil(
    (resetDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
  )

  const isAlipay = paymentConfig?.provider === 'alipay'
  const hasQuotaPurchase = isAlipay && paymentConfig?.quota_purchase

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <CreditCard className="h-6 w-6 text-blue-600" />
                <h2 className="text-2xl font-bold">{t('billing.subscriptionManagement')}</h2>
              </div>
              <Button variant="outline" onClick={handleRefresh}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('common.refresh')}
              </Button>
            </div>

            {/* Current Plan */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-600">
                {t('billing.currentPlan')}
              </label>
              <div>
                <Badge
                  variant={subscription.subscription_type === 'subscribed' ? 'default' : 'outline'}
                  className="text-base px-3 py-1"
                >
                  {subscription.plan_name}
                </Badge>
              </div>
            </div>

            {/* Alipay Quota Purchase (replaces tier selector for Chinese users) */}
            {hasQuotaPurchase && (
              <QuotaPurchaseCard
                quotaConfig={paymentConfig!.quota_purchase!}
                currentQuota={subscription.purchased_quota || 0}
                quotaExpiresAt={subscription.purchased_quota_expires_at || null}
                onSuccess={() => {
                  fetchSubscription()
                  fetchSubscriptionStatus()
                  fetchUsageInfo()
                }}
              />
            )}

            {/* Upgrade Prompt with Tier Selection (Stripe users only) */}
            {!isAlipay && subscription.subscription_type === 'free' && paymentConfig && paymentConfig.tiers && paymentConfig.tiers.length > 0 && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-4">
                <div>
                  <p className="font-semibold text-blue-900">{t('billing.upgradeAvailable')}</p>
                  <p className="text-sm text-blue-800 mt-1">{t('billing.upgradeDescription')}</p>
                </div>
                <TierSelector
                  tiers={paymentConfig.tiers}
                  currency={paymentConfig.currency}
                  provider={paymentConfig.provider}
                  currentTier={subscription.subscription_tier || 0}
                  onSuccess={() => {
                    fetchSubscription()
                    fetchSubscriptionStatus()
                    fetchUsageInfo()
                  }}
                />
              </div>
            )}

            {/* Fallback: single-tier upgrade for when tiers are not configured (Stripe users only) */}
            {!isAlipay && subscription.subscription_type === 'free' && paymentConfig && (!paymentConfig.tiers || paymentConfig.tiers.length === 0) && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="font-semibold text-blue-900">{t('billing.upgradeAvailable')}</p>
                <div className="mt-2 space-y-2">
                  <p className="text-sm text-blue-800">{t('billing.upgradeDescription')}</p>
                  <p className="font-semibold text-sm">
                    {t('billing.price')}:{' '}
                    {paymentService.formatPrice(
                      paymentConfig.subscription_price,
                      paymentConfig.currency
                    )}
                    /{t('billing.month')}
                  </p>
                  <div className="mt-3">
                    <PaymentButton
                      type="subscription"
                      amount={paymentConfig.subscription_price}
                      currency={paymentConfig.currency}
                      provider={paymentConfig.provider}
                      buttonText={t('payment.button.upgradeNow')}
                      onSuccess={() => {
                        fetchSubscription()
                        fetchSubscriptionStatus()
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Subscription Active Info (Stripe users only - no subscriptions for Alipay) */}
            {!isAlipay && subscription.subscription_type === 'subscribed' && subscriptionStatus && (
              <div className="space-y-4">
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <p className="font-semibold text-green-900">
                        {t('billing.subscriptionActive')}
                      </p>
                      {subscriptionStatus.expires_at && (
                        <p className="text-sm text-green-800">
                          {subscriptionStatus.cancel_at_period_end
                            ? t('billing.expiresOn', {
                                date: new Date(subscriptionStatus.expires_at).toLocaleDateString(),
                              })
                            : t('billing.nextBillingDate', {
                                date: new Date(subscriptionStatus.expires_at).toLocaleDateString(),
                              })}
                        </p>
                      )}
                      <div className="flex gap-2">
                        {!subscriptionStatus.cancel_at_period_end && (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={cancelLoading}
                            onClick={handleCancelSubscription}
                          >
                            {t('payment.button.cancelSubscription')}
                          </Button>
                        )}
                        {subscriptionStatus.cancel_at_period_end && (
                          <Badge variant="secondary">{t('billing.cancelledAtPeriodEnd')}</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Change Tier for subscribed users */}
                {paymentConfig && paymentConfig.tiers && paymentConfig.tiers.length > 0 && !subscriptionStatus.cancel_at_period_end && (
                  <TierSelector
                    tiers={paymentConfig.tiers}
                    currency={paymentConfig.currency}
                    provider={paymentConfig.provider}
                    currentTier={subscription.subscription_tier || 0}
                    onSuccess={() => {
                      fetchSubscription()
                      fetchSubscriptionStatus()
                      fetchUsageInfo()
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Usage Statistics */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {t('billing.usageStatistics')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* Statistics Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm font-medium text-gray-600">{t('billing.currentUsage')}</p>
                <p className="text-2xl font-bold mt-1">
                  {subscription.current_month_usage.toLocaleString()}
                </p>
                <p className="text-sm text-gray-500">
                  / {subscription.monthly_quota.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">{t('billing.remaining')}</p>
                <p
                  className={`text-2xl font-bold mt-1 ${subscription.usage_percentage >= 90 ? 'text-red-600' : 'text-green-600'}`}
                >
                  {Math.max(
                    0,
                    subscription.monthly_quota - subscription.current_month_usage
                  ).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('billing.usagePercentage')}
                </p>
                <p
                  className={`text-2xl font-bold mt-1 ${
                    subscription.usage_percentage >= 90
                      ? 'text-red-600'
                      : subscription.usage_percentage >= 80
                        ? 'text-yellow-600'
                        : 'text-green-600'
                  }`}
                >
                  {subscription.usage_percentage.toFixed(1)}%
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('billing.daysUntilReset')}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <Calendar className="h-5 w-5 text-gray-400" />
                  <p className="text-2xl font-bold">{daysUntilReset}</p>
                  <span className="text-sm text-gray-500">{t('billing.days')}</span>
                </div>
              </div>
            </div>

            {/* Purchased Quota Status */}
            {subscription.purchased_quota > 0 && (
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-green-700">{t('billing.purchasedQuota')}</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">
                      {subscription.purchased_quota.toLocaleString()} <span className="text-sm font-normal">{t('billing.calls')}</span>
                    </p>
                  </div>
                  {subscription.purchased_quota_expires_at && (
                    <div>
                      <p className="text-sm font-medium text-green-700">{t('billing.quotaExpiresOn', {
                        date: new Date(subscription.purchased_quota_expires_at).toLocaleDateString(),
                      })}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Usage Breakdown */}
            {subscription.usage_breakdown && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-gray-600">
                    {t('billing.guardrailsProxyCalls')}
                  </p>
                  <p className="text-xl font-bold mt-1">
                    {subscription.usage_breakdown.guardrails_proxy.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-600">
                    {t('billing.directModelAccessCalls')}
                  </p>
                  <p className="text-xl font-bold mt-1">
                    {subscription.usage_breakdown.direct_model_access.toLocaleString()}
                  </p>
                </div>
              </div>
            )}

            <Separator />

            {/* Usage Progress Bar */}
            <div className="space-y-3">
              <p className="font-semibold">{t('billing.monthlyQuotaUsage')}</p>
              <Progress
                value={Math.min(subscription.usage_percentage, 100)}
                className={`h-3 ${
                  subscription.usage_percentage >= 90
                    ? '[&>div]:bg-red-500'
                    : subscription.usage_percentage >= 80
                      ? '[&>div]:bg-yellow-500'
                      : '[&>div]:bg-blue-500'
                }`}
              />
              <p className="text-sm text-gray-600">
                {subscription.current_month_usage.toLocaleString()} /{' '}
                {subscription.monthly_quota.toLocaleString()} (
                {subscription.usage_percentage.toFixed(1)}%)
              </p>
            </div>

            {/* Quota Reset Info */}
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="space-y-2">
                <div className="flex items-center gap-2 font-semibold text-blue-900">
                  <Calendar className="h-4 w-4" />
                  {t('billing.quotaResetDate')}
                </div>
                <p className="text-sm text-blue-800">
                  {t('billing.quotaResetsOn', {
                    date: resetDate.toLocaleDateString(),
                    time: resetDate.toLocaleTimeString(),
                  })}
                </p>
                <p className="text-xs text-blue-700">{t('billing.quotaResetNote')}</p>
              </div>
            </div>

            {/* Warning Messages */}
            {subscription.usage_percentage >= 100 && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="font-semibold text-red-900">{t('billing.quotaExceeded')}</p>
                <p className="text-sm text-red-800 mt-1">
                  {t('billing.quotaExceededDesc', {
                    date: resetDate.toLocaleDateString(),
                  })}
                </p>
              </div>
            )}

            {subscription.usage_percentage >= 80 && subscription.usage_percentage < 100 && (
              <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="font-semibold text-yellow-900">{t('billing.quotaWarning')}</p>
                <p className="text-sm text-yellow-800 mt-1">
                  {t('billing.quotaWarningDesc', {
                    percentage: subscription.usage_percentage.toFixed(1),
                    email: systemInfo?.support_email || 'support@openguardrails.com',
                  })}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Plan Details */}
      <Card>
        <CardHeader>
          <CardTitle>{t('billing.planDetails')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-gray-600">{t('billing.planType')}</p>
                <p className="font-semibold mt-1">{subscription.plan_name}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">{t('billing.monthlyQuota')}</p>
                <p className="font-semibold mt-1">
                  {subscription.monthly_quota.toLocaleString()} {t('billing.calls')}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('billing.subscriptionId')}
                </p>
                <p className="font-mono text-xs bg-gray-100 px-2 py-1 rounded mt-1 inline-block">
                  {subscription.id}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">{t('billing.billingCycle')}</p>
                <p className="font-semibold mt-1">{t('billing.monthly')}</p>
              </div>
            </div>

            {!isAlipay && subscription.subscription_type === 'free' && paymentConfig && (
              <>
                <Separator />
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="space-y-3">
                    <p className="font-semibold text-yellow-900">
                      {t('billing.upgradeToUnlockMore')}
                    </p>
                    <ul className="space-y-1 text-sm text-yellow-800 list-disc pl-5">
                      <li>{t('billing.feature1')}</li>
                      <li>{t('billing.feature2')}</li>
                      <li>{t('billing.feature3')}</li>
                      <li>{t('billing.feature4')}</li>
                      <li>{t('billing.feature5')}</li>
                    </ul>
                    {paymentConfig.tiers && paymentConfig.tiers.length > 0 ? (
                      <TierSelector
                        tiers={paymentConfig.tiers}
                        currency={paymentConfig.currency}
                        provider={paymentConfig.provider}
                        currentTier={subscription.subscription_tier || 0}
                        onSuccess={() => {
                          fetchSubscription()
                          fetchSubscriptionStatus()
                          fetchUsageInfo()
                        }}
                      />
                    ) : (
                      <PaymentButton
                        type="subscription"
                        amount={paymentConfig.subscription_price}
                        currency={paymentConfig.currency}
                        provider={paymentConfig.provider}
                        buttonText={`${t('payment.button.upgradeNow')} - ${paymentService.formatPrice(paymentConfig.subscription_price, paymentConfig.currency)}/${t('billing.month')}`}
                        onSuccess={() => {
                          fetchSubscription()
                          fetchSubscriptionStatus()
                        }}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default Subscription
