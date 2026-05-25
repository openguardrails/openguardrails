import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Info, Copy, Check, Key, FileText } from 'lucide-react'
import { gatewayConnectionApi } from '../../services/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'

interface GatewayConnectionData {
  id: string
  gateway_type: string
  is_enabled: boolean
  config: Record<string, any>
  api_key?: string
  created_at: string
  updated_at: string
}

const GatewayConnection: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [connections, setConnections] = useState<GatewayConnectionData[]>([])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    loadConnections()
  }, [])

  const loadConnections = async () => {
    try {
      setLoading(true)
      const data = await gatewayConnectionApi.list()
      setConnections(data)
    } catch (error) {
      console.error('Failed to load gateway connections:', error)
      toast.error(t('gatewayConnection.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const getConnection = (type: string): GatewayConnectionData | undefined => {
    return connections.find(c => c.gateway_type === type)
  }

  const handleToggleEnabled = async (type: string, enabled: boolean) => {
    try {
      setSaving(type)
      const updated = await gatewayConnectionApi.update(type, { is_enabled: enabled })
      setConnections(prev => prev.map(c =>
        c.gateway_type === type ? { ...c, ...updated } : c
      ))
      toast.success(t('gatewayConnection.saveSuccess'))
    } catch (error) {
      console.error('Failed to update gateway connection:', error)
      toast.error(t('gatewayConnection.saveFailed'))
    } finally {
      setSaving(null)
    }
  }

  const handleToggleAutoDiscovery = async (enabled: boolean) => {
    const higress = getConnection('higress')
    if (!higress) return

    try {
      setSaving('higress')
      const newConfig = { ...higress.config, auto_discovery_enabled: enabled }
      const updated = await gatewayConnectionApi.update('higress', { config: newConfig })
      setConnections(prev => prev.map(c =>
        c.gateway_type === 'higress' ? { ...c, ...updated } : c
      ))
      toast.success(t('gatewayConnection.saveSuccess'))
    } catch (error) {
      console.error('Failed to update auto-discovery:', error)
      toast.error(t('gatewayConnection.saveFailed'))
    } finally {
      setSaving(null)
    }
  }

  const handleCopyApiKey = async (apiKey: string) => {
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
      toast.success(t('gatewayConnection.apiKeyCopied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('gatewayConnection.apiKeyCopyFailed'))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-400" />
      </div>
    )
  }

  const higress = getConnection('higress')

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('gatewayConnection.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('gatewayConnection.description')}</p>
        </div>
        <Button variant="outline" onClick={loadConnections} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
        </Button>
      </div>

      {/* Gateway Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Higress Card */}
        <Card className="relative">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-sky-500/15 flex items-center justify-center">
                  <span className="text-sky-400 font-bold text-sm">Hi</span>
                </div>
                <div>
                  <CardTitle className="text-lg">{t('gatewayConnection.higress.name')}</CardTitle>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {higress?.is_enabled ? (
                  <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/20">{t('gatewayConnection.enabled')}</Badge>
                ) : (
                  <Badge variant="secondary">{t('gatewayConnection.disabled')}</Badge>
                )}
                <Switch
                  checked={higress?.is_enabled || false}
                  onCheckedChange={(checked) => handleToggleEnabled('higress', checked)}
                  disabled={saving === 'higress'}
                />
              </div>
            </div>
            <CardDescription className="mt-2">
              {t('gatewayConnection.higress.description')}
            </CardDescription>
          </CardHeader>

          {higress?.is_enabled && (
            <CardContent className="space-y-4">
              <div className="border-t pt-4 space-y-4">
                {/* API Key Display */}
                {higress.api_key && (
                  <div className="p-4 bg-secondary rounded-lg border space-y-2">
                    <div className="flex items-center gap-2">
                      <Key className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.apiKey')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-card border rounded text-sm font-mono text-foreground truncate">
                        {higress.api_key}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCopyApiKey(higress.api_key!)}
                      >
                        {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.apiKeyDesc')}</p>
                  </div>
                )}

                {/* Installation & Configuration Steps */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">{t('gatewayConnection.higress.setupTitle')}</span>
                  </div>

                  {/* Step 1: Add service source */}
                  <div className="p-3 bg-secondary rounded-lg border space-y-1.5">
                    <p className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.step1Title')}</p>
                    <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.step1Desc')}</p>
                    <code className="block px-2 py-1.5 bg-card border rounded text-xs font-mono text-slate-300 whitespace-pre">{`Type: Static Address
Name: openguardrails-local
Address: <og-server-ip>:5001`}</code>
                  </div>

                  {/* Step 2: Add plugin */}
                  <div className="p-3 bg-secondary rounded-lg border space-y-1.5">
                    <p className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.step2Title')}</p>
                    <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.step2Desc')}</p>
                    <code className="block px-2 py-1.5 bg-card border rounded text-xs font-mono text-slate-300 whitespace-pre">{`Plugin Name: og-connector-go
Image: oci://docker.io/openguardrails/og-connector-higress-go:latest
Execution Priority: 50 (before ai-proxy)`}</code>
                  </div>

                  {/* Step 3: Configure plugin */}
                  <div className="p-3 bg-secondary rounded-lg border space-y-1.5">
                    <p className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.step3Title')}</p>
                    <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.step3Desc')}</p>
                    <code className="block px-2 py-1.5 bg-card border rounded text-xs font-mono text-slate-300 whitespace-pre">{`og_cluster: "outbound|80||openguardrails-local.static"
og_base_url: "http://openguardrails-local.static"
og_api_key: "${higress?.api_key || 'sk-xxai-your-api-key'}"
enable_input_detection: true
enable_output_detection: true
timeout_ms: 5000`}</code>
                  </div>

                  {/* Step 4: Enable and bind route */}
                  <div className="p-3 bg-secondary rounded-lg border space-y-1.5">
                    <p className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.step4Title')}</p>
                    <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.step4Desc')}</p>
                  </div>
                </div>

                {/* Auto-Discovery Toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t('gatewayConnection.higress.autoDiscovery')}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('gatewayConnection.higress.autoDiscoveryDesc')}</p>
                  </div>
                  <Switch
                    checked={higress?.config?.auto_discovery_enabled || false}
                    onCheckedChange={(checked) => handleToggleAutoDiscovery(checked)}
                    disabled={saving === 'higress'}
                  />
                </div>

                {/* Header Mapping Info */}
                {higress?.config?.auto_discovery_enabled && (
                  <div className="space-y-3 p-4 bg-secondary rounded-lg border">
                    <div className="flex items-start gap-2">
                      <Info className="h-4 w-4 text-sky-400 mt-0.5 flex-shrink-0" />
                      <div className="space-y-3 flex-1">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.appHeader')}</span>
                            <code className="px-1.5 py-0.5 bg-sky-500/15 text-sky-300 text-xs rounded font-mono">
                              x-mse-consumer
                            </code>
                            <span className="text-slate-500 text-xs">&rarr;</span>
                            <code className="px-1.5 py-0.5 bg-emerald-500/15 text-emerald-300 text-xs rounded font-mono">
                              X-OG-Application-ID
                            </code>
                          </div>
                          <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.appHeaderDesc')}</p>
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-slate-300">{t('gatewayConnection.higress.workspaceHeader')}</span>
                            <code className="px-1.5 py-0.5 bg-purple-500/15 text-purple-300 text-xs rounded font-mono">
                              x-mse-consumer-group
                            </code>
                            <span className="text-slate-500 text-xs">&rarr;</span>
                            <code className="px-1.5 py-0.5 bg-emerald-500/15 text-emerald-300 text-xs rounded font-mono">
                              X-OG-Workspace-ID
                            </code>
                          </div>
                          <p className="text-xs text-muted-foreground">{t('gatewayConnection.higress.workspaceHeaderDesc')}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          )}
        </Card>

        {/* LiteLLM Card */}
        {(() => {
          const litellm = getConnection('litellm')
          return (
            <Card className="relative">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                      <span className="text-emerald-700 font-bold text-sm">Li</span>
                    </div>
                    <div>
                      <CardTitle className="text-lg">{t('gatewayConnection.litellm.name')}</CardTitle>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {litellm?.is_enabled ? (
                      <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/20">{t('gatewayConnection.enabled')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('gatewayConnection.disabled')}</Badge>
                    )}
                    <Switch
                      checked={litellm?.is_enabled || false}
                      onCheckedChange={(checked) => handleToggleEnabled('litellm', checked)}
                      disabled={saving === 'litellm'}
                    />
                  </div>
                </div>
                <CardDescription className="mt-2">
                  {t('gatewayConnection.litellm.description')}
                </CardDescription>
              </CardHeader>

              {litellm?.is_enabled && (
                <CardContent className="space-y-4">
                  <div className="border-t pt-4 space-y-4">
                    {/* API Key Display */}
                    {litellm.api_key && (
                      <div className="p-4 bg-secondary rounded-lg border space-y-2">
                        <div className="flex items-center gap-2">
                          <Key className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium text-slate-300">{t('gatewayConnection.litellm.apiKey')}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 px-3 py-2 bg-card border rounded text-sm font-mono text-foreground truncate">
                            {litellm.api_key}
                          </code>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCopyApiKey(litellm.api_key!)}
                          >
                            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t('gatewayConnection.litellm.apiKeyDesc')}</p>
                      </div>
                    )}

                    {/* Setup Steps */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">{t('gatewayConnection.litellm.setupTitle')}</span>
                      </div>

                      {/* Generic API */}
                      <div className="p-3 bg-secondary rounded-lg border space-y-1.5">
                        <p className="text-sm font-medium text-slate-300">{t('gatewayConnection.litellm.genericApi')}</p>
                        <p className="text-xs text-muted-foreground">{t('gatewayConnection.litellm.genericApiDesc')}</p>
                        <code className="block px-2 py-1.5 bg-card border rounded text-xs font-mono text-slate-300 whitespace-pre">{`# LiteLLM config.yaml
guardrails:
  - guardrail_name: "openguardrails"
    litellm_params:
      guardrail: generic_guardrail_api
      mode: [pre_call, post_call]
      api_base: http://<og-server>:5001
      api_key: "${litellm?.api_key || 'sk-xxai-your-api-key'}"
      unreachable_fallback: fail_open`}</code>
                      </div>

                      {/* Native Integration */}
                      <div className="p-3 bg-secondary rounded-lg border space-y-1.5">
                        <p className="text-sm font-medium text-slate-300">{t('gatewayConnection.litellm.nativeIntegration')}</p>
                        <p className="text-xs text-muted-foreground">{t('gatewayConnection.litellm.nativeIntegrationDesc')}</p>
                        <code className="block px-2 py-1.5 bg-card border rounded text-xs font-mono text-slate-300 whitespace-pre">{`# LiteLLM config.yaml
guardrails:
  - guardrail_name: "openguardrails"
    litellm_params:
      guardrail: openguardrails
      mode: [pre_call, post_call]
      api_base: http://<og-server>:5001
      api_key: "${litellm?.api_key || 'sk-xxai-your-api-key'}"
      default_on: true`}</code>
                      </div>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })()}
      </div>
    </div>
  )
}

export default GatewayConnection
