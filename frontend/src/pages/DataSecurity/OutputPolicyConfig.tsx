import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Download } from 'lucide-react'

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
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { dataLeakagePolicyApi } from '../../services/api'
import { useApplication } from '../../contexts/ApplicationContext'

const outputPolicySchema = z.object({
  output_high_risk_anonymize: z.boolean().nullable(),
  output_medium_risk_anonymize: z.boolean().nullable(),
  output_low_risk_anonymize: z.boolean().nullable(),
})

type OutputPolicyFormData = z.infer<typeof outputPolicySchema>

interface ApplicationPolicy {
  id: string
  application_id: string
  output_high_risk_anonymize: boolean
  output_medium_risk_anonymize: boolean
  output_low_risk_anonymize: boolean
  output_high_risk_anonymize_override: boolean | null
  output_medium_risk_anonymize_override: boolean | null
  output_low_risk_anonymize_override: boolean | null
  input_high_risk_action_override: string | null
  input_medium_risk_action_override: string | null
  input_low_risk_action_override: string | null
  private_model_override: string | null
  enable_format_detection_override: boolean | null
  enable_smart_segmentation_override: boolean | null
}

interface OutputPolicyConfigProps {
  policy: ApplicationPolicy | null
  onUpdate: () => void
}

const OutputPolicyConfig: React.FC<OutputPolicyConfigProps> = ({ policy, onUpdate }) => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const { currentApplicationId } = useApplication()

  const form = useForm<OutputPolicyFormData>({
    resolver: zodResolver(outputPolicySchema),
    defaultValues: {
      output_high_risk_anonymize: null,
      output_medium_risk_anonymize: null,
      output_low_risk_anonymize: null,
    },
  })

  // Update form when policy changes
  useEffect(() => {
    if (policy) {
      form.reset({
        output_high_risk_anonymize: policy.output_high_risk_anonymize_override,
        output_medium_risk_anonymize: policy.output_medium_risk_anonymize_override,
        output_low_risk_anonymize: policy.output_low_risk_anonymize_override,
      })
    }
  }, [policy])

  // Save policy
  const onSubmit = async (values: OutputPolicyFormData) => {
    if (!currentApplicationId) {
      toast.error('No application selected')
      return
    }

    setLoading(true)
    try {
      await dataLeakagePolicyApi.updatePolicy(currentApplicationId, {
        output_high_risk_anonymize: values.output_high_risk_anonymize,
        output_medium_risk_anonymize: values.output_medium_risk_anonymize,
        output_low_risk_anonymize: values.output_low_risk_anonymize,
        // Input policy fields - keep current values (don't modify)
        input_high_risk_action: policy?.input_high_risk_action_override,
        input_medium_risk_action: policy?.input_medium_risk_action_override,
        input_low_risk_action: policy?.input_low_risk_action_override,
        private_model_id: policy?.private_model_override,
        enable_format_detection: policy?.enable_format_detection_override,
        enable_smart_segmentation: policy?.enable_smart_segmentation_override,
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

  const getResolvedValue = (fieldName: 'output_high_risk_anonymize' | 'output_medium_risk_anonymize' | 'output_low_risk_anonymize') => {
    if (!policy) return false
    return policy[fieldName]
  }

  return (
    <div className="space-y-6">
      {/* Description */}
      <Alert>
        <Download className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t('dataLeakagePolicy.outputPolicyDescription')}</p>
          <p className="text-sm mt-1">{t('dataLeakagePolicy.outputPolicyDescriptionDetail')}</p>
        </AlertDescription>
      </Alert>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Output Anonymization Settings */}
          <Card>
            <CardHeader>
              <CardTitle>{t('dataLeakagePolicy.outputAnonymizationSettings')}</CardTitle>
              <CardDescription>
                {t('dataLeakagePolicy.outputAnonymizationSettingsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* High Risk Anonymization */}
              <FormField
                control={form.control}
                name="output_high_risk_anonymize"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start justify-between space-y-0 rounded-lg border p-4">
                    <div className="space-y-0.5 flex-1">
                      <FormLabel className="text-base flex items-center gap-2">
                        {t('dataLeakagePolicy.highRiskOutputAnonymize')}
                        <Badge variant="destructive">High Risk</Badge>
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.highRiskOutputAnonymizeDesc')}
                        {field.value === null && policy && (
                          <span className="block mt-1 text-xs text-muted-foreground">
                            {t('dataLeakagePolicy.usingDefault')}: {getResolvedValue('output_high_risk_anonymize') ? t('dataLeakagePolicy.anonymizeEnabled') : t('dataLeakagePolicy.anonymizeDisabled')}
                          </span>
                        )}
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
                          checked={field.value !== null ? field.value : getResolvedValue('output_high_risk_anonymize')}
                          onCheckedChange={(checked) => field.onChange(checked)}
                        />
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />

              {/* Medium Risk Anonymization */}
              <FormField
                control={form.control}
                name="output_medium_risk_anonymize"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start justify-between space-y-0 rounded-lg border p-4">
                    <div className="space-y-0.5 flex-1">
                      <FormLabel className="text-base flex items-center gap-2">
                        {t('dataLeakagePolicy.mediumRiskOutputAnonymize')}
                        <Badge variant="default" className="bg-orange-500">Medium Risk</Badge>
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.mediumRiskOutputAnonymizeDesc')}
                        {field.value === null && policy && (
                          <span className="block mt-1 text-xs text-muted-foreground">
                            {t('dataLeakagePolicy.usingDefault')}: {getResolvedValue('output_medium_risk_anonymize') ? t('dataLeakagePolicy.anonymizeEnabled') : t('dataLeakagePolicy.anonymizeDisabled')}
                          </span>
                        )}
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
                          checked={field.value !== null ? field.value : getResolvedValue('output_medium_risk_anonymize')}
                          onCheckedChange={(checked) => field.onChange(checked)}
                        />
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />

              {/* Low Risk Anonymization */}
              <FormField
                control={form.control}
                name="output_low_risk_anonymize"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start justify-between space-y-0 rounded-lg border p-4">
                    <div className="space-y-0.5 flex-1">
                      <FormLabel className="text-base flex items-center gap-2">
                        {t('dataLeakagePolicy.lowRiskOutputAnonymize')}
                        <Badge variant="secondary">Low Risk</Badge>
                      </FormLabel>
                      <FormDescription>
                        {t('dataLeakagePolicy.lowRiskOutputAnonymizeDesc')}
                        {field.value === null && policy && (
                          <span className="block mt-1 text-xs text-muted-foreground">
                            {t('dataLeakagePolicy.usingDefault')}: {getResolvedValue('output_low_risk_anonymize') ? t('dataLeakagePolicy.anonymizeEnabled') : t('dataLeakagePolicy.anonymizeDisabled')}
                          </span>
                        )}
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
                          checked={field.value !== null ? field.value : getResolvedValue('output_low_risk_anonymize')}
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

export default OutputPolicyConfig
