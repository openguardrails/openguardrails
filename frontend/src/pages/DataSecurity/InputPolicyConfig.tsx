import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Upload, AlertTriangle } from 'lucide-react'

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

const inputPolicySchema = z.object({
  input_high_risk_action: z.enum(['block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass']).nullable(),
  input_medium_risk_action: z.enum(['block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass']).nullable(),
  input_low_risk_action: z.enum(['block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass']).nullable(),
  private_model_id: z.string().nullable(),
  enable_format_detection: z.boolean().nullable(),
  enable_smart_segmentation: z.boolean().nullable(),
})

type InputPolicyFormData = z.infer<typeof inputPolicySchema>

interface PrivateModel {
  id: string
  config_name: string
  provider: string
  model: string
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
}

interface InputPolicyConfigProps {
  policy: ApplicationPolicy | null
  hasPrivateModels: boolean
  onUpdate: () => void
}

const InputPolicyConfig: React.FC<InputPolicyConfigProps> = ({ policy, hasPrivateModels, onUpdate }) => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const { currentApplicationId } = useApplication()

  const form = useForm<InputPolicyFormData>({
    resolver: zodResolver(inputPolicySchema),
    defaultValues: {
      input_high_risk_action: null,
      input_medium_risk_action: null,
      input_low_risk_action: null,
      private_model_id: null,
      enable_format_detection: null,
      enable_smart_segmentation: null,
    },
  })

  // Update form when policy changes
  useEffect(() => {
    if (policy) {
      form.reset({
        input_high_risk_action: policy.input_high_risk_action_override,
        input_medium_risk_action: policy.input_medium_risk_action_override,
        input_low_risk_action: policy.input_low_risk_action_override,
        private_model_id: policy.private_model_override,
        enable_format_detection: policy.enable_format_detection_override,
        enable_smart_segmentation: policy.enable_smart_segmentation_override,
      })
    }
  }, [policy])

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
      onUpdate()
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
    { value: 'block', label: t('dataLeakagePolicy.actionBlock'), desc: t('dataLeakagePolicy.actionBlockDesc') },
    { value: 'switch_private_model', label: t('dataLeakagePolicy.actionSwitchPrivateModel'), desc: t('dataLeakagePolicy.actionSwitchPrivateModelDesc'), requiresPrivateModel: true },
    { value: 'anonymize', label: t('dataLeakagePolicy.actionAnonymize'), desc: t('dataLeakagePolicy.actionAnonymizeDesc') },
    { value: 'anonymize_restore', label: t('dataLeakagePolicy.actionAnonymizeRestore'), desc: t('dataLeakagePolicy.actionAnonymizeRestoreDesc') },
    { value: 'pass', label: t('dataLeakagePolicy.actionPass'), desc: t('dataLeakagePolicy.actionPassDesc') },
  ]

  const getResolvedValue = (fieldName: 'input_high_risk_action' | 'input_medium_risk_action' | 'input_low_risk_action') => {
    if (!policy) return ''
    return policy[fieldName]
  }

  return (
    <div className="space-y-6">
      {/* Description */}
      <Alert>
        <Upload className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t('dataLeakagePolicy.inputPolicyDescription')}</p>
          <p className="text-sm mt-1">{t('dataLeakagePolicy.inputPolicyDescriptionDetail')}</p>
        </AlertDescription>
      </Alert>

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
                      {policy && !field.value && (
                        <span className="text-xs text-muted-foreground">
                          ({t('dataLeakagePolicy.usingDefault')}: {getResolvedValue('input_high_risk_action')})
                        </span>
                      )}
                    </FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value === 'null' ? null : value)}
                      value={field.value || 'null'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectAction')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="null">{t('dataLeakagePolicy.useDefault')}</SelectItem>
                        {actionOptions.map(option => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={option.requiresPrivateModel && !hasPrivateModels}
                          >
                            {option.label}
                            {option.requiresPrivateModel && !hasPrivateModels && ' ⚠️'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {field.value && (
                      <FormDescription>
                        {actionOptions.find(opt => opt.value === field.value)?.desc}
                      </FormDescription>
                    )}
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
                      {policy && !field.value && (
                        <span className="text-xs text-muted-foreground">
                          ({t('dataLeakagePolicy.usingDefault')}: {getResolvedValue('input_medium_risk_action')})
                        </span>
                      )}
                    </FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value === 'null' ? null : value)}
                      value={field.value || 'null'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectAction')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="null">{t('dataLeakagePolicy.useDefault')}</SelectItem>
                        {actionOptions.map(option => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={option.requiresPrivateModel && !hasPrivateModels}
                          >
                            {option.label}
                            {option.requiresPrivateModel && !hasPrivateModels && ' ⚠️'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {field.value && (
                      <FormDescription>
                        {actionOptions.find(opt => opt.value === field.value)?.desc}
                      </FormDescription>
                    )}
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
                      {policy && !field.value && (
                        <span className="text-xs text-muted-foreground">
                          ({t('dataLeakagePolicy.usingDefault')}: {getResolvedValue('input_low_risk_action')})
                        </span>
                      )}
                    </FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value === 'null' ? null : value)}
                      value={field.value || 'null'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('dataLeakagePolicy.selectAction')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="null">{t('dataLeakagePolicy.useDefault')}</SelectItem>
                        {actionOptions.map(option => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={option.requiresPrivateModel && !hasPrivateModels}
                          >
                            {option.label}
                            {option.requiresPrivateModel && !hasPrivateModels && ' ⚠️'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {field.value && (
                      <FormDescription>
                        {actionOptions.find(opt => opt.value === field.value)?.desc}
                      </FormDescription>
                    )}
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
                        {t('dataLeakagePolicy.pleaseMarkModelsAsDataSafe')}
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
                        {policy && field.value === null && (
                          <span className="text-xs text-muted-foreground ml-2">
                            ({t('dataLeakagePolicy.usingDefault')}: {policy.enable_format_detection ? 'ON' : 'OFF'})
                          </span>
                        )}
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.enableFormatDetectionDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        {field.value !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => field.onChange(null)}
                          >
                            {t('dataLeakagePolicy.resetToDefault')}
                          </Button>
                        )}
                        <Switch
                          checked={field.value !== null ? field.value : policy?.enable_format_detection || false}
                          onCheckedChange={(checked) => field.onChange(checked)}
                        />
                      </div>
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
                        {policy && field.value === null && (
                          <span className="text-xs text-muted-foreground ml-2">
                            ({t('dataLeakagePolicy.usingDefault')}: {policy.enable_smart_segmentation ? 'ON' : 'OFF'})
                          </span>
                        )}
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.enableSmartSegmentationDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        {field.value !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => field.onChange(null)}
                          >
                            {t('dataLeakagePolicy.resetToDefault')}
                          </Button>
                        )}
                        <Switch
                          checked={field.value !== null ? field.value : policy?.enable_smart_segmentation || false}
                          onCheckedChange={(checked) => field.onChange(checked)}
                        />
                      </div>
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

export default InputPolicyConfig
