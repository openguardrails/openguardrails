import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@/utils/clipboard'
import { useNavigate } from 'react-router-dom'
import {
  Settings,
  ArrowRight,
  Copy,
  Info,
  ExternalLink,
  RefreshCw,
  RefreshCw as RotateCcw,
  Eye,
  EyeOff,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import api from '../../services/api'
import { authService } from '../../services/auth'

interface Application {
  id: string
  name: string
  source?: string
  external_id?: string
  created_at: string
}

const ApplicationDiscovery: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [tenantApiKey, setTenantApiKey] = useState<string>('')
  const [recentDiscoveredApps, setRecentDiscoveredApps] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [showFullKey, setShowFullKey] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      // Fetch tenant API key using auth service
      const userInfo = await authService.getCurrentUser()
      if (userInfo?.api_key) {
        setTenantApiKey(userInfo.api_key)
      }

      // Fetch recent auto-discovered applications
      const appsResponse = await api.get('/api/v1/applications')
      if (Array.isArray(appsResponse.data)) {
        const discovered = appsResponse.data
          .filter((app: Application) => app.source === 'auto_discovery')
          .sort(
            (a: Application, b: Application) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          )
          .slice(0, 5)
        setRecentDiscoveredApps(discovered)
      }
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleCopyToClipboard = async (text: string) => {
    try {
      await copyToClipboard(text)
      toast.success(t('common.copied'))
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
      toast.error(t('common.copyFailed'))
    }
  }

  const handleRegenerateApiKey = async () => {
    setRegenerating(true)
    try {
      const response = await authService.regenerateApiKey()
      const newKey = response.api_key
      setTenantApiKey(newKey)
      setNewApiKey(newKey)
      toast.success(t('common.apiKeyRegenerated'))
    } catch (error) {
      console.error('Failed to regenerate API key:', error)
      toast.error(t('common.apiKeyRegenerateFailed'))
    } finally {
      setRegenerating(false)
    }
  }

  const displayedApiKey = newApiKey || tenantApiKey

  const maskedApiKey = displayedApiKey
    ? `${displayedApiKey.substring(0, 12)}${'*'.repeat(20)}${displayedApiKey.substring(displayedApiKey.length - 8)}`
    : ''

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('applicationManagement.discovery.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('applicationManagement.discovery.description')}</p>
      </div>

      {/* Overview Alert */}
      <Alert className="bg-sky-500/10 border-sky-500/20">
        <Info className="h-5 w-5 text-sky-400" />
        <AlertDescription className="text-sky-300">
          {t('applicationManagement.discovery.overview')}
        </AlertDescription>
      </Alert>

      {/* Tenant API Key Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              {t('applicationManagement.discovery.tenantApiKey')}
            </CardTitle>
            <CardDescription>{t('applicationManagement.discovery.tenantApiKeyDesc')}</CardDescription>
          </div>
          {displayedApiKey && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerateApiKey}
              disabled={regenerating}
              className="text-red-400 hover:text-red-300 border-red-500/20 hover:bg-red-500/10"
            >
              <RotateCcw className={`h-4 w-4 mr-2 ${regenerating ? 'animate-spin' : ''}`} />
              {t('applicationManagement.discovery.regenerateApiKey')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {newApiKey && (
            <Alert className="mb-4 bg-emerald-500/10 border-emerald-500/20">
              <AlertDescription className="text-emerald-300">
                {t('applicationManagement.discovery.newApiKeyWarning')}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-2 bg-muted rounded-md p-3 font-mono text-sm">
            <code className="flex-1 break-all">{showFullKey ? displayedApiKey : maskedApiKey || t('common.loading')}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFullKey(!showFullKey)}
              disabled={!displayedApiKey}
              title={showFullKey ? t('common.hide') : t('common.show')}
            >
              {showFullKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCopyToClipboard(displayedApiKey)}
              disabled={!displayedApiKey}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recent Auto-Discovered Apps */}
      {recentDiscoveredApps.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>{t('applicationManagement.discovery.recentDiscovered')}</CardTitle>
              <CardDescription>{t('applicationManagement.discovery.recentDiscoveredDesc')}</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={fetchData} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recentDiscoveredApps.map((app) => (
                <div
                  key={app.id}
                  className="flex items-center justify-between p-3 bg-secondary rounded-md"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary" className="bg-sky-500/15 text-sky-400">
                      {t('applicationManagement.sourceAutoDiscovery')}
                    </Badge>
                    <span className="font-medium">{app.name}</span>
                    {app.external_id && (
                      <span className="text-xs text-muted-foreground">({app.external_id})</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(app.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex gap-4">
        <Button variant="outline" onClick={() => navigate('/applications/list')}>
          {t('applicationManagement.discovery.viewAllApps')}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
        <Button
          variant="link"
          className="text-sky-400"
          onClick={() =>
            window.open(
              'https://github.com/openguardrails/openguardrails/blob/main/docs/THIRD_PARTY_GATEWAY_INTEGRATION.md',
              '_blank'
            )
          }
        >
          <ExternalLink className="h-4 w-4 mr-2" />
          {t('applicationManagement.discovery.viewDocs')}
        </Button>
      </div>
    </div>
  )
}

export default ApplicationDiscovery
