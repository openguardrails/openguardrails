import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Upload, AlertTriangle, AlertCircle, Info } from 'lucide-react'

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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { dataLeakagePolicyApi } from '../../services/api'
import { useApplication } from '../../contexts/ApplicationContext'
import { useAuth } from '../../contexts/AuthContext'

const inputPolicySchema = z.object({
  input_high_risk_action: z.enum(['block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass']),
  input_medium_risk_action: z.enum(['block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass']),
  input_low_risk_action: z.enum(['block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass']),
  private_model_id: z.string().nullable(),
  enable_format_detection: z.boolean(),
  enable_smart_segmentation: z.boolean(),
})

type InputPolicyFormData = z.infer<typeof inputPolicySchema>

interface PrivateModel {
  id: string
  config_name: string
  provider: string
  api_base_url: string
  is_data_safe: boolean
  is_default_private_model: boolean
  private_model_priority: number
}

interface ApplicationPolicy {
  id: string
  application_id: string
  input_high_risk_action: string
  input_medium_risk_action: string
  input_low_risk_action: string
  input_high_risk_action_override: string | null
  input_medium_risk_action_override: string | null
  input_low_risk_action_override: string | null
  private_model: PrivateModel | null
  private_model_override: string | null
  available_private_models: PrivateModel[]
  enable_format_detection: boolean
  enable_smart_segmentation: boolean
  enable_format_detection_override: boolean | null
  enable_smart_segmentation_override: boolean | null
  output_high_risk_anonymize_override: boolean | null
  output_medium_risk_anonymize_override: boolean | null
  output_low_risk_anonymize_override: boolean | null
}

const InputPolicyTab: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [policy, setPolicy] = useState<ApplicationPolicy | null>(null)
  const { currentApplicationId } = useApplication()
  const { onUserSwitch } = useAuth()

  const form = useForm<InputPolicyFormData>({
    resolver: zodResolver(inputPolicySchema),
    defaultValues: {
      input_high_risk_action: 'block',
      input_medium_risk_action: 'anonymize',
      input_low_risk_action: 'pass',
      private_model_id: null,
      enable_format_detection: true,
      enable_smart_segmentation: true,
    },
  })

  // Fetch policy data
  const fetchPolicy = async () => {
    if (!currentApplicationId) return

    setLoading(true)
    try {
      const data = await dataLeakagePolicyApi.getPolicy(currentApplicationId)
      setPolicy(data)
      form.reset({
        input_high_risk_action: data.input_high_risk_action_override || data.input_high_risk_action || 'block',
        input_medium_risk_action: data.input_medium_risk_action_override || data.input_medium_risk_action || 'anonymize',
        input_low_risk_action: data.input_low_risk_action_override || data.input_low_risk_action || 'pass',
        private_model_id: data.private_model_override,
        enable_format_detection: data.enable_format_detection_override,
        enable_smart_segmentation: data.enable_smart_segmentation_override,
      })
    } catch (error: any) {
      console.error('Failed to fetch policy:', error)
      toast.error(t('dataLeakagePolicy.fetchPolicyFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPolicy()
  }, [currentApplicationId])

  // Listen to user switch event
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchPolicy()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Save policy
  const onSubmit = async (values: InputPolicyFormData) => {
    if (!currentApplicationId) {
      toast.error('No application selected')
      return
    }

    setLoading(true)
    try {
      await dataLeakagePolicyApi.updatePolicy(currentApplicationId, {
        input_high_risk_action: values.input_high_risk_action,
        input_medium_risk_action: values.input_medium_risk_action,
        input_low_risk_action: values.input_low_risk_action,
        private_model_id: values.private_model_id,
        enable_format_detection: values.enable_format_detection,
        enable_smart_segmentation: values.enable_smart_segmentation,
        // Output policy fields - keep current values (don't modify)
        output_high_risk_anonymize: policy?.output_high_risk_anonymize_override,
        output_medium_risk_anonymize: policy?.output_medium_risk_anonymize_override,
        output_low_risk_anonymize: policy?.output_low_risk_anonymize_override,
      })
      toast.success(t('dataLeakagePolicy.savePolicySuccess'))
      fetchPolicy()
    } catch (error: any) {
      console.error('Failed to save policy:', error)
      const errorMessage = error.response?.data?.error || error.response?.data?.detail || t('dataLeakagePolicy.savePolicyFailed')
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (loading && !policy) {
    return (
      <div className="flex items-center justify-center h-64">
        <p>{t('dataLeakagePolicy.loading')}</p>
      </div>
    )
  }

  const hasPrivateModels = policy && policy.available_private_models && policy.available_private_models.length > 0

  // Action options
  const actionOptions = [
    { value: 'block', label: t('dataLeakagePolicy.actionBlock'), desc: t('dataLeakagePolicy.actionBlockDesc'), isDefault: ['input_high_risk_action'].includes('input_high_risk_action') },
    { value: 'switch_private_model', label: t('dataLeakagePolicy.actionSwitchPrivateModel'), desc: t('dataLeakagePolicy.actionSwitchPrivateModelDesc'), requiresPrivateModel: true, isDefault: false },
    { value: 'anonymize', label: t('dataLeakagePolicy.actionAnonymize'), desc: t('dataLeakagePolicy.actionAnonymizeDesc'), isDefault: ['input_medium_risk_action'].includes('input_medium_risk_action') },
    { value: 'anonymize_restore', label: t('dataLeakagePolicy.actionAnonymizeRestore'), desc: t('dataLeakagePolicy.actionAnonymizeRestoreDesc'), isDefault: false },
    { value: 'pass', label: t('dataLeakagePolicy.actionPass'), desc: t('dataLeakagePolicy.actionPassDesc'), isDefault: ['input_low_risk_action'].includes('input_low_risk_action') },
  ]

  const getDefaultAction = (fieldName: 'input_high_risk_action' | 'input_medium_risk_action' | 'input_low_risk_action') => {
    if (fieldName === 'input_high_risk_action') return 'block'
    if (fieldName === 'input_medium_risk_action') return 'anonymize'
    return 'pass'
  }

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t('dataLeakagePolicy.gatewayModeOnly')}</p>
          <p className="text-sm mt-1">{t('dataLeakagePolicy.gatewayModeOnlyDesc')}</p>
        </AlertDescription>
      </Alert>

      {/* Description */}
      <Alert>
        <Upload className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t('dataLeakagePolicy.inputPolicyDescription')}</p>
          <p className="text-sm mt-1">{t('dataLeakagePolicy.inputPolicyDescriptionDetail')}</p>
        </AlertDescription>
      </Alert>

      {/* Private Model Warning */}
      {!hasPrivateModels && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <p className="font-semibold">{t('dataLeakagePolicy.noPrivateModelsWarning')}</p>
            <p className="text-sm mt-1">
              {t('dataLeakagePolicy.noPrivateModelsWarningDesc')}
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Risk Level Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                {t('dataLeakagePolicy.riskLevelActions')}
              </CardTitle>
              <CardDescription>
                {t('dataLeakagePolicy.inputRiskActionsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* High Risk Action */}
              <FormField
                control={form.control}
                name="input_high_risk_action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('dataLeakagePolicy.highRiskAction')}
                      <Badge variant="destructive">High Risk</Badge>
                    </FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value)}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectAction')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {actionOptions.map(option => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={option.requiresPrivateModel && !hasPrivateModels}
                          >
                            {option.label}
                            {option.value === 'block' && ' (默认值)'}
                            {option.requiresPrivateModel && !hasPrivateModels && ' ⚠️'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {actionOptions.find(opt => opt.value === field.value)?.desc}
                    </FormDescription>
                  </FormItem>
                )}
              />

              {/* Medium Risk Action */}
              <FormField
                control={form.control}
                name="input_medium_risk_action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('dataLeakagePolicy.mediumRiskAction')}
                      <Badge variant="default" className="bg-orange-500">Medium Risk</Badge>
                    </FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value)}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectAction')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {actionOptions.map(option => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={option.requiresPrivateModel && !hasPrivateModels}
                          >
                            {option.label}
                            {option.value === 'anonymize' && ' (默认值)'}
                            {option.requiresPrivateModel && !hasPrivateModels && ' ⚠️'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {actionOptions.find(opt => opt.value === field.value)?.desc}
                    </FormDescription>
                  </FormItem>
                )}
              />

              {/* Low Risk Action */}
              <FormField
                control={form.control}
                name="input_low_risk_action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('dataLeakagePolicy.lowRiskAction')}
                      <Badge variant="secondary">Low Risk</Badge>
                    </FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value)}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectAction')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {actionOptions.map(option => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={option.requiresPrivateModel && !hasPrivateModels}
                          >
                            {option.label}
                            {option.value === 'pass' && ' (默认值)'}
                            {option.requiresPrivateModel && !hasPrivateModels && ' ⚠️'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {actionOptions.find(opt => opt.value === field.value)?.desc}
                    </FormDescription>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Private Model Selection */}
          <Card>
            <CardHeader>
              <CardTitle>{t('dataLeakagePolicy.privateModelSelection')}</CardTitle>
              <CardDescription>{t('dataLeakagePolicy.privateModelSelectionInputDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="private_model_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('dataLeakagePolicy.selectPrivateModel')}</FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value === 'null' ? null : value)}
                      value={field.value || 'null'}
                      disabled={!hasPrivateModels}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={
                            hasPrivateModels
                              ? t('dataLeakagePolicy.selectPrivateModel')
                              : t('dataLeakagePolicy.noPrivateModelsAvailable')
                          } />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="null">
                          {t('dataLeakagePolicy.useDefault')} - {t('dataLeakagePolicy.tenantDefaultPrivateModel')}
                        </SelectItem>
                        {policy?.available_private_models?.map(model => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.config_name}
                            {model.is_default_private_model && ` [${t('dataLeakagePolicy.defaultLabel')}]`}
                            {` (${t('dataLeakagePolicy.priorityLabel')}: ${model.private_model_priority})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!hasPrivateModels && (
                      <FormDescription className="text-orange-600">
                        {t('dataLeakagePolicy.pleaseConfigurePrivateModelInGateway')}
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
                    <div className="space-y-0.5 flex-1">
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
                        onCheckedChange={(checked) => field.onChange(checked)}
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
                    <div className="space-y-0.5 flex-1">
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
                        onCheckedChange={(checked) => field.onChange(checked)}
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

export default InputPolicyTab
