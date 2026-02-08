import React, { useEffect, useState } from 'react'
import { Copy, ShieldCheck, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@/utils/clipboard'
import { toast } from 'sonner'
import { useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { authService, UserInfo } from '../../services/auth'
import { configApi } from '../../services/api'
import { billingService } from '../../services/billing'
import type { Subscription } from '../../types/billing'
import { features, getSystemConfig, isSaasMode } from '../../config'
import { PaymentButton } from '../../components/Payment'
import paymentService, { PaymentConfig } from '../../services/payment'

interface SystemInfo {
  support_email: string | null
  app_name: string
  app_version: string
}

const Account: React.FC = () => {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [user, setUser] = useState<UserInfo | null>(null)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null)
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [apiDomain, setApiDomain] = useState<string>('http://localhost:5001')

  // Get active tab from URL query params
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') || 'general')

  const passwordFormSchema = z
    .object({
      current_password: z.string().min(1, t('account.currentPasswordRequired')),
      new_password: z.string().min(8, t('account.passwordMinLength')),
      confirm_password: z.string().min(1, t('account.confirmPasswordRequired')),
    })
    .refine((data) => data.new_password === data.confirm_password, {
      message: t('account.passwordMismatch'),
      path: ['confirm_password'],
    })

  const passwordForm = useForm<z.infer<typeof passwordFormSchema>>({
    resolver: zodResolver(passwordFormSchema),
  })

  const fetchMe = async () => {
    try {
      const me = await authService.getCurrentUser()
      setUser(me)
    } catch (e) {
      toast.error(t('account.fetchUserInfoFailed'))
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

  const fetchSubscription = async () => {
    if (!features.showSubscription()) return

    try {
      const sub = await billingService.getCurrentSubscription()
      setSubscription(sub)
    } catch (e: any) {
      console.error('Fetch subscription failed', e)
      setSubscription(null)
    }
  }

  const fetchPaymentConfig = async () => {
    if (!features.showPayment()) return

    try {
      const config = await paymentService.getConfig()
      setPaymentConfig(config)
    } catch (e) {
      console.error('Fetch payment config failed', e)
    }
  }

  useEffect(() => {
    fetchMe()
    fetchSystemInfo()
    fetchSubscription()
    fetchPaymentConfig()

    try {
      const config = getSystemConfig()
      setApiDomain(config.apiDomain)
    } catch (e) {
      console.error('Failed to get system config', e)
    }
  }, [])

  // Sync activeTab with URL search params
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab && tab !== activeTab) {
      setActiveTab(tab)
    } else if (!tab && activeTab !== 'general') {
      setActiveTab('general')
    }
  }, [searchParams, activeTab])

  const handleCopyDifyEndpoint = async () => {
    const endpoint = 'https://api.openguardrails.com/v1/dify/moderation'
    try {
      await copyToClipboard(endpoint)
      toast.success(t('account.copied'))
    } catch {
      toast.error(t('account.copyFailed'))
    }
  }

  const handleChangePassword = async (values: z.infer<typeof passwordFormSchema>) => {
    try {
      setPasswordLoading(true)
      const response = await authService.changePassword(
        values.current_password,
        values.new_password
      )

      if (response.status === 'success') {
        toast.success(t('account.changePasswordSuccess'))
        passwordForm.reset()
      } else {
        toast.error(t('account.changePasswordFailed'))
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.detail || t('account.changePasswordFailed')
      if (errorMessage.includes('Current password is incorrect')) {
        toast.error(t('account.currentPasswordIncorrect'))
      } else {
        toast.error(errorMessage)
      }
    } finally {
      setPasswordLoading(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-blue-600" />
            <h2 className="text-2xl font-bold">{t('account.title')}</h2>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(key) => {
              setActiveTab(key)
              if (key === 'general') {
                searchParams.delete('tab')
                setSearchParams(searchParams)
              } else {
                searchParams.set('tab', key)
                setSearchParams(searchParams)
              }
            }}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="general">{t('account.title')}</TabsTrigger>
              <TabsTrigger value="password">
                <Lock className="mr-2 h-4 w-4" />
                {t('account.passwordChange')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-6 mt-6">
              {/* Email */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-600">{t('account.email')}</label>
                <div className="text-base">{user?.email || '-'}</div>
              </div>

              {/* Tenant UUID */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-600">
                  {t('account.tenantUuid')}
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 p-3 border rounded-md bg-gray-50 font-mono text-sm break-all">
                    {user?.id || '-'}
                  </div>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (user?.id) {
                        try {
                          await copyToClipboard(user.id)
                          toast.success(t('account.uuidCopied'))
                        } catch {
                          toast.error(t('account.copyFailed'))
                        }
                      }
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    {t('account.copy')}
                  </Button>
                </div>
                <p className="text-sm text-gray-600">{t('account.uuidNote')}</p>
              </div>

              {/* API Key Management Notice */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-600">
                  {t('account.apiKeyManagement')}
                </label>
                <div className="p-4 border rounded-md bg-gray-50">
                  <p className="text-sm">{t('account.apiKeyMigrationNotice')}</p>
                  <Button
                    variant="link"
                    className="px-0 h-auto mt-2"
                    onClick={() => (window.location.href = '/platform/applications')}
                  >
                    {t('account.goToApplicationManagement')}
                  </Button>
                </div>
              </div>

              {/* Dify Moderation Endpoint */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-600">
                  {t('account.difyModerationEndpoint')}
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 p-3 border rounded-md bg-gray-50 font-mono text-sm break-all">
                    https://api.openguardrails.com/v1/dify/moderation
                  </div>
                  <Button variant="outline" onClick={handleCopyDifyEndpoint}>
                    <Copy className="mr-2 h-4 w-4" />
                    {t('account.copy')}
                  </Button>
                </div>
                <p className="text-sm text-gray-600">{t('account.difyModerationEndpointNote')}</p>
              </div>

              <Separator />

              {/* Direct Model Access */}
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">
                    {t('docs.directModelAccess') || 'Direct Model Access'}
                  </h3>
                  <p className="text-sm text-gray-600 mt-1">
                    {t('docs.directModelAccessDesc') ||
                      'Use this API key to directly access models (OpenGuardrails-Text, bge-m3, etc.) without guardrails detection. For privacy, we only track usage count, not content.'}
                  </p>

                  {/* Subscription requirement notice (SaaS mode only) */}
                  {isSaasMode() && !user?.is_super_admin && (
                    <div className="mt-3">
                      {subscription?.subscription_type === 'subscribed' ? (
                        <p className="text-sm text-green-600">
                          ✓{' '}
                          {t('docs.subscriptionActive') ||
                            'Subscription active - Direct model access enabled'}
                        </p>
                      ) : (
                        <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                          <p className="font-semibold text-yellow-900">
                            {t('docs.subscriptionRequired') ||
                              'Active subscription required to use direct model access'}
                          </p>
                          <div className="mt-2 space-y-2">
                            <p className="text-sm text-yellow-800">
                              {t('billing.upgradeDescription') ||
                                'Upgrade to unlock unlimited access to direct model APIs, custom scanners, and premium features.'}
                            </p>
                            {paymentConfig && (
                              <>
                                <p className="font-semibold text-sm">
                                  {t('billing.price')}:{' '}
                                  {paymentService.formatPrice(
                                    paymentConfig.subscription_price,
                                    paymentConfig.currency
                                  )}
                                  /{t('billing.month')}
                                </p>
                                <div className="mt-2">
                                  <PaymentButton
                                    type="subscription"
                                    amount={paymentConfig.subscription_price}
                                    currency={paymentConfig.currency}
                                    provider={paymentConfig.provider}
                                    buttonText={t('payment.button.upgradeNow')}
                                    onSuccess={() => {
                                      fetchSubscription()
                                      fetchMe()
                                    }}
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* API Key Section */}
                {(() => {
                  const hasAccess =
                    user?.model_api_key &&
                    (!isSaasMode() ||
                      user?.is_super_admin ||
                      subscription?.subscription_type === 'subscribed')

                  return (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-600">
                        {t('docs.modelApiKey') || 'Model API Key'}
                      </label>
                      <div className="flex gap-2">
                        <div
                          className={`flex-1 p-3 border rounded-md font-mono text-sm break-all ${
                            hasAccess ? 'bg-gray-50' : 'bg-gray-100'
                          }`}
                        >
                          {hasAccess ? (
                            user?.model_api_key
                          ) : (
                            <span className="text-gray-500 flex items-center gap-2">
                              <Lock className="h-4 w-4" />
                              {t('account.subscriptionRequiredToViewKey') ||
                                '••••••••••••••••••••••••••••••••••• (Subscription Required)'}
                            </span>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          disabled={!hasAccess}
                          onClick={async () => {
                            if (user?.model_api_key && hasAccess) {
                              try {
                                await copyToClipboard(user.model_api_key)
                                toast.success(t('account.copied'))
                              } catch {
                                toast.error(t('account.copyFailed'))
                              }
                            }
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          {t('account.copy')}
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={!hasAccess}
                          onClick={async () => {
                            if (!hasAccess) return
                            try {
                              const newKey = await authService.regenerateModelApiKey()
                              setUser(user ? { ...user, model_api_key: newKey.model_api_key } : null)
                              toast.success(
                                t('account.modelApiKeyRegenerated') ||
                                  'Model API Key regenerated successfully'
                              )
                            } catch (error) {
                              toast.error(
                                t('account.regenerateFailed') ||
                                  'Failed to regenerate Model API Key'
                              )
                            }
                          }}
                        >
                          {t('account.regenerate') || 'Regenerate'}
                        </Button>
                      </div>
                    </div>
                  )
                })()}

                {/* Usage Example */}
                <div className="space-y-2">
                  <p className="font-semibold text-sm">
                    {t('account.usageExample') || 'Usage Example'}:
                  </p>
                  <pre
                    className={`bg-gray-100 p-4 rounded-md overflow-auto text-xs leading-relaxed ${
                      user?.model_api_key &&
                      (!isSaasMode() ||
                        user?.is_super_admin ||
                        subscription?.subscription_type === 'subscribed')
                        ? ''
                        : 'opacity-50'
                    }`}
                  >
                    {`from openai import OpenAI

# Just change base_url and api_key
client = OpenAI(
    base_url="${apiDomain}/v1/model/",
    api_key="${user?.model_api_key || 'your-model-api-key-here'}"
)

# Use as normal - direct model access!
response = client.chat.completions.create(
    model="OpenGuardrails-Text",  # or bge-m3
    messages=[{"role": "user", "content": "Hello"}]
)

# Privacy Notice: Content is NOT logged, only usage count`}
                  </pre>
                </div>

                {/* Privacy Notice */}
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="font-semibold text-blue-900 mb-2">
                    {t('account.privacyNotice') || 'Privacy Notice'}:
                  </p>
                  <ul className="space-y-1 text-sm text-blue-800 list-disc pl-5">
                    <li>
                      {t('account.privacyNotice1') ||
                        'Message content is NEVER stored in our database'}
                    </li>
                    <li>
                      {t('account.privacyNotice2') ||
                        'Only usage statistics (request count, tokens) are tracked for billing'}
                    </li>
                    <li>
                      {t('account.privacyNotice3') ||
                        'Ideal for private deployment where you self-host the platform'}
                    </li>
                  </ul>
                </div>

                {/* DMA Logging Configuration */}
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-3">
                  <div>
                    <p className="font-semibold text-yellow-900 mb-2">
                      {t('account.dmaLoggingConfig') || 'DMA Logging Configuration'}
                    </p>
                    <p className="text-sm text-yellow-800">
                      {t('account.dmaLoggingDesc') ||
                        'By default, Direct Model Access calls are NOT logged for privacy. Enable this option if you want to log full request content.'}
                    </p>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-gray-900">
                        {t('account.enableDmaLogging') || 'Enable DMA Logging'}
                      </label>
                      <p className="text-xs text-gray-600">
                        {t('account.enableDmaLoggingDesc') ||
                          'When enabled, full request content will be stored in detection results'}
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={user?.log_direct_model_access || false}
                        onChange={async (e) => {
                          try {
                            const newValue = e.target.checked
                            await authService.updateLogDirectModelAccess(newValue)
                            setUser(user ? { ...user, log_direct_model_access: newValue } : null)
                            toast.success(
                              t('account.dmaLoggingUpdated') ||
                                'DMA logging configuration updated successfully'
                            )
                          } catch (error) {
                            toast.error(
                              t('account.dmaLoggingUpdateFailed') ||
                                'Failed to update DMA logging configuration'
                            )
                          }
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                </div>
              </div>

              {/* Subscription info only in SaaS mode */}
              {features.showSubscription() && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-600">
                    {t('account.subscription')}
                  </label>
                  <div>
                    {subscription ? (
                      <div className="space-y-3">
                        <div>
                          <Badge
                            variant={
                              subscription.subscription_type === 'subscribed' ? 'default' : 'outline'
                            }
                          >
                            {subscription.plan_name}
                          </Badge>
                        </div>
                        <div>
                          <span className="text-sm">{t('account.monthlyQuota')}: </span>
                          <span className="font-semibold">
                            {subscription.current_month_usage.toLocaleString()} /{' '}
                            {subscription.monthly_quota.toLocaleString()}
                          </span>
                          <span className="text-sm text-gray-600"> {t('account.calls')}</span>
                        </div>
                        <Progress
                          value={Math.min(subscription.usage_percentage, 100)}
                          className={`h-2 ${subscription.usage_percentage >= 90 ? '[&>div]:bg-red-500' : '[&>div]:bg-blue-500'}`}
                        />
                        <p className="text-xs text-gray-600">
                          {t('account.quotaResetsOn', {
                            date: new Date(subscription.usage_reset_at).toLocaleDateString(),
                          })}
                        </p>
                        {subscription.subscription_type === 'free' &&
                          subscription.usage_percentage >= 80 && (
                            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                              <p className="text-xs text-yellow-900">
                                {t('account.upgradePrompt', {
                                  email: systemInfo?.support_email || '',
                                })}
                              </p>
                            </div>
                          )}
                      </div>
                    ) : subscription === null ? (
                      <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                        <p className="text-sm text-yellow-900">
                          {t('account.subscriptionNotFound', {
                            email: systemInfo?.support_email || 'support@openguardrails.com',
                          })}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-600">{t('common.loading')}</p>
                    )}
                  </div>
                </div>
              )}

              {/* API Rate Limit */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-600">
                  {t('account.apiRateLimit')}
                </label>
                <div className="text-base">
                  {(() => {
                    const rateLimit = user?.rate_limit
                    const rateLimitNum =
                      typeof rateLimit === 'string' ? parseInt(rateLimit, 10) : Number(rateLimit)

                    if (rateLimitNum === 0) {
                      return (
                        <span className="text-green-600">{t('account.unlimited')}</span>
                      )
                    } else if (rateLimitNum > 0) {
                      return <span>{t('account.rateLimitValue', { limit: rateLimitNum })}</span>
                    } else {
                      return (
                        <span className="text-gray-600">{t('common.loading')}</span>
                      )
                    }
                  })()}
                </div>
                <p className="text-xs text-gray-600">
                  {t('account.rateLimitNote', { email: systemInfo?.support_email || '' })}
                </p>
              </div>

              {/* Contact Support */}
              {systemInfo?.support_email && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">{t('account.contactSupport')}</h3>
                    <p className="text-sm text-gray-600">{t('account.openguardrailsServices')}</p>
                    <p className="text-base font-semibold text-blue-600">
                      {systemInfo.support_email}
                    </p>
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="password" className="mt-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-xl font-semibold">{t('account.passwordChange')}</h3>
                      <p className="text-sm text-gray-600 mt-1">
                        {t('account.newPasswordRequirements')}
                      </p>
                    </div>

                    <Form {...passwordForm}>
                      <form
                        onSubmit={passwordForm.handleSubmit(handleChangePassword)}
                        className="space-y-4"
                      >
                        <FormField
                          control={passwordForm.control}
                          name="current_password"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('account.currentPassword')}</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                                  <Input
                                    {...field}
                                    type="password"
                                    placeholder={t('account.currentPasswordPlaceholder')}
                                    autoComplete="current-password"
                                    className="pl-10"
                                  />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={passwordForm.control}
                          name="new_password"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('account.newPassword')}</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                                  <Input
                                    {...field}
                                    type="password"
                                    placeholder={t('account.newPasswordPlaceholder')}
                                    autoComplete="new-password"
                                    className="pl-10"
                                  />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={passwordForm.control}
                          name="confirm_password"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('account.confirmPassword')}</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                                  <Input
                                    {...field}
                                    type="password"
                                    placeholder={t('account.confirmPasswordPlaceholder')}
                                    autoComplete="new-password"
                                    className="pl-10"
                                  />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <Button type="submit" className="w-full" size="lg" disabled={passwordLoading}>
                          {t('account.changePassword')}
                        </Button>
                      </form>
                    </Form>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </CardContent>
    </Card>
  )
}

export default Account
