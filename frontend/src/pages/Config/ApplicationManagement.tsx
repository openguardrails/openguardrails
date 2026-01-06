import React, { useState, useEffect } from 'react'
import { Plus, Edit, Trash2, Key, Copy, Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/utils/confirm-dialog'
import api from '../../services/api'
import { useApplication } from '../../contexts/ApplicationContext'
import type { ColumnDef } from '@tanstack/react-table'
import { format } from 'date-fns'

const applicationSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
})

const apiKeySchema = z.object({
  name: z.string().optional(),
})

type ApplicationFormData = z.infer<typeof applicationSchema>
type ApiKeyFormData = z.infer<typeof apiKeySchema>

interface ProtectionSummary {
  risk_types_enabled: number
  total_risk_types: number
  ban_policy_enabled: boolean
  sensitivity_level: string
  data_security_entities: number
  blacklist_count: number
  whitelist_count: number
  knowledge_base_count: number
}

interface Application {
  id: string
  tenant_id: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  api_keys_count: number
  protection_summary?: ProtectionSummary
}

interface ApiKey {
  id: string
  application_id: string
  key: string
  name: string | null
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

const ApplicationManagement: React.FC = () => {
  const { t } = useTranslation()
  const { refreshApplications } = useApplication()
  const [applications, setApplications] = useState<Application[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [keysModalVisible, setKeysModalVisible] = useState(false)
  const [editingApp, setEditingApp] = useState<Application | null>(null)
  const [currentAppKeys, setCurrentAppKeys] = useState<ApiKey[]>([])
  const [currentAppId, setCurrentAppId] = useState<string>('')
  const [currentAppName, setCurrentAppName] = useState<string>('')
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())

  const form = useForm<ApplicationFormData>({
    resolver: zodResolver(applicationSchema),
    defaultValues: {
      name: '',
      description: '',
      is_active: true,
    },
  })

  const keyForm = useForm<ApiKeyFormData>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: {
      name: '',
    },
  })

  useEffect(() => {
    fetchApplications()
  }, [])

  const fetchApplications = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/v1/applications')
      setApplications(response.data)
    } catch (error) {
      toast.error(t('applicationManagement.fetchError'))
    } finally {
      setLoading(false)
    }
  }

  const fetchApiKeys = async (appId: string) => {
    try {
      const response = await api.get(`/api/v1/applications/${appId}/keys`)
      setCurrentAppKeys(response.data)
    } catch (error) {
      toast.error(t('applicationManagement.fetchKeysError'))
    }
  }

  const handleCreate = () => {
    setEditingApp(null)
    form.reset({
      name: '',
      description: '',
      is_active: true,
    })
    setModalVisible(true)
  }

  const handleEdit = (app: Application) => {
    setEditingApp(app)
    form.reset({
      name: app.name,
      description: app.description || '',
      is_active: app.is_active,
    })
    setModalVisible(true)
  }

  const handleDelete = async (appId: string) => {
    const confirmed = await confirmDialog({
      title: t('applicationManagement.deleteConfirm'),
      confirmText: t('common.yes'),
      cancelText: t('common.no'),
      variant: 'destructive',
    })

    if (confirmed) {
      try {
        await api.delete(`/api/v1/applications/${appId}`)
        toast.success(t('applicationManagement.deleteSuccess'))
        fetchApplications()
        refreshApplications()
      } catch (error: any) {
        if (error.response?.status === 400) {
          toast.error(t('applicationManagement.cannotDeleteLast'))
        } else {
          toast.error(t('applicationManagement.deleteError'))
        }
      }
    }
  }

  const handleSubmit = async (values: ApplicationFormData) => {
    try {
      if (editingApp) {
        await api.put(`/api/v1/applications/${editingApp.id}`, values)
        toast.success(t('applicationManagement.updateSuccess'))
      } else {
        await api.post('/api/v1/applications', values)
        toast.success(t('applicationManagement.createSuccess'))
      }
      setModalVisible(false)
      fetchApplications()
      refreshApplications()
    } catch (error) {
      toast.error(t('applicationManagement.saveError'))
    }
  }

  const handleManageKeys = async (app: Application) => {
    setCurrentAppId(app.id)
    setCurrentAppName(app.name)
    await fetchApiKeys(app.id)
    setKeysModalVisible(true)
  }

  const handleCreateKey = async (values: ApiKeyFormData) => {
    try {
      await api.post(`/api/v1/applications/${currentAppId}/keys`, {
        application_id: currentAppId,
        name: values.name,
      })
      toast.success(t('applicationManagement.keyCreateSuccess'))
      keyForm.reset()
      await fetchApiKeys(currentAppId)
      fetchApplications()
    } catch (error) {
      toast.error(t('applicationManagement.keyCreateError'))
    }
  }

  const handleDeleteKey = (keyId: string) => {
    confirmDialog({
      title: t('applicationManagement.deleteKeyConfirm'),
      confirmText: t('common.yes'),
      cancelText: t('common.no'),
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await api.delete(`/api/v1/applications/${currentAppId}/keys/${keyId}`)
          toast.success(t('applicationManagement.keyDeleteSuccess'))
          await fetchApiKeys(currentAppId)
          fetchApplications()
        } catch (error) {
          toast.error(t('applicationManagement.keyDeleteError'))
        }
      },
    })
  }

  const handleToggleKey = async (keyId: string) => {
    try {
      await api.put(`/api/v1/applications/${currentAppId}/keys/${keyId}/toggle`)
      toast.success(t('applicationManagement.keyToggleSuccess'))
      await fetchApiKeys(currentAppId)
    } catch (error) {
      toast.error(t('applicationManagement.keyToggleError'))
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('applicationManagement.copiedToClipboard'))
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
      toast.error(t('applicationManagement.copyToClipboardFailed'))
    }
  }

  const toggleKeyVisibility = (keyId: string) => {
    setVisibleKeys((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(keyId)) {
        newSet.delete(keyId)
      } else {
        newSet.add(keyId)
      }
      return newSet
    })
  }

  const maskApiKey = (key: string) => {
    if (key.length <= 20) return key
    return key.slice(0, 15) + '...' + key.slice(-4)
  }

  const columns: ColumnDef<Application>[] = [
    {
      accessorKey: 'name',
      header: t('applicationManagement.name'),
    },
    {
      accessorKey: 'description',
      header: t('applicationManagement.description'),
      cell: ({ row }) => {
        const desc = row.getValue('description') as string | null
        return (
          <span className="truncate max-w-[250px] block" title={desc || '-'}>
            {desc || '-'}
          </span>
        )
      },
    },
    {
      id: 'protection_summary',
      header: t('applicationManagement.protectionSummary'),
      cell: ({ row }) => {
        const summary = row.original.protection_summary
        if (!summary) return '-'

        return (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-1" title={t('applicationManagement.riskTypesTooltip')}>
                <span className="text-gray-600">{t('applicationManagement.riskTypes')}:</span>
                <Badge variant="default">
                  {summary.risk_types_enabled}/{summary.total_risk_types}
                </Badge>
              </div>
              <div
                className="flex items-center gap-1"
                title={t('applicationManagement.sensitivityLevelTooltip')}
              >
                <span className="text-gray-600">{t('applicationManagement.sensitivityLevel')}:</span>
                <Badge variant="secondary">{t(`sensitivity.${summary.sensitivity_level}`)}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-1" title={t('applicationManagement.banPolicyTooltip')}>
                <span className="text-gray-600">{t('applicationManagement.banPolicy')}:</span>
                <Badge variant={summary.ban_policy_enabled ? 'outline' : 'secondary'}>
                  {summary.ban_policy_enabled ? t('common.enabled') : t('common.disabled')}
                </Badge>
              </div>
              <div className="flex items-center gap-1" title={t('applicationManagement.dlpEntitiesTooltip')}>
                <span className="text-gray-600">{t('applicationManagement.dlpEntities')}:</span>
                <Badge variant="default">{summary.data_security_entities}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-1" title={t('applicationManagement.blacklistTooltip')}>
                <span className="text-gray-600">{t('applicationManagement.blacklist')}:</span>
                <Badge variant="destructive">{summary.blacklist_count}</Badge>
              </div>
              <div className="flex items-center gap-1" title={t('applicationManagement.whitelistTooltip')}>
                <span className="text-gray-600">{t('applicationManagement.whitelist')}:</span>
                <Badge variant="outline">{summary.whitelist_count}</Badge>
              </div>
              <div className="flex items-center gap-1" title={t('applicationManagement.knowledgeBaseTooltip')}>
                <span className="text-gray-600">{t('applicationManagement.knowledgeBase')}:</span>
                <Badge variant="secondary">{summary.knowledge_base_count}</Badge>
              </div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'is_active',
      header: t('applicationManagement.status'),
      cell: ({ row }) => {
        const isActive = row.getValue('is_active') as boolean
        return (
          <Badge variant={isActive ? 'outline' : 'destructive'}>
            {isActive ? t('applicationManagement.active') : t('applicationManagement.inactive')}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'api_keys_count',
      header: t('applicationManagement.apiKeysCount'),
      cell: ({ row }) => {
        const count = row.getValue('api_keys_count') as number
        return <Badge variant="default">{count}</Badge>
      },
    },
    {
      accessorKey: 'created_at',
      header: t('applicationManagement.createdAt'),
      cell: ({ row }) => {
        const time = row.getValue('created_at') as string
        return format(new Date(time), 'yyyy-MM-dd HH:mm:ss')
      },
    },
    {
      id: 'actions',
      header: t('applicationManagement.actions'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex items-center gap-1">
            <Button
              variant="link"
              size="sm"
              onClick={() => handleManageKeys(record)}
              className="h-auto p-0"
              title={t('applicationManagement.manageKeys')}
            >
              <Key className="h-4 w-4" />
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => handleEdit(record)}
              className="h-auto p-0"
              title={t('common.edit')}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => handleDelete(record.id)}
              className="h-auto p-0 text-red-600 hover:text-red-700"
              title={t('common.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )
      },
    },
  ]

  const keyColumns: ColumnDef<ApiKey>[] = [
    {
      accessorKey: 'name',
      header: t('applicationManagement.keyName'),
      cell: ({ row }) => {
        const name = row.getValue('name') as string | null
        return name || t('applicationManagement.unnamed')
      },
    },
    {
      accessorKey: 'key',
      header: t('applicationManagement.apiKey'),
      cell: ({ row }) => {
        const key = row.getValue('key') as string
        const record = row.original
        return (
          <div className="flex items-center gap-2">
            <code className="text-xs bg-gray-100 px-2 py-1 rounded">
              {visibleKeys.has(record.id) ? key : maskApiKey(key)}
            </code>
            <Button
              variant="link"
              size="sm"
              onClick={() => toggleKeyVisibility(record.id)}
              className="h-auto p-0"
            >
              {visibleKeys.has(record.id) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button variant="link" size="sm" onClick={() => copyToClipboard(key)} className="h-auto p-0">
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        )
      },
    },
    {
      accessorKey: 'is_active',
      header: t('applicationManagement.status'),
      cell: ({ row }) => {
        const record = row.original
        const isActive = row.getValue('is_active') as boolean
        return <Switch checked={isActive} onCheckedChange={() => handleToggleKey(record.id)} />
      },
    },
    {
      accessorKey: 'last_used_at',
      header: t('applicationManagement.lastUsed'),
      cell: ({ row }) => {
        const time = row.getValue('last_used_at') as string | null
        return time ? format(new Date(time), 'yyyy-MM-dd HH:mm:ss') : t('applicationManagement.neverUsed')
      },
    },
    {
      accessorKey: 'created_at',
      header: t('applicationManagement.createdAt'),
      cell: ({ row }) => {
        const time = row.getValue('created_at') as string
        return format(new Date(time), 'yyyy-MM-dd HH:mm:ss')
      },
    },
    {
      id: 'actions',
      header: t('applicationManagement.actions'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <Button
            variant="link"
            size="sm"
            onClick={() => handleDeleteKey(record.id)}
            className="h-auto p-0 text-red-600 hover:text-red-700"
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {t('common.delete')}
          </Button>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold tracking-tight">{t('applicationManagement.title')}</h2>
        <Button onClick={handleCreate}>
          <Plus className="mr-2 h-4 w-4" />
          {t('applicationManagement.createApplication')}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={applications} loading={loading} pageSize={10} />
        </CardContent>
      </Card>

      {/* Application Create/Edit Dialog */}
      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingApp
                ? t('applicationManagement.editApplication')
                : t('applicationManagement.createApplication')}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('applicationManagement.name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('applicationManagement.namePlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('applicationManagement.description')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder={t('applicationManagement.descriptionPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {editingApp && (
                <FormField
                  control={form.control}
                  name="is_active"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-4">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">{t('applicationManagement.status')}</FormLabel>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setModalVisible(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">{t('common.save')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* API Keys Management Dialog */}
      <Dialog
        open={keysModalVisible}
        onOpenChange={(open) => {
          setKeysModalVisible(open)
          if (!open) {
            setVisibleKeys(new Set())
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              <div className="flex items-center gap-2">
                <span>{t('applicationManagement.manageApiKeys')}</span>
                <span className="text-gray-500 text-sm font-normal">({currentAppName})</span>
              </div>
            </DialogTitle>
          </DialogHeader>

          <Card className="mb-4">
            <CardContent className="pt-6">
              <Form {...keyForm}>
                <form onSubmit={keyForm.handleSubmit(handleCreateKey)} className="flex gap-2">
                  <FormField
                    control={keyForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormControl>
                          <Input placeholder={t('applicationManagement.keyNamePlaceholder')} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit">
                    <Plus className="mr-2 h-4 w-4" />
                    {t('applicationManagement.createApiKey')}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          <DataTable columns={keyColumns} data={currentAppKeys} pageSize={5} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ApplicationManagement
