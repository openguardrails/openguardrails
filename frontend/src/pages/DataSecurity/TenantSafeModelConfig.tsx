import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Shield, Info } from 'lucide-react'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { dataLeakagePolicyApi } from '../../services/api'

const privateModelSchema = z.object({
  default_private_model_id: z.string().nullable(),
})

type PrivateModelFormData = z.infer<typeof privateModelSchema>

interface PrivateModel {
  id: string
  config_name: string
  provider: string
  api_base_url: string
  is_data_safe: boolean
  is_default_private_model: boolean
  private_model_priority: number
}

interface TenantPolicy {
  id: string
  tenant_id: string
  default_private_model: PrivateModel | null
  available_private_models: PrivateModel[]
  default_input_high_risk_action: string
  default_input_medium_risk_action: string
  default_input_low_risk_action: string
  default_output_high_risk_anonymize: boolean
  default_output_medium_risk_anonymize: boolean
  default_output_low_risk_anonymize: boolean
  default_enable_format_detection: boolean
  default_enable_smart_segmentation: boolean
}

const TenantPrivateModelConfig: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [policy, setPolicy] = useState<TenantPolicy | null>(null)

  const form = useForm<PrivateModelFormData>({
    resolver: zodResolver(privateModelSchema),
    defaultValues: {
      default_private_model_id: null,
    },
  })

  // Fetch tenant default policy
  const fetchTenantPolicy = async () => {
    setLoading(true)
    try {
      const data = await dataLeakagePolicyApi.getTenantDefaults()
      setPolicy(data)
      form.reset({
        default_private_model_id: data.default_private_model?.id || null,
      })
    } catch (error: any) {
      console.error('Failed to fetch tenant policy:', error)
      toast.error(t('dataLeakagePolicy.fetchPolicyFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTenantPolicy()
  }, [])

  // Save tenant default private model
  const onSubmit = async (values: PrivateModelFormData) => {
    if (!policy) return

    setLoading(true)
    try {
      await dataLeakagePolicyApi.updateTenantDefaults({
        default_input_high_risk_action: policy.default_input_high_risk_action,
        default_input_medium_risk_action: policy.default_input_medium_risk_action,
        default_input_low_risk_action: policy.default_input_low_risk_action,
        default_output_high_risk_anonymize: policy.default_output_high_risk_anonymize,
        default_output_medium_risk_anonymize: policy.default_output_medium_risk_anonymize,
        default_output_low_risk_anonymize: policy.default_output_low_risk_anonymize,
        default_private_model_id: values.default_private_model_id,
        default_enable_format_detection: policy.default_enable_format_detection,
        default_enable_smart_segmentation: policy.default_enable_smart_segmentation,
      })
      toast.success(t('dataLeakagePolicy.saveTenantDefaultSuccess'))
      await fetchTenantPolicy()
    } catch (error: any) {
      console.error('Failed to save tenant default private model:', error)
      const errorMessage = error.response?.data?.error || error.response?.data?.detail || t('dataLeakagePolicy.saveTenantDefaultFailed')
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const hasPrivateModels = policy && policy.available_private_models && policy.available_private_models.length > 0

  if (loading && !policy) {
    return (
      <div className="flex items-center justify-center h-32">
        <p>{t('dataLeakagePolicy.loading')}</p>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          {t('dataLeakagePolicy.tenantDefaultPrivateModelConfig')}
        </CardTitle>
        <CardDescription>
          {t('dataLeakagePolicy.tenantDefaultPrivateModelConfigDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Info Banner */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            <p className="text-sm">{t('dataLeakagePolicy.tenantPrivateModelInfoDesc')}</p>
          </AlertDescription>
        </Alert>

        {!hasPrivateModels && (
          <Alert variant="destructive">
            <AlertDescription>
              <p className="font-semibold">{t('dataLeakagePolicy.noPrivateModelsWarning')}</p>
              <p className="text-sm mt-1">{t('dataLeakagePolicy.pleaseMarkModelsAsDataSafe')}</p>
            </AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="default_private_model_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('dataLeakagePolicy.selectDefaultPrivateModel')}</FormLabel>
                  <Select
                    onValueChange={(value) => field.onChange(value === 'null' ? null : value)}
                    value={field.value || 'null'}
                    disabled={!hasPrivateModels}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={
                          hasPrivateModels
                            ? t('dataLeakagePolicy.selectDefaultPrivateModel')
                            : t('dataLeakagePolicy.noPrivateModelsAvailable')
                        } />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="null">
                        {t('dataLeakagePolicy.noDefaultPrivateModel')}
                      </SelectItem>
                      {policy?.available_private_models?.map(model => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.config_name}
                          {model.provider && ` (${model.provider})`}
                          {model.is_default_private_model && ` ✓ ${t('dataLeakagePolicy.currentDefault')}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t('dataLeakagePolicy.tenantDefaultPrivateModelDesc')}
                  </FormDescription>
                </FormItem>
              )}
            />

            <div className="flex justify-end">
              <Button type="submit" disabled={loading || !hasPrivateModels}>
                {loading ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

export default TenantPrivateModelConfig
