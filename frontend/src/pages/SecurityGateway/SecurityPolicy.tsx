import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Shield, AlertTriangle, Lock, Save } from 'lucide-react'
import { gatewayPolicyApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'

interface PrivateModel {
  id: string
  config_name: string
  provider?: string
  is_default_private_model: boolean
  private_model_names: string[]
}

interface GatewayPolicy {
  id: string
  application_id: string
  // General risk policy
  general_high_risk_action: string
  general_medium_risk_action: string
  general_low_risk_action: string
  general_high_risk_action_override: string | null
  general_medium_risk_action_override: string | null
  general_low_risk_action_override: string | null
  // Input policy
  input_high_risk_action: string
  input_medium_risk_action: string
  input_low_risk_action: string
  input_high_risk_action_override: string | null
  input_medium_risk_action_override: string | null
  input_low_risk_action_override: string | null
  // Output policy
  output_high_risk_action: string
  output_medium_risk_action: string
  output_low_risk_action: string
  output_high_risk_action_override: string | null
  output_medium_risk_action_override: string | null
  output_low_risk_action_override: string | null
  // Private model
  private_model: PrivateModel | null
  private_model_override: string | null
  available_private_models: PrivateModel[]
}

const SecurityPolicy: React.FC = () => {
  const { t } = useTranslation()
  const { onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()
  const [policy, setPolicy] = useState<GatewayPolicy | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'general' | 'data-leakage'>('general')

  // Form state
  const [formData, setFormData] = useState({
    // General risk
    general_high_risk_action: 'block' as string,
    general_medium_risk_action: 'block' as string,
    general_low_risk_action: 'block' as string,
    // Input
    input_high_risk_action: 'block' as string,
    input_medium_risk_action: 'anonymize' as string,
    input_low_risk_action: 'pass' as string,
    // Output
    output_high_risk_action: 'pass' as string,
    output_medium_risk_action: 'pass' as string,
    output_low_risk_action: 'pass' as string,
    // Private model
    private_model_id: null as string | null,
  })

  // Fetch policy
  const fetchPolicy = async () => {
    if (!currentApplicationId) return

    setLoading(true)
    try {
      const data = await gatewayPolicyApi.getPolicy(currentApplicationId)
      setPolicy(data)
      setFormData({
        general_high_risk_action: data.general_high_risk_action_override || data.general_high_risk_action,
        general_medium_risk_action: data.general_medium_risk_action_override || data.general_medium_risk_action,
        general_low_risk_action: data.general_low_risk_action_override || data.general_low_risk_action,
        input_high_risk_action: data.input_high_risk_action_override || data.input_high_risk_action,
        input_medium_risk_action: data.input_medium_risk_action_override || data.input_medium_risk_action,
        input_low_risk_action: data.input_low_risk_action_override || data.input_low_risk_action,
        output_high_risk_action: data.output_high_risk_action_override || data.output_high_risk_action,
        output_medium_risk_action: data.output_medium_risk_action_override || data.output_medium_risk_action,
        output_low_risk_action: data.output_low_risk_action_override || data.output_low_risk_action,
        private_model_id: data.private_model_override,
      })
    } catch (error) {
      console.error('Failed to fetch policy:', error)
      toast.error(t('gateway.fetchPolicyFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPolicy()
  }, [currentApplicationId])

  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchPolicy()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Save policy
  const handleSave = async () => {
    if (!currentApplicationId) return

    setSaving(true)
    try {
      await gatewayPolicyApi.updatePolicy(currentApplicationId, formData)
      toast.success(t('gateway.policySaved'))
      fetchPolicy()
    } catch (error) {
      console.error('Failed to save policy:', error)
      toast.error(t('gateway.savePolicyFailed'))
    } finally {
      setSaving(false)
    }
  }

  // Reset field to default
  const resetField = (field: keyof typeof formData) => {
    setFormData(prev => ({ ...prev, [field]: null }))
  }

  // General risk action options
  const generalRiskActions = [
    { value: 'block', label: t('gateway.actionBlock'), description: t('gateway.actionBlockDesc') },
    { value: 'replace', label: t('gateway.actionReplace'), description: t('gateway.actionReplaceDesc') },
    { value: 'pass', label: t('gateway.actionPass'), description: t('gateway.actionPassDesc') },
  ]

  // Data leakage action options - input/output with defaults
  const inputRiskActions = [
    { value: 'block', label: t('gateway.actionBlock'), description: t('gateway.actionBlockDesc') },
    { value: 'switch_private_model', label: t('gateway.actionSwitchPrivate'), description: t('gateway.actionSwitchPrivateDesc') },
    { value: 'anonymize', label: t('gateway.actionAnonymize'), description: t('gateway.actionAnonymizeDesc') },
    { value: 'pass', label: t('gateway.actionPass'), description: t('gateway.actionPassDesc') },
  ]

  const outputRiskActions = [
    { value: 'block', label: t('gateway.actionBlock'), description: t('gateway.actionBlockDesc') },
    { value: 'anonymize', label: t('gateway.actionAnonymize'), description: t('gateway.actionAnonymizeDesc') },
    { value: 'pass', label: t('gateway.actionPass'), description: t('gateway.actionPassDesc') },
  ]

  const hasPrivateModels = policy?.available_private_models && policy.available_private_models.length > 0

  // Risk level row component
  const RiskLevelRow = ({
    level,
    label,
    actions,
    field,
  }: {
    level: 'high' | 'medium' | 'low'
    label: string
    actions: { value: string; label: string; description?: string }[]
    field: keyof typeof formData
  }) => {
    const levelColors = {
      high: 'bg-red-100 text-red-800 border-red-200',
      medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      low: 'bg-green-100 text-green-800 border-green-200',
    }

    return (
      <div className="flex items-center justify-between py-3 border-b last:border-b-0">
        <Badge variant="outline" className={levelColors[level]}>
          {label}
        </Badge>
        <div className="flex items-center gap-2">
          <Select
            value={formData[field] as string}
            onValueChange={(value) => setFormData(prev => ({
              ...prev,
              [field]: value
            }))}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actions.map((action) => (
                <SelectItem
                  key={action.value}
                  value={action.value}
                  disabled={action.value === 'switch_private_model' && !hasPrivateModels}
                >
                  {action.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-96 mt-2" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!currentApplicationId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          {t('gateway.selectApplicationFirst')}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <div>
              <CardTitle>{t('gateway.securityPolicyTitle')}</CardTitle>
              <CardDescription>{t('gateway.securityPolicyDescription')}</CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving}>
              <Save className="h-4 w-4 mr-1" />
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'general' | 'data-leakage')} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="general" className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                {t('gateway.generalRiskPolicy')}
              </TabsTrigger>
              <TabsTrigger value="data-leakage" className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                {t('gateway.dataLeakagePolicy')}
              </TabsTrigger>
            </TabsList>

            {/* General Risk Policy Tab */}
            <TabsContent value="general" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('gateway.generalRiskPolicyTitle')}</CardTitle>
                  <CardDescription>{t('gateway.generalRiskPolicyDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  {policy && (
                    <div className="space-y-1">
                      <RiskLevelRow
                        level="high"
                        label={t('gateway.highRisk')}
                        actions={generalRiskActions}
                        field="general_high_risk_action"
                      />
                      <RiskLevelRow
                        level="medium"
                        label={t('gateway.mediumRisk')}
                        actions={generalRiskActions}
                        field="general_medium_risk_action"
                      />
                      <RiskLevelRow
                        level="low"
                        label={t('gateway.lowRisk')}
                        actions={generalRiskActions}
                        field="general_low_risk_action"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Data Leakage Policy Tab */}
            <TabsContent value="data-leakage" className="mt-4 space-y-4">
              {/* Private model warning */}
              {!hasPrivateModels && (
                <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg">
                  <p className="text-sm text-orange-800">
                    {t('gateway.noPrivateModelsWarning')}
                  </p>
                </div>
              )}

              {/* Private model selection */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('gateway.privateModelSelection')}</CardTitle>
                  <CardDescription>{t('gateway.privateModelSelectionDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Select
                    value={formData.private_model_id || 'default'}
                    onValueChange={(value) => setFormData(prev => ({
                      ...prev,
                      private_model_id: value === 'default' ? null : value
                    }))}
                    disabled={!hasPrivateModels}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('gateway.selectPrivateModel')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {t('gateway.useDefaultPrivateModel')}
                      </SelectItem>
                      {policy?.available_private_models?.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.config_name}
                          {model.is_default_private_model && ` [${t('gateway.defaultBadge')}]`}
                          {model.provider && ` (${model.provider})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>

              {/* Input Policy */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('gateway.inputPolicy')}</CardTitle>
                  <CardDescription>{t('gateway.inputPolicyDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  {policy && (
                    <div className="space-y-1">
                      <RiskLevelRow
                        level="high"
                        label={t('gateway.highRisk')}
                        actions={inputRiskActions}
                        field="input_high_risk_action"
                      />
                      <RiskLevelRow
                        level="medium"
                        label={t('gateway.mediumRisk')}
                        actions={inputRiskActions}
                        field="input_medium_risk_action"
                      />
                      <RiskLevelRow
                        level="low"
                        label={t('gateway.lowRisk')}
                        actions={inputRiskActions}
                        field="input_low_risk_action"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Output Policy */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('gateway.outputPolicy')}</CardTitle>
                  <CardDescription>{t('gateway.outputPolicyDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  {policy && (
                    <div className="space-y-1">
                      <RiskLevelRow
                        level="high"
                        label={t('gateway.highRisk')}
                        actions={outputRiskActions}
                        field="output_high_risk_action"
                      />
                      <RiskLevelRow
                        level="medium"
                        label={t('gateway.mediumRisk')}
                        actions={outputRiskActions}
                        field="output_medium_risk_action"
                      />
                      <RiskLevelRow
                        level="low"
                        label={t('gateway.lowRisk')}
                        actions={outputRiskActions}
                        field="output_low_risk_action"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

export default SecurityPolicy
