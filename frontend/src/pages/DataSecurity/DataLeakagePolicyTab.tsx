import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Shield, AlertCircle, Info } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useApplication } from '../../contexts/ApplicationContext'
import { useAuth } from '../../contexts/AuthContext'

import InputPolicyConfig from './InputPolicyConfig'
import OutputPolicyConfig from './OutputPolicyConfig'
import TenantPrivateModelConfig from './TenantPrivateModelConfig'
import { dataLeakagePolicyApi } from '../../services/api'

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

  // Resolved values (what's actually used)
  input_high_risk_action: string
  input_medium_risk_action: string
  input_low_risk_action: string
  output_high_risk_anonymize: boolean
  output_medium_risk_anonymize: boolean
  output_low_risk_anonymize: boolean
  enable_format_detection: boolean
  enable_smart_segmentation: boolean

  // Overrides (what's stored in DB, NULL = inherit from tenant)
  input_high_risk_action_override: string | null
  input_medium_risk_action_override: string | null
  input_low_risk_action_override: string | null
  output_high_risk_anonymize_override: boolean | null
  output_medium_risk_anonymize_override: boolean | null
  output_low_risk_anonymize_override: boolean | null
  private_model_override: string | null
  enable_format_detection_override: boolean | null
  enable_smart_segmentation_override: boolean | null

  private_model: PrivateModel | null
  available_private_models: PrivateModel[]
  created_at: string
  updated_at: string
}

const DataLeakagePolicyTab: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [policy, setPolicy] = useState<ApplicationPolicy | null>(null)
  const { currentApplicationId } = useApplication()
  const { onUserSwitch } = useAuth()

  // Fetch policy data
  const fetchPolicy = async () => {
    if (!currentApplicationId) return

    setLoading(true)
    try {
      const data = await dataLeakagePolicyApi.getPolicy(currentApplicationId)
      setPolicy(data)
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

  if (loading && !policy) {
    return (
      <div className="flex items-center justify-center h-64">
        <p>{t('dataLeakagePolicy.loading')}</p>
      </div>
    )
  }

  const hasPrivateModels = policy && policy.available_private_models && policy.available_private_models.length > 0

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

      {/* Tenant-level Default Private Model Configuration */}
      <TenantPrivateModelConfig />

      {/* Policy Configuration Tabs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t('dataLeakagePolicy.policyConfiguration')}
          </CardTitle>
          <CardDescription>
            {t('dataLeakagePolicy.policyConfigurationDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="input" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="input">
                📥 {t('dataLeakagePolicy.inputPolicyTab')}
              </TabsTrigger>
              <TabsTrigger value="output">
                📤 {t('dataLeakagePolicy.outputPolicyTab')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="input" className="mt-6">
              <InputPolicyConfig
                policy={policy}
                hasPrivateModels={hasPrivateModels}
                onUpdate={fetchPolicy}
              />
            </TabsContent>

            <TabsContent value="output" className="mt-6">
              <OutputPolicyConfig
                policy={policy}
                onUpdate={fetchPolicy}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

export default DataLeakagePolicyTab
