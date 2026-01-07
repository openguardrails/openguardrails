import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Edit2, Trash2, Eye, Server, Copy, Check, X, Shield } from 'lucide-react'
import { proxyModelsApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { confirmDialog } from '@/utils/confirm-dialog'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form'
import { ColumnDef } from '@tanstack/react-table'

interface LLMProvider {
  id: string
  config_name: string
  provider?: string
  is_active: boolean
  is_private_model: boolean
  is_default_private_model: boolean
  private_model_names: string[]
  default_private_model_name?: string
  created_at: string
}

interface LLMProviderDetail extends LLMProvider {
  api_base_url: string
  api_key_masked?: string
}

const LLMProviders: React.FC = () => {
  const { t } = useTranslation()
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [isViewModalVisible, setIsViewModalVisible] = useState(false)
  const [editingProvider, setEditingProvider] = useState<LLMProvider | null>(null)
  const [viewingProvider, setViewingProvider] = useState<LLMProviderDetail | null>(null)
  const { onUserSwitch } = useAuth()
  const [maskedApiKey, setMaskedApiKey] = useState<string>('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // State for switches and private model config
  const [switchStates, setSwitchStates] = useState({
    is_active: true,
    is_private_model: false,
    is_default_private_model: false,
  })

  // State for model names tags
  const [modelNames, setModelNames] = useState<string[]>([])
  const [newModelName, setNewModelName] = useState('')
  const [defaultPrivateModelName, setDefaultPrivateModelName] = useState<string>('')

  // Fetch providers list
  const fetchProviders = async () => {
    setLoading(true)
    try {
      const response = await proxyModelsApi.list()
      if (response.success) {
        setProviders(response.data)
      } else {
        toast.error(t('gateway.fetchProvidersFailed'))
      }
    } catch (error) {
      console.error('Failed to fetch providers:', error)
      toast.error(t('gateway.fetchProvidersFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchProviders()
  }, [])

  // Listen to user switch event
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchProviders()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Fetch provider detail
  const fetchProviderDetail = async (providerId: string) => {
    try {
      const response = await proxyModelsApi.get(providerId)
      if (response.success) {
        return response.data
      } else {
        toast.error(t('gateway.fetchProviderDetailFailed'))
        return null
      }
    } catch (error) {
      console.error('Failed to fetch provider detail:', error)
      toast.error(t('gateway.fetchProviderDetailFailed'))
      return null
    }
  }

  // Provider type options
  const providerTypeOptions = [
    { value: 'OpenAI/OpenAI Compatible', label: 'OpenAI/OpenAI Compatible' },
    { value: 'Azure OpenAI', label: 'Azure OpenAI' },
    { value: 'Anthropic Claude', label: 'Anthropic Claude' },
  ]

  // Form schema
  const createFormSchema = (isEditing: boolean, existingProviders: LLMProvider[], currentEditingId?: string) => {
    return z.object({
      config_name: z
        .string()
        .min(1, t('proxy.proxyModelNameRequired'))
        .refine(
          (value) => {
            return !existingProviders.some(
              (provider) =>
                provider.config_name === value &&
                (!currentEditingId || provider.id !== currentEditingId)
            )
          },
          { message: t('proxy.duplicateConfigName') }
        ),
      api_base_url: z
        .string()
        .min(1, t('proxy.upstreamApiBaseUrlRequired'))
        .regex(/^https?:\/\/.+/, t('proxy.invalidApiBaseUrl')),
      api_key: isEditing
        ? z.string().optional()
        : z.string().min(1, t('proxy.upstreamApiKeyRequired')),
      provider: z.string().min(1, t('gateway.providerTypeRequired')),
    })
  }

  const form = useForm({
    resolver: zodResolver(
      createFormSchema(!!editingProvider, providers, editingProvider?.id)
    ),
    defaultValues: {
      config_name: '',
      api_base_url: '',
      api_key: '',
      provider: 'OpenAI/OpenAI Compatible',
    },
  })

  // Show create/edit modal
  const showModal = async (provider?: LLMProvider) => {
    setEditingProvider(provider || null)

    if (provider) {
      const providerDetail = await fetchProviderDetail(provider.id)
      if (providerDetail) {
        form.reset({
          config_name: providerDetail.config_name,
          api_base_url: providerDetail.api_base_url,
          api_key: '',
          provider: providerDetail.provider || '',
        })

        setSwitchStates({
          is_active: providerDetail.is_active,
          is_private_model: providerDetail.is_private_model || false,
          is_default_private_model: providerDetail.is_default_private_model || false,
        })

        setModelNames(providerDetail.private_model_names || [])
        setDefaultPrivateModelName(providerDetail.default_private_model_name || '')
        setMaskedApiKey(providerDetail.api_key_masked || '')
        setIsModalVisible(true)
      } else {
        toast.error(t('proxy.fetchModelDetailFailedCannotEdit'))
      }
    } else {
      form.reset({
        config_name: '',
        api_base_url: '',
        api_key: '',
        provider: 'OpenAI/OpenAI Compatible',
      })
      setMaskedApiKey('')
      setSwitchStates({
        is_active: true,
        is_private_model: false,
        is_default_private_model: false,
      })
      setModelNames([])
      setDefaultPrivateModelName('')
      setIsModalVisible(true)
    }
  }

  // Show view modal
  const showViewModal = async (provider: LLMProvider) => {
    const providerDetail = await fetchProviderDetail(provider.id)
    if (providerDetail) {
      setViewingProvider(providerDetail)
      setIsViewModalVisible(true)
    }
  }

  // Cancel editing
  const handleCancel = () => {
    setIsModalVisible(false)
    setIsViewModalVisible(false)
    setEditingProvider(null)
    setViewingProvider(null)
    setNewModelName('')
    setDefaultPrivateModelName('')
    setTimeout(() => {
      form.reset()
    }, 300)
  }

  // Add model name tag
  const addModelName = () => {
    const trimmed = newModelName.trim()
    if (trimmed && !modelNames.includes(trimmed)) {
      setModelNames([...modelNames, trimmed])
      setNewModelName('')
    }
  }

  // Remove model name tag
  const removeModelName = (name: string) => {
    setModelNames(modelNames.filter(n => n !== name))
    // If the removed name was the default, clear the default
    if (defaultPrivateModelName === name) {
      setDefaultPrivateModelName('')
    }
  }

  // Handle Enter key for adding model name
  const handleModelNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addModelName()
    }
  }

  // Save provider configuration
  const handleSave = async (values: any) => {
    try {
      const formData: any = {
        config_name: values.config_name,
        api_base_url: values.api_base_url,
        provider: values.provider || undefined,
        is_active: switchStates.is_active,
        is_private_model: switchStates.is_private_model,
        is_default_private_model: switchStates.is_private_model ? switchStates.is_default_private_model : false,
        private_model_names: switchStates.is_private_model ? modelNames : [],
        default_private_model_name: (switchStates.is_private_model && switchStates.is_default_private_model) ? defaultPrivateModelName : null,
      }

      // Only include API key if provided
      if (!editingProvider || (values.api_key && values.api_key.trim() !== '')) {
        formData.api_key = values.api_key
      }

      if (editingProvider) {
        await proxyModelsApi.update(editingProvider.id, formData)
        toast.success(t('gateway.providerUpdated'))
      } else {
        await proxyModelsApi.create(formData)
        toast.success(t('gateway.providerCreated'))
      }

      handleCancel()
      fetchProviders()
    } catch (error: any) {
      console.error('Save failed:', error)
      if (error.response) {
        const errorMessage = error.response.data?.message || error.response.data?.error || t('proxy.saveFailed')
        if (error.response.status === 409 || errorMessage.includes('exists') || errorMessage.includes('duplicate')) {
          toast.error(t('proxy.duplicateConfigName'))
        } else {
          toast.error(t('proxy.saveFailedWithMessage', { message: errorMessage }))
        }
      } else {
        toast.error(t('proxy.saveFailedNetworkError'))
      }
    }
  }

  // Delete provider
  const handleDelete = async (id: string) => {
    const confirmed = await confirmDialog({
      title: t('gateway.confirmDeleteProvider'),
      description: t('proxy.deleteCannotRecover'),
    })

    if (!confirmed) return

    try {
      const response = await proxyModelsApi.delete(id)
      if (response.success) {
        toast.success(t('gateway.providerDeleted'))
        fetchProviders()
      } else {
        toast.error(response.message || t('proxy.deleteFailed'))
      }
    } catch (error: any) {
      console.error('Delete failed:', error)
      toast.error(t('proxy.deleteFailed'))
    }
  }

  // Copy to clipboard
  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const columns: ColumnDef<LLMProvider>[] = [
    {
      accessorKey: 'config_name',
      header: t('gateway.providerName'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="font-semibold">{row.original.config_name}</span>
          {!row.original.is_active && (
            <Badge variant="destructive">{t('proxy.disabled')}</Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'provider',
      header: t('gateway.providerType'),
      cell: ({ row }) => (
        <span className="text-gray-600">{row.original.provider || '-'}</span>
      ),
    },
    {
      accessorKey: 'is_private_model',
      header: t('gateway.privateModel'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          {row.original.is_private_model ? (
            <>
              <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                <Shield className="h-3 w-3 mr-1" />
                {t('gateway.privateModelBadge')}
              </Badge>
              {row.original.is_default_private_model && (
                <Badge variant="outline" className="text-blue-600 border-blue-300">
                  {t('gateway.defaultBadge')}
                </Badge>
              )}
            </>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'id',
      header: t('proxy.upstreamApiId'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono truncate max-w-[120px]">
            {row.original.id}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => copyToClipboard(row.original.id, row.original.id)}
          >
            {copiedId === row.original.id ? (
              <Check className="h-3 w-3 text-green-600" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
        </div>
      ),
    },
    {
      accessorKey: 'created_at',
      header: t('proxy.createTime'),
      cell: ({ row }) => new Date(row.original.created_at).toLocaleString('zh-CN'),
    },
    {
      id: 'actions',
      header: t('proxy.operation'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => showViewModal(row.original)}>
            <Eye className="h-4 w-4 mr-1" />
            {t('proxy.view')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => showModal(row.original)}>
            <Edit2 className="h-4 w-4 mr-1" />
            {t('proxy.edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => handleDelete(row.original.id)}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {t('proxy.delete')}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            <div>
              <CardTitle>{t('gateway.llmProvidersTitle')}</CardTitle>
              <CardDescription>{t('gateway.llmProvidersDescription')}</CardDescription>
            </div>
          </div>
          <Button onClick={() => showModal()}>
            <Plus className="h-4 w-4 mr-1" />
            {t('gateway.addProvider')}
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={providers}
            loading={loading}
            pagination={{
              showSizeChanger: true,
              showQuickJumper: true,
              showTotal: (total) => t('gateway.providerCount', { count: total }),
            }}
          />
        </CardContent>
      </Card>

      {/* Usage instructions */}
      <Card>
        <CardHeader>
          <CardTitle>{t('proxy.accessOpenGuardrailsGateway')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-900">{t('proxy.gatewayIntegrationDesc')}</p>
          </div>

          <div>
            <p className="font-semibold mb-2">{t('proxy.pythonOpenaiExample')}</p>
            <pre className="bg-gray-50 p-4 rounded-lg overflow-auto text-sm border border-gray-200">
              <code>
{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:5002/v1/gateway/<upstream_api_id>/",
    api_key="sk-xxai-your-proxy-key"
)

completion = client.chat.completions.create(
    model="gpt-4",
    messages=[
        {"role": "system", "content": "You're a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ]
)`}
              </code>
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Create/edit modal */}
      <Dialog open={isModalVisible} onOpenChange={setIsModalVisible}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingProvider ? t('gateway.editProvider') : t('gateway.addProvider')}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
              <FormField
                control={form.control}
                name="config_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway.providerName')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('gateway.providerNamePlaceholder')} {...field} />
                    </FormControl>
                    <FormDescription>{t('gateway.providerNameDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway.providerType')} </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('gateway.providerTypePlaceholder')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {providerTypeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>{t('gateway.providerTypeDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="api_base_url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('proxy.upstreamApiBaseUrlLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('proxy.upstreamApiBaseUrlPlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <input
                type="text"
                name="username"
                autoComplete="username"
                style={{ position: 'absolute', left: '-9999px', opacity: 0 }}
                tabIndex={-1}
                readOnly
              />

              <FormField
                control={form.control}
                name="api_key"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('proxy.upstreamApiKeyLabel')}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={
                          editingProvider
                            ? maskedApiKey
                              ? `${t('proxy.currentKey')}: ${maskedApiKey}. ${t('proxy.upstreamApiKeyPlaceholderEdit')}`
                              : t('proxy.upstreamApiKeyPlaceholderEdit')
                            : t('proxy.upstreamApiKeyPlaceholderAdd')
                        }
                        autoComplete="off"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {editingProvider ? t('proxy.upstreamApiKeyTooltipEdit') : t('proxy.upstreamApiKeyTooltipAdd')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex items-center justify-between p-4 border rounded-lg">
                <Label htmlFor="is_active">{t('proxy.enableConfigLabel')}</Label>
                <Switch
                  id="is_active"
                  checked={switchStates.is_active}
                  onCheckedChange={(checked) => setSwitchStates(prev => ({ ...prev, is_active: checked }))}
                />
              </div>

              {/* Private Model Configuration */}
              <div className="space-y-3 p-4 border rounded-lg bg-green-50">
                <div>
                  <p className="font-medium mb-1">{t('gateway.privateModelConfig')}</p>
                  <p className="text-sm text-gray-600">{t('gateway.privateModelConfigDesc')}</p>
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="is_private_model">{t('gateway.isPrivateModel')}</Label>
                  <Switch
                    id="is_private_model"
                    checked={switchStates.is_private_model}
                    onCheckedChange={(checked) => setSwitchStates(prev => ({
                      ...prev,
                      is_private_model: checked,
                      is_default_private_model: checked ? prev.is_default_private_model : false
                    }))}
                  />
                </div>

                {switchStates.is_private_model && (
                  <>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="is_default_private_model">{t('gateway.isDefaultPrivateModel')}</Label>
                      <Switch
                        id="is_default_private_model"
                        checked={switchStates.is_default_private_model}
                        onCheckedChange={(checked) => setSwitchStates(prev => ({ ...prev, is_default_private_model: checked }))}
                      />
                    </div>

                    {switchStates.is_default_private_model && modelNames.length > 0 && (
                      <div className="space-y-2">
                        <Label>{t('gateway.defaultPrivateModelName')}</Label>
                        <p className="text-sm text-gray-600">{t('gateway.defaultPrivateModelNameDesc')}</p>
                        <Select
                          value={defaultPrivateModelName}
                          onValueChange={setDefaultPrivateModelName}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('gateway.selectDefaultModelName')} />
                          </SelectTrigger>
                          <SelectContent>
                            {modelNames.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label>{t('gateway.privateModelNames')}</Label>
                      <p className="text-sm text-gray-600">{t('gateway.privateModelNamesDesc')}</p>

                      <div className="flex gap-2">
                        <Input
                          placeholder={t('gateway.addModelNamePlaceholder')}
                          value={newModelName}
                          onChange={(e) => setNewModelName(e.target.value)}
                          onKeyDown={handleModelNameKeyDown}
                        />
                        <Button type="button" variant="outline" onClick={addModelName}>
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>

                      {modelNames.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {modelNames.map((name) => (
                            <Badge key={name} variant="secondary" className="flex items-center gap-1">
                              {name}
                              <button
                                type="button"
                                onClick={() => removeModelName(name)}
                                className="hover:text-red-600"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCancel}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">{t('common.save')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* View modal */}
      <Dialog open={isViewModalVisible} onOpenChange={setIsViewModalVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('gateway.viewProvider')}</DialogTitle>
          </DialogHeader>
          {viewingProvider && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('gateway.providerName')}</span>
                <span className="col-span-2">{viewingProvider.config_name}</span>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('gateway.providerType')}</span>
                <span className="col-span-2">{viewingProvider.provider || '-'}</span>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('proxy.upstreamApiId')}</span>
                <div className="col-span-2 flex items-center gap-2">
                  <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">
                    {viewingProvider.id}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => copyToClipboard(viewingProvider.id, viewingProvider.id)}
                  >
                    {copiedId === viewingProvider.id ? (
                      <Check className="h-3 w-3 text-green-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('proxy.status')}</span>
                <span className="col-span-2">
                  {viewingProvider.is_active ? (
                    <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                      {t('proxy.enabled')}
                    </Badge>
                  ) : (
                    <Badge variant="destructive">{t('proxy.disabled')}</Badge>
                  )}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('gateway.privateModel')}</span>
                <div className="col-span-2">
                  {viewingProvider.is_private_model ? (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                          <Shield className="h-3 w-3 mr-1" />
                          {t('gateway.privateModelBadge')}
                        </Badge>
                        {viewingProvider.is_default_private_model && (
                          <Badge variant="outline" className="text-blue-600 border-blue-300">
                            {t('gateway.defaultBadge')}
                          </Badge>
                        )}
                      </div>
                      {viewingProvider.is_default_private_model && viewingProvider.default_private_model_name && (
                        <div className="text-sm text-gray-600">
                          {t('gateway.defaultModelNameLabel')}: <span className="font-medium">{viewingProvider.default_private_model_name}</span>
                        </div>
                      )}
                      {viewingProvider.private_model_names && viewingProvider.private_model_names.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {viewingProvider.private_model_names.map((name) => (
                            <Badge
                              key={name}
                              variant="outline"
                              className={`text-xs ${name === viewingProvider.default_private_model_name ? 'bg-blue-50 border-blue-300 text-blue-700' : ''}`}
                            >
                              {name}
                              {name === viewingProvider.default_private_model_name && (
                                <span className="ml-1 text-[10px]">({t('gateway.defaultBadge')})</span>
                              )}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2">
                <span className="font-medium text-gray-700">{t('proxy.createTime')}</span>
                <span className="col-span-2">
                  {new Date(viewingProvider.created_at).toLocaleString('zh-CN')}
                </span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={handleCancel}>{t('proxy.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default LLMProviders
