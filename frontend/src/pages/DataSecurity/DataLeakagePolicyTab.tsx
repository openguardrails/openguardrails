import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Shield, AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { dataLeakagePolicyApi } from '../../services/api'
import { useApplication } from '../../contexts/ApplicationContext'
import { useAuth } from '../../contexts/AuthContext'

const policySchema = z.object({
  high_risk_action: z.enum(['block', 'switch_safe_model', 'anonymize', 'pass']),
  medium_risk_action: z.enum(['block', 'switch_safe_model', 'anonymize', 'pass']),
  low_risk_action: z.enum(['block', 'switch_safe_model', 'anonymize', 'pass']),
  safe_model_id: z.string().nullable().optional(),
  enable_format_detection: z.boolean(),
  enable_smart_segmentation: z.boolean(),
})

type PolicyFormData = z.infer<typeof policySchema>

interface SafeModel {
  id: string
  config_name: string
  provider: string
  model: string
  is_data_safe: boolean
  is_default_safe_model: boolean
  safe_model_priority: number
}

const DataLeakagePolicyTab: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [safeModels, setSafeModels] = useState<SafeModel[]>([])
  const { currentApplicationId } = useApplication()
  const { onUserSwitch } = useAuth()

  const form = useForm<PolicyFormData>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      high_risk_action: 'block',
      medium_risk_action: 'switch_safe_model',
      low_risk_action: 'anonymize',
      safe_model_id: null,
      enable_format_detection: true,
      enable_smart_segmentation: true,
    },
  })

  // Fetch policy and safe models
  const fetchData = async () => {
    if (!currentApplicationId) return

    setLoading(true)
    try {
      // Fetch policy
      const policyData = await dataLeakagePolicyApi.getPolicy(currentApplicationId)
      form.reset({
        high_risk_action: policyData.high_risk_action,
        medium_risk_action: policyData.medium_risk_action,
        low_risk_action: policyData.low_risk_action,
        safe_model_id: policyData.safe_model?.id || null,
        enable_format_detection: policyData.enable_format_detection,
        enable_smart_segmentation: policyData.enable_smart_segmentation,
      })

      // Set available safe models from policy response
      if (policyData.available_safe_models) {
        setSafeModels(policyData.available_safe_models)
      }
    } catch (error: any) {
      console.error('Failed to fetch policy:', error)
      toast.error(t('dataLeakagePolicy.fetchPolicyFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [currentApplicationId])

  // Listen to user switch event
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchData()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Save policy
  const onSubmit = async (values: PolicyFormData) => {
    if (!currentApplicationId) {
      toast.error('No application selected')
      return
    }

    setLoading(true)
    try {
      await dataLeakagePolicyApi.updatePolicy(currentApplicationId, {
        high_risk_action: values.high_risk_action,
        medium_risk_action: values.medium_risk_action,
        low_risk_action: values.low_risk_action,
        safe_model_id: values.safe_model_id || null,
        enable_format_detection: values.enable_format_detection,
        enable_smart_segmentation: values.enable_smart_segmentation,
      })
      toast.success(t('dataLeakagePolicy.savePolicySuccess'))
      fetchData() // Reload to get updated data
    } catch (error: any) {
      console.error('Failed to save policy:', error)
      const errorMessage = error.response?.data?.error || error.response?.data?.detail || t('dataLeakagePolicy.savePolicyFailed')
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  // Action options
  const actionOptions = [
    { value: 'block', label: t('dataLeakagePolicy.actionBlock'), color: 'destructive' },
    { value: 'switch_safe_model', label: t('dataLeakagePolicy.actionSwitchSafeModel'), color: 'default' },
    { value: 'anonymize', label: t('dataLeakagePolicy.actionAnonymize'), color: 'secondary' },
    { value: 'pass', label: t('dataLeakagePolicy.actionPass'), color: 'outline' },
  ]

  if (loading && !form.formState.isDirty) {
    return (
      <div className="flex items-center justify-center h-64">
        <p>{t('dataLeakagePolicy.loading')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-3">
          <Shield className="h-5 w-5 text-blue-600 mt-0.5" />
          <div>
            <p className="font-semibold text-blue-900">{t('dataLeakagePolicy.description')}</p>
            <p className="text-sm text-blue-800 mt-1">{t('dataLeakagePolicy.defaultStrategyDesc')}</p>
          </div>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Risk Level Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                {t('dataLeakagePolicy.riskLevelActions')}
              </CardTitle>
              <CardDescription>{t('dataLeakagePolicy.defaultStrategy')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* High Risk Action */}
              <FormField
                control={form.control}
                name="high_risk_action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('dataLeakagePolicy.highRiskAction')}
                      <Badge variant="destructive">High Risk</Badge>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {actionOptions.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {/* Medium Risk Action */}
              <FormField
                control={form.control}
                name="medium_risk_action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('dataLeakagePolicy.mediumRiskAction')}
                      <Badge variant="default" className="bg-orange-500">Medium Risk</Badge>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {actionOptions.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {/* Low Risk Action */}
              <FormField
                control={form.control}
                name="low_risk_action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('dataLeakagePolicy.lowRiskAction')}
                      <Badge variant="secondary">Low Risk</Badge>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {actionOptions.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Safe Model Selection */}
          <Card>
            <CardHeader>
              <CardTitle>{t('dataLeakagePolicy.safeModelSelection')}</CardTitle>
              <CardDescription>{t('dataLeakagePolicy.safeModelSelectionDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="safe_model_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('dataLeakagePolicy.selectSafeModel')}</FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value === 'null' ? null : value)}
                      value={field.value || 'null'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectSafeModel')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="null">
                          {t('dataLeakagePolicy.currentSafeModel')} - {t('dataLeakagePolicy.defaultSafeModelLabel')}
                        </SelectItem>
                        {safeModels.map(model => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.config_name}
                            {model.is_default_safe_model && ` ${t('dataLeakagePolicy.defaultSafeModelLabel')}`}
                            {` (${t('dataLeakagePolicy.priorityLabel')}: ${model.safe_model_priority})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {safeModels.length === 0 && (
                      <FormDescription className="text-orange-600">
                        {t('dataLeakagePolicy.pleaseConfigureSafeModel')}
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Feature Toggles */}
          <Card>
            <CardHeader>
              <CardTitle>{t('dataLeakagePolicy.featureToggles')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <FormField
                control={form.control}
                name="enable_format_detection"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start justify-between space-y-0 rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        {t('dataLeakagePolicy.enableFormatDetection')}
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.enableFormatDetectionDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="enable_smart_segmentation"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start justify-between space-y-0 rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        {t('dataLeakagePolicy.enableSmartSegmentation')}
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.enableSmartSegmentationDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Submit Button */}
          <div className="flex justify-end">
            <Button type="submit" disabled={loading}>
              {loading ? t('common.loading') : t('dataLeakagePolicy.savePolicy')}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}

export default DataLeakagePolicyTab