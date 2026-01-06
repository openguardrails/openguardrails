import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Settings2, Info } from 'lucide-react'

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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { dataLeakagePolicyApi } from '../../services/api'
import { useApplication } from '../../contexts/ApplicationContext'
import { useAuth } from '../../contexts/AuthContext'

const smartProcessingSchema = z.object({
  enable_format_detection: z.boolean(),
  enable_smart_segmentation: z.boolean(),
})

type SmartProcessingFormData = z.infer<typeof smartProcessingSchema>

interface ApplicationPolicy {
  id: string
  application_id: string
  enable_format_detection: boolean
  enable_smart_segmentation: boolean
  enable_format_detection_override: boolean | null
  enable_smart_segmentation_override: boolean | null
  input_high_risk_action_override: string | null
  input_medium_risk_action_override: string | null
  input_low_risk_action_override: string | null
  private_model_override: string | null
  output_high_risk_anonymize_override: boolean | null
  output_medium_risk_anonymize_override: boolean | null
  output_low_risk_anonymize_override: boolean | null
}

const SmartProcessingTab: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [policy, setPolicy] = useState<ApplicationPolicy | null>(null)
  const { currentApplicationId } = useApplication()
  const { onUserSwitch } = useAuth()

  const form = useForm<SmartProcessingFormData>({
    resolver: zodResolver(smartProcessingSchema),
    defaultValues: {
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
        enable_format_detection: data.enable_format_detection_override ?? data.enable_format_detection ?? true,
        enable_smart_segmentation: data.enable_smart_segmentation_override ?? data.enable_smart_segmentation ?? true,
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
  const onSubmit = async (values: SmartProcessingFormData) => {
    if (!currentApplicationId) {
      toast.error('No application selected')
      return
    }

    setLoading(true)
    try {
      await dataLeakagePolicyApi.updatePolicy(currentApplicationId, {
        enable_format_detection: values.enable_format_detection,
        enable_smart_segmentation: values.enable_smart_segmentation,
        // Keep existing values for other fields
        input_high_risk_action: policy?.input_high_risk_action_override,
        input_medium_risk_action: policy?.input_medium_risk_action_override,
        input_low_risk_action: policy?.input_low_risk_action_override,
        private_model_id: policy?.private_model_override,
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

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t('dataSecurity.smartProcessingDescription')}</p>
          <p className="text-sm mt-1">{t('dataSecurity.smartProcessingDescriptionDetail')}</p>
        </AlertDescription>
      </Alert>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Smart Processing Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" />
                {t('dataSecurity.smartProcessingSettings')}
              </CardTitle>
              <CardDescription>
                {t('dataSecurity.smartProcessingSettingsDesc')}
              </CardDescription>
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

export default SmartProcessingTab
