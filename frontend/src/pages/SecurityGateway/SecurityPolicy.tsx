import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Shield, AlertTriangle, Lock, Save, Upload, Download } from 'lucide-react'
import { useCanEdit } from '../../hooks/useCanEdit'
import api, { gatewayPolicyApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  // General risk policy - Input
  general_input_high_risk_action: string
  general_input_medium_risk_action: string
  general_input_low_risk_action: string
  general_input_high_risk_action_override: string | null
  general_input_medium_risk_action_override: string | null
  general_input_low_risk_action_override: string | null
  // General risk policy - Output
  general_output_high_risk_action: string
  general_output_medium_risk_action: string
  general_output_low_risk_action: string
  general_output_high_risk_action_override: string | null
  general_output_medium_risk_action_override: string | null
  general_output_low_risk_action_override: string | null
  // Data leakage - Input policy
  input_high_risk_action: string
  input_medium_risk_action: string
  input_low_risk_action: string
  input_high_risk_action_override: string | null
  input_medium_risk_action_override: string | null
  input_low_risk_action_override: string | null
  // Data leakage - Output policy
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

interface SecurityPolicyProps {
  workspaceId?: string
}

const SecurityPolicy: React.FC<SecurityPolicyProps> = ({ workspaceId }) => {
  const { t } = useTranslation()
  const canEdit = useCanEdit()
  const { onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()
  const wsPrefix = workspaceId ? `/api/v1/workspaces/${workspaceId}/config` : null
  const [policy, setPolicy] = useState<GatewayPolicy | null>(null)
  const [wsPrivateModels, setWsPrivateModels] = useState<PrivateModel[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Form state
  const [formData, setFormData] = useState({
    // General risk - Input
    general_input_high_risk_action: 'block' as string,
    general_input_medium_risk_action: 'replace' as string,
    general_input_low_risk_action: 'pass' as string,
    // General risk - Output
    general_output_high_risk_action: 'block' as string,
    general_output_medium_risk_action: 'replace' as string,
    general_output_low_risk_action: 'pass' as string,
    // Data leakage - Input
    input_high_risk_action: 'block' as string,
    input_medium_risk_action: 'anonymize' as string,
    input_low_risk_action: 'pass' as string,
    // Data leakage - Output
    output_high_risk_action: 'block' as string,
    output_medium_risk_action: 'anonymize' as string,
    output_low_risk_action: 'pass' as string,
    // Private model
    private_model_id: null as string | null,
  })

  // Fetch policy
  const fetchPolicy = async () => {
    if (!wsPrefix && !currentApplicationId) return

    setLoading(true)
    try {
      if (wsPrefix) {
        // Workspace mode: fetch from workspace endpoints
        const data = await api.get(`${wsPrefix}/data-leakage-policy`).then(res => res.data)
        // Store available private models from workspace response
        setWsPrivateModels(data.available_private_models || [])
        // Workspace endpoint returns flat fields (no _override suffix)
        // In workspace mode, always set a policy object (with defaults if not exists)
        // so the form is always visible and editable
        const defaults = {
          general_input_high_risk_action: 'block',
          general_input_medium_risk_action: 'replace',
          general_input_low_risk_action: 'pass',
          general_output_high_risk_action: 'block',
          general_output_medium_risk_action: 'replace',
          general_output_low_risk_action: 'pass',
          input_high_risk_action: 'block',
          input_medium_risk_action: 'anonymize',
          input_low_risk_action: 'pass',
          output_high_risk_action: 'block',
          output_medium_risk_action: 'anonymize',
          output_low_risk_action: 'pass',
        }
        const vals = data.exists ? {
          general_input_high_risk_action: data.general_input_high_risk_action || defaults.general_input_high_risk_action,
          general_input_medium_risk_action: data.general_input_medium_risk_action || defaults.general_input_medium_risk_action,
          general_input_low_risk_action: data.general_input_low_risk_action || defaults.general_input_low_risk_action,
          general_output_high_risk_action: data.general_output_high_risk_action || defaults.general_output_high_risk_action,
          general_output_medium_risk_action: data.general_output_medium_risk_action || defaults.general_output_medium_risk_action,
          general_output_low_risk_action: data.general_output_low_risk_action || defaults.general_output_low_risk_action,
          input_high_risk_action: data.input_high_risk_action || defaults.input_high_risk_action,
          input_medium_risk_action: data.input_medium_risk_action || defaults.input_medium_risk_action,
          input_low_risk_action: data.input_low_risk_action || defaults.input_low_risk_action,
          output_high_risk_action: data.output_high_risk_action || defaults.output_high_risk_action,
          output_medium_risk_action: data.output_medium_risk_action || defaults.output_medium_risk_action,
          output_low_risk_action: data.output_low_risk_action || defaults.output_low_risk_action,
          private_model_id: data.private_model_id || null,
        } : { ...defaults, private_model_id: null as string | null }

        setPolicy({
          id: workspaceId!,
          application_id: '',
          general_input_high_risk_action: vals.general_input_high_risk_action,
          general_input_medium_risk_action: vals.general_input_medium_risk_action,
          general_input_low_risk_action: vals.general_input_low_risk_action,
          general_input_high_risk_action_override: vals.general_input_high_risk_action,
          general_input_medium_risk_action_override: vals.general_input_medium_risk_action,
          general_input_low_risk_action_override: vals.general_input_low_risk_action,
          general_output_high_risk_action: vals.general_output_high_risk_action,
          general_output_medium_risk_action: vals.general_output_medium_risk_action,
          general_output_low_risk_action: vals.general_output_low_risk_action,
          general_output_high_risk_action_override: vals.general_output_high_risk_action,
          general_output_medium_risk_action_override: vals.general_output_medium_risk_action,
          general_output_low_risk_action_override: vals.general_output_low_risk_action,
          input_high_risk_action: vals.input_high_risk_action,
          input_medium_risk_action: vals.input_medium_risk_action,
          input_low_risk_action: vals.input_low_risk_action,
          input_high_risk_action_override: vals.input_high_risk_action,
          input_medium_risk_action_override: vals.input_medium_risk_action,
          input_low_risk_action_override: vals.input_low_risk_action,
          output_high_risk_action: vals.output_high_risk_action,
          output_medium_risk_action: vals.output_medium_risk_action,
          output_low_risk_action: vals.output_low_risk_action,
          output_high_risk_action_override: vals.output_high_risk_action,
          output_medium_risk_action_override: vals.output_medium_risk_action,
          output_low_risk_action_override: vals.output_low_risk_action,
          private_model: null,
          private_model_override: vals.private_model_id,
          available_private_models: data.available_private_models || [],
        })
        setFormData(vals)
      } else {
        // Application mode: use existing gateway policy API
        const data = await gatewayPolicyApi.getPolicy(currentApplicationId!)
        setPolicy(data)
        setFormData({
          // General risk - Input
          general_input_high_risk_action: data.general_input_high_risk_action_override || data.general_input_high_risk_action || 'block',
          general_input_medium_risk_action: data.general_input_medium_risk_action_override || data.general_input_medium_risk_action || 'replace',
          general_input_low_risk_action: data.general_input_low_risk_action_override || data.general_input_low_risk_action || 'pass',
          // General risk - Output
          general_output_high_risk_action: data.general_output_high_risk_action_override || data.general_output_high_risk_action || 'block',
          general_output_medium_risk_action: data.general_output_medium_risk_action_override || data.general_output_medium_risk_action || 'replace',
          general_output_low_risk_action: data.general_output_low_risk_action_override || data.general_output_low_risk_action || 'pass',
          // Data leakage - Input
          input_high_risk_action: data.input_high_risk_action_override || data.input_high_risk_action || 'block',
          input_medium_risk_action: data.input_medium_risk_action_override || data.input_medium_risk_action || 'anonymize',
          input_low_risk_action: data.input_low_risk_action_override || data.input_low_risk_action || 'pass',
          // Data leakage - Output
          output_high_risk_action: data.output_high_risk_action_override || data.output_high_risk_action || 'block',
          output_medium_risk_action: data.output_medium_risk_action_override || data.output_medium_risk_action || 'anonymize',
          output_low_risk_action: data.output_low_risk_action_override || data.output_low_risk_action || 'pass',
          private_model_id: data.private_model_override,
        })
      }
    } catch (error) {
      console.error('Failed to fetch policy:', error)
      toast.error(t('gateway.fetchPolicyFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPolicy()
  }, [currentApplicationId, workspaceId])

  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchPolicy()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Save policy
  const handleSave = async () => {
    if (!wsPrefix && !currentApplicationId) return

    setSaving(true)
    try {
      if (wsPrefix) {
        // Workspace mode: save to workspace endpoint
        await api.put(`${wsPrefix}/data-leakage-policy`, formData).then(res => res.data)
      } else {
        // Application mode: use existing gateway policy API
        await gatewayPolicyApi.updatePolicy(currentApplicationId!, formData)
      }
      toast.success(t('gateway.policySaved'))
      fetchPolicy()
    } catch (error) {
      console.error('Failed to save policy:', error)
      toast.error(t('gateway.savePolicyFailed'))
    } finally {
      setSaving(false)
    }
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
    { value: 'anonymize_restore', label: t('gateway.actionAnonymizeRestore'), description: t('gateway.actionAnonymizeRestoreDesc') },
    { value: 'pass', label: t('gateway.actionPass'), description: t('gateway.actionPassDesc') },
  ]

  const outputRiskActions = [
    { value: 'block', label: t('gateway.actionBlock'), description: t('gateway.actionBlockDesc') },
    { value: 'anonymize', label: t('gateway.actionAnonymize'), description: t('gateway.actionAnonymizeDesc') },
    { value: 'pass', label: t('gateway.actionPass'), description: t('gateway.actionPassDesc') },
  ]

  const availablePrivateModels = wsPrefix ? wsPrivateModels : (policy?.available_private_models || [])
  const hasPrivateModels = availablePrivateModels.length > 0

  // Compact risk level badge
  const RiskBadge = ({ level }: { level: 'high' | 'medium' | 'low' }) => {
    const levelColors = {
      high: 'bg-red-500/15 text-red-300 border-red-500/20',
      medium: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/20',
      low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
    }
    const labels = {
      high: t('gateway.highRisk'),
      medium: t('gateway.mediumRisk'),
      low: t('gateway.lowRisk'),
    }
    return (
      <Badge variant="outline" className={`${levelColors[level]} text-xs px-2 py-0.5`}>
        {labels[level]}
      </Badge>
    )
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (!workspaceId && !currentApplicationId) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground border rounded-lg">
        {t('gateway.selectApplicationFirst')}
      </div>
    )
  }

  // Section component for Input/Output
  const PolicySection = ({
    title,
    icon: Icon,
    generalActions,
    generalFields,
    dataActions,
    dataFields,
    showPrivateModel = false,
  }: {
    title: string
    icon: React.ElementType
    generalActions: { value: string; label: string }[]
    generalFields: { level: 'high' | 'medium' | 'low'; field: keyof typeof formData }[]
    dataActions: { value: string; label: string }[]
    dataFields: { level: 'high' | 'medium' | 'low'; field: keyof typeof formData }[]
    showPrivateModel?: boolean
  }) => (
    <div className="border rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b">
        <Icon className="h-4 w-4" />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="grid grid-cols-2 divide-x">
        {/* General Risk */}
        <div>
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {t('gateway.generalRiskPolicy')}
          </div>
          <div className="divide-y">
            {generalFields.map(({ level, field }) => (
              <div key={field} className="flex items-center justify-between px-3 py-1.5">
                <RiskBadge level={level} />
                <Select
                  value={formData[field] as string}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, [field]: value }))}
                >
                  <SelectTrigger className="w-[120px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {generalActions.map((action) => (
                      <SelectItem key={action.value} value={action.value}>
                        {action.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
        {/* Data Leakage */}
        <div>
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/20 flex items-center gap-1">
            <Lock className="h-3 w-3" />
            {t('gateway.dataLeakagePolicy')}
          </div>
          <div className="divide-y">
            {dataFields.map(({ level, field }) => (
              <div key={field} className="flex items-center justify-between px-3 py-1.5">
                <RiskBadge level={level} />
                <Select
                  value={formData[field] as string}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, [field]: value }))}
                >
                  <SelectTrigger className="w-[120px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dataActions.map((action) => (
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
            ))}
            {/* Private model selector in input section */}
            {showPrivateModel && (
              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/10">
                <span className="text-xs text-muted-foreground">{t('gateway.privateModel')}</span>
                <Select
                  value={formData.private_model_id || 'default'}
                  onValueChange={(value) => setFormData(prev => ({
                    ...prev,
                    private_model_id: value === 'default' ? null : value
                  }))}
                  disabled={!hasPrivateModels}
                >
                  <SelectTrigger className="w-[120px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('gateway.defaultModel')}</SelectItem>
                    {availablePrivateModels?.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.config_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <>
      {/* Header with save button */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t('gateway.securityPolicyTitle')}</h3>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving || !canEdit}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>

      {/* Private model warning */}
      {!hasPrivateModels && (
        <div className="px-3 py-2 text-xs bg-orange-500/10 border border-orange-500/20 rounded-lg text-orange-300 mb-4">
          {t('gateway.noPrivateModelsWarning')}
        </div>
      )}

      {/* Input Policy Section */}
      <div className="mb-4">
      <PolicySection
        title={t('gateway.inputPolicySection')}
        icon={Upload}
        generalActions={generalRiskActions}
        generalFields={[
          { level: 'high', field: 'general_input_high_risk_action' },
          { level: 'medium', field: 'general_input_medium_risk_action' },
          { level: 'low', field: 'general_input_low_risk_action' },
        ]}
        dataActions={inputRiskActions}
        dataFields={[
          { level: 'high', field: 'input_high_risk_action' },
          { level: 'medium', field: 'input_medium_risk_action' },
          { level: 'low', field: 'input_low_risk_action' },
        ]}
        showPrivateModel
      />
      </div>

      {/* Output Policy Section */}
      <PolicySection
        title={t('gateway.outputPolicySection')}
        icon={Download}
        generalActions={generalRiskActions}
        generalFields={[
          { level: 'high', field: 'general_output_high_risk_action' },
          { level: 'medium', field: 'general_output_medium_risk_action' },
          { level: 'low', field: 'general_output_low_risk_action' },
        ]}
        dataActions={outputRiskActions}
        dataFields={[
          { level: 'high', field: 'output_high_risk_action' },
          { level: 'medium', field: 'output_medium_risk_action' },
          { level: 'low', field: 'output_low_risk_action' },
        ]}
      />
    </>
  )
}

export default SecurityPolicy
