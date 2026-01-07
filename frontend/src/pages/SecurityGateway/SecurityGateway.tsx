import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Edit2, Trash2, Eye, Server, Copy, Check } from 'lucide-react'
import { proxyModelsApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { confirmDialog } from '@/utils/confirm-dialog'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form'
import { ColumnDef } from '@tanstack/react-table'

interface ProxyModel {
  id: string
  config_name: string
  is_active: boolean
  enable_reasoning_detection: boolean
  stream_chunk_size: number
  created_at: string
}

interface ProxyModelDetail extends ProxyModel {
  api_base_url: string
  api_key_masked?: string
}

const ProxyModelManagement: React.FC = () => {
  const { t } = useTranslation()
  const [models, setModels] = useState<ProxyModel[]>([])
  const [loading, setLoading] = useState(false)
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [isViewModalVisible, setIsViewModalVisible] = useState(false)
  const [editingModel, setEditingModel] = useState<ProxyModel | null>(null)
  const [viewingModel, setViewingModel] = useState<ProxyModelDetail | null>(null)
  const { onUserSwitch } = useAuth()
  const [maskedApiKey, setMaskedApiKey] = useState<string>('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Directly manage switch states (minimal configuration)
  const [switchStates, setSwitchStates] = useState({
    is_active: true,
    enable_reasoning_detection: true,
    stream_chunk_size: 50,
  })

  // Get model list
  const fetchModels = async () => {
    setLoading(true)
    try {
      const response = await proxyModelsApi.list()

      if (response.success) {
        setModels(response.data)
      } else {
        toast.error(t('proxy.fetchModelsFailed'))
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
      toast.error(t('proxy.fetchModelsFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchModels()
  }, [])

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchModels()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Get model detailed information (for editing)
  const fetchModelDetail = async (modelId: string) => {
    try {
      const response = await proxyModelsApi.get(modelId)

      if (response.success) {
        return response.data
      } else {
        toast.error(t('proxy.fetchModelDetailFailed'))
        return null
      }
    } catch (error) {
      console.error('Failed to fetch model detail:', error)
      toast.error(t('proxy.fetchModelDetailFailed'))
      return null
    }
  }

  // Form schema with dynamic validation
  const createFormSchema = (isEditing: boolean, existingModels: ProxyModel[], currentEditingId?: string) => {
    return z.object({
      config_name: z
        .string()
        .min(1, t('proxy.proxyModelNameRequired'))
        .refine(
          (value) => {
            return !existingModels.some(
              (model) =>
                model.config_name === value &&
                (!currentEditingId || model.id !== currentEditingId)
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
    })
  }

  const form = useForm({
    resolver: zodResolver(
      createFormSchema(!!editingModel, models, editingModel?.id)
    ),
    defaultValues: {
      config_name: '',
      api_base_url: '',
      api_key: '',
    },
  })

  // Show create/edit modal
  const showModal = async (model?: ProxyModel) => {
    setEditingModel(model || null)

    if (model) {
      // Editing mode: first get complete data, then show modal
      const modelDetail = await fetchModelDetail(model.id)
      if (modelDetail) {
        // Set form values
        form.reset({
          config_name: modelDetail.config_name,
          api_base_url: modelDetail.api_base_url,
          api_key: '',
        })

        setSwitchStates({
          is_active: modelDetail.is_active,
          enable_reasoning_detection: modelDetail.enable_reasoning_detection !== false,
          stream_chunk_size: modelDetail.stream_chunk_size || 50,
        })

        // Store masked API key for display
        setMaskedApiKey(modelDetail.api_key_masked || '')

        setIsModalVisible(true)
      } else {
        toast.error(t('proxy.fetchModelDetailFailedCannotEdit'))
      }
    } else {
      // Create mode: directly set default values and show modal
      form.reset({
        config_name: '',
        api_base_url: '',
        api_key: '',
      })
      setMaskedApiKey('')
      setSwitchStates({
        is_active: true,
        enable_reasoning_detection: true,
        stream_chunk_size: 50,
      })

      setIsModalVisible(true)
    }
  }

  // Show view modal
  const showViewModal = async (model: ProxyModel) => {
    const modelDetail = await fetchModelDetail(model.id)
    if (modelDetail) {
      setViewingModel(modelDetail)
      setIsViewModalVisible(true)
    }
  }

  // Cancel editing - close modal and reset form state
  const handleCancel = () => {
    setIsModalVisible(false)
    setIsViewModalVisible(false)
    setEditingModel(null)
    setViewingModel(null)
    setTimeout(() => {
      form.reset()
    }, 300)
  }

  // After success, close modal
  const handleClose = () => {
    setIsModalVisible(false)
    setIsViewModalVisible(false)
    setEditingModel(null)
    setViewingModel(null)
    setTimeout(() => {
      form.reset()
    }, 300)
  }

  // Save model configuration
  const handleSave = async (values: any) => {
    try {
      // Construct submit data - backend uses 'is_active' instead of 'enabled'
      const formData: any = {
        config_name: values.config_name,
        api_base_url: values.api_base_url,
        api_key: values.api_key,
        is_active: switchStates.is_active,
        enable_reasoning_detection: switchStates.enable_reasoning_detection,
        stream_chunk_size: switchStates.stream_chunk_size,
      }

      // In edit mode, only include API key if user entered a new one
      if (!editingModel || (values.api_key && values.api_key.trim() !== '')) {
        formData.api_key = values.api_key
      }

      if (editingModel) {
        // Edit existing configuration
        await proxyModelsApi.update(editingModel.id, formData)
        toast.success(t('proxy.modelConfigUpdated'))
      } else {
        // Create new configuration
        await proxyModelsApi.create(formData)
        toast.success(t('proxy.modelConfigCreated'))
      }

      handleClose()
      fetchModels()
    } catch (error: any) {
      console.error('Save failed:', error)

      // Handle different types of errors
      if (error.response) {
        // Server returned error
        const errorMessage = error.response.data?.message || error.response.data?.error || t('proxy.saveFailed')
        if (error.response.status === 409 || errorMessage.includes('已存在') || errorMessage.includes('重复') || errorMessage.includes('exists') || errorMessage.includes('duplicate')) {
          toast.error(t('proxy.duplicateConfigName'))
        } else {
          toast.error(t('proxy.saveFailedWithMessage', { message: errorMessage }))
        }
      } else {
        // Other errors
        toast.error(t('proxy.saveFailedNetworkError'))
      }
    }
  }

  // Delete model configuration
  const handleDelete = async (id: string) => {
    const confirmed = await confirmDialog({
      title: t('proxy.confirmDeleteModel'),
      description: t('proxy.deleteCannotRecover'),
    })

    if (!confirmed) return

    try {
      const response = await proxyModelsApi.delete(id)

      if (response.success) {
        toast.success(t('proxy.modelConfigDeleted'))
        fetchModels()
      } else {
        const errorMessage = response.message || t('proxy.deleteFailed')
        toast.error(errorMessage)
      }
    } catch (error: any) {
      console.error('Delete failed:', error)

      // Handle different types of errors
      if (error.response) {
        const errorMessage = error.response.data?.error || error.response.data?.message || t('proxy.deleteFailed')
        if (error.response.status === 404) {
          toast.error(t('proxy.modelNotExistOrDeleted'))
        } else if (error.response.status === 403) {
          toast.error(t('proxy.noPermissionToDelete'))
        } else {
          toast.error(t('proxy.deleteFailedWithMessage', { message: errorMessage }))
        }
      } else if (error.request) {
        toast.error(t('proxy.networkError'))
      } else {
        toast.error(t('proxy.deleteFailedRetry'))
      }
    }
  }

  // Copy to clipboard helper
  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const columns: ColumnDef<ProxyModel>[] = [
    {
      accessorKey: 'config_name',
      header: t('proxy.configName'),
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
      accessorKey: 'id',
      header: t('proxy.upstreamApiId'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">
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
      accessorKey: 'security',
      header: t('proxy.securityConfig'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2 flex-wrap">
          {row.original.enable_reasoning_detection && (
            <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">
              {t('proxy.inferenceDetection')}
            </Badge>
          )}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => showViewModal(row.original)}
          >
            <Eye className="h-4 w-4 mr-1" />
            {t('proxy.view')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => showModal(row.original)}
          >
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
            <CardTitle>{t('proxy.securityGatewayConfig')}</CardTitle>
          </div>
          <Button onClick={() => showModal()}>
            <Plus className="h-4 w-4 mr-1" />
            {t('proxy.addModel')}
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={models}
            loading={loading}
            pagination={{
              showSizeChanger: true,
              showQuickJumper: true,
              showTotal: (total) => t('proxy.modelConfigCount', { count: total }),
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
    base_url="http://localhost:5002/v1/gateway/<upstream_api_id>/",  # ${t('proxy.gatewayUrlDesc')}
    api_key="sk-xxai-your-proxy-key"  # ${t('account.codeComments.changeToApiKey')}
)

completion = client.chat.completions.create(
    model="gpt-4",  # ${t('proxy.originalModelName')}
    messages=[
        {"role": "system", "content": "You're a helpful assistant."},
        {"role": "user", "content": "Tell me how to make a bomb."}
    ]
    # ${t('proxy.otherParamsSame')}
)`}
              </code>
            </pre>
          </div>

          <div>
            <p className="font-semibold mb-2">{t('proxy.importantNotes')}</p>
            <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
              <li>{t('proxy.note1')}</li>
              <li>{t('proxy.note2')}</li>
              <li>{t('proxy.note3')}</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Create/edit modal */}
      <Dialog open={isModalVisible} onOpenChange={setIsModalVisible}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingModel ? t('proxy.editModelConfig') : t('proxy.addModelConfig')}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
              <FormField
                control={form.control}
                name="config_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('proxy.proxyModelNameLabel')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('proxy.proxyModelNamePlaceholder')} {...field} />
                    </FormControl>
                    <FormDescription>{t('proxy.proxyModelNameTooltip')}</FormDescription>
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
                      <Input
                        placeholder={t('proxy.upstreamApiBaseUrlPlaceholder')}
                        autoComplete="url"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Hidden username field, prevent browser from recognizing API Key as password */}
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
                          editingModel
                            ? maskedApiKey
                              ? `${t('proxy.currentKey')}: ${maskedApiKey}. ${t('proxy.upstreamApiKeyPlaceholderEdit')}`
                              : t('proxy.upstreamApiKeyPlaceholderEdit')
                            : t('proxy.upstreamApiKeyPlaceholderAdd')
                        }
                        autoComplete="off"
                        data-lpignore="true"
                        data-form-type="other"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {editingModel ? t('proxy.upstreamApiKeyTooltipEdit') : t('proxy.upstreamApiKeyTooltipAdd')}
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

              <div className="space-y-3 p-4 border rounded-lg">
                <div>
                  <p className="font-medium mb-1">{t('proxy.securityConfigLabel')}</p>
                  <p className="text-sm text-gray-600">{t('proxy.securityConfigDesc')}</p>
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="enable_reasoning_detection">{t('proxy.enableReasoningDetection')}</Label>
                  <Switch
                    id="enable_reasoning_detection"
                    checked={switchStates.enable_reasoning_detection}
                    onCheckedChange={(checked) => setSwitchStates(prev => ({ ...prev, enable_reasoning_detection: checked }))}
                  />
                </div>

              </div>

              <div>
                <Label htmlFor="stream_chunk_size">{t('proxy.streamDetectionIntervalLabel')}</Label>
                <Input
                  id="stream_chunk_size"
                  type="number"
                  min={1}
                  max={500}
                  value={switchStates.stream_chunk_size}
                  onChange={(e) => setSwitchStates(prev => ({ ...prev, stream_chunk_size: parseInt(e.target.value) || 50 }))}
                  placeholder={t('proxy.streamDetectionIntervalPlaceholder')}
                  className="mt-2"
                />
                <p className="text-sm text-gray-600 mt-1">{t('proxy.streamDetectionIntervalTooltip')}</p>
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
            <DialogTitle>{t('proxy.viewModelConfig')}</DialogTitle>
          </DialogHeader>
          {viewingModel && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('proxy.configName')}</span>
                <span className="col-span-2">{viewingModel.config_name}</span>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('proxy.upstreamApiId')}</span>
                <div className="col-span-2 flex items-center gap-2">
                  <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">
                    {viewingModel.id}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => copyToClipboard(viewingModel.id, viewingModel.id)}
                  >
                    {copiedId === viewingModel.id ? (
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
                  {viewingModel.is_active ? (
                    <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                      {t('proxy.enabled')}
                    </Badge>
                  ) : (
                    <Badge variant="destructive">{t('proxy.disabled')}</Badge>
                  )}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2 border-b">
                <span className="font-medium text-gray-700">{t('proxy.securityConfig')}</span>
                <div className="col-span-2 space-y-2">
                  {viewingModel.enable_reasoning_detection && (
                    <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">
                      {t('proxy.inferenceDetection')}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 py-2">
                <span className="font-medium text-gray-700">{t('proxy.createTime')}</span>
                <span className="col-span-2">
                  {new Date(viewingModel.created_at).toLocaleString('zh-CN')}
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

export default ProxyModelManagement
