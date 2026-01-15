import React, { useState, useEffect, useMemo } from 'react'
import { Plus, Edit, Trash2, Key, Copy, Eye, EyeOff, Info, Search, X } from 'lucide-react'
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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
  // Source of application creation: 'manual' (UI/API) or 'auto_discovery' (gateway consumer)
  source?: 'manual' | 'auto_discovery'
  // External identifier for auto-discovered apps (e.g., gateway consumer name)
  external_id?: string
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
  // Filter by application source: 'all', 'manual', or 'auto_discovery'
  const [sourceFilter, setSourceFilter] = useState<'all' | 'manual' | 'auto_discovery'>('all')
  // Search by application name
  const [searchText, setSearchText] = useState('')
  // Detail drawer state
  const [detailDrawerVisible, setDetailDrawerVisible] = useState(false)
  const [selectedApp, setSelectedApp] = useState<Application | null>(null)

  // Filter applications based on source and search text
  const filteredApplications = useMemo(() => {
    let result = applications
    // Filter by source
    if (sourceFilter !== 'all') {
      result = result.filter((app) => (app.source || 'manual') === sourceFilter)
    }
    // Filter by search text (name or external_id)
    if (searchText.trim()) {
      const search = searchText.toLowerCase().trim()
      result = result.filter((app) =>
        app.name.toLowerCase().includes(search) ||
        (app.external_id && app.external_id.toLowerCase().includes(search))
      )
    }
    return result
  }, [applications, sourceFilter, searchText])

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

  const handleDeleteKey = async (keyId: string) => {
    const confirmed = await confirmDialog({
      title: t('applicationManagement.deleteKeyConfirm'),
      confirmText: t('common.yes'),
      cancelText: t('common.no'),
      variant: 'destructive',
    })

    if (confirmed) {
      try {
        await api.delete(`/api/v1/applications/${currentAppId}/keys/${keyId}`)
        toast.success(t('applicationManagement.keyDeleteSuccess'))
        await fetchApiKeys(currentAppId)
        fetchApplications()
      } catch (error) {
        toast.error(t('applicationManagement.keyDeleteError'))
      }
    }
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

  // Open detail drawer for an application
  const handleViewDetails = async (app: Application) => {
    setSelectedApp(app)
    setCurrentAppId(app.id)
    setCurrentAppName(app.name)
    await fetchApiKeys(app.id)
    setDetailDrawerVisible(true)
  }

  // Column order: name, description, protection, source, status, created_at, actions
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
          <span className="truncate max-w-[200px] block" title={desc || '-'}>
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
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1" title={t('applicationManagement.riskTypesTooltip')}>
              <span className="text-gray-600">{t('applicationManagement.scanners')}:</span>
              <Badge variant="default">
                {summary.risk_types_enabled}/{summary.total_risk_types}
              </Badge>
            </div>
            <div className="flex items-center gap-1" title={t('applicationManagement.dlpEntitiesTooltip')}>
              <span className="text-gray-600">{t('applicationManagement.dlpEntities')}:</span>
              <Badge variant="default">{summary.data_security_entities}</Badge>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'source',
      header: t('applicationManagement.source'),
      cell: ({ row }) => {
        const source = (row.getValue('source') as string) || 'manual'
        const isAutoDiscovered = source === 'auto_discovery'
        return (
          <Badge variant={isAutoDiscovered ? 'default' : 'secondary'}>
            {isAutoDiscovered
              ? t('applicationManagement.sourceAutoDiscovery')
              : t('applicationManagement.sourceManual')}
          </Badge>
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
          <div className="flex items-center gap-2">
            <Button
              variant="link"
              size="sm"
              onClick={() => handleViewDetails(record)}
              className="h-auto p-0"
            >
              {t('applicationManagement.viewDetails')}
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => handleDelete(record.id)}
              className="h-auto p-0 text-red-600 hover:text-red-700"
            >
              {t('common.delete')}
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
        <div className="flex items-center gap-4">
          {/* Name search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder={t('applicationManagement.searchPlaceholder')}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="pl-8 w-[200px]"
            />
            {searchText && (
              <button
                className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                onClick={() => setSearchText('')}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Source filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('applicationManagement.filterBySource')}:</span>
            <Select value={sourceFilter} onValueChange={(value: 'all' | 'manual' | 'auto_discovery') => setSourceFilter(value)}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('applicationManagement.filterAll')}</SelectItem>
                <SelectItem value="manual">{t('applicationManagement.sourceManual')}</SelectItem>
                <SelectItem value="auto_discovery">{t('applicationManagement.sourceAutoDiscovery')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('applicationManagement.createApplication')}
          </Button>
        </div>
      </div>

      {/* Show discovery instructions when no applications exist */}
      {applications.length === 0 && !loading && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>{t('applicationManagement.discovery.title')}</AlertTitle>
          <AlertDescription className="mt-2">
            <p className="mb-3">{t('applicationManagement.discovery.description')}</p>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <span className="font-semibold">1.</span>
                <span>{t('applicationManagement.discovery.step1')}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-semibold">2.</span>
                <span>{t('applicationManagement.discovery.step2')}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-semibold">3.</span>
                <span>{t('applicationManagement.discovery.step3')}</span>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={filteredApplications} loading={loading} pageSize={10} />
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

      {/* Application Detail Drawer */}
      <Sheet open={detailDrawerVisible} onOpenChange={(open) => {
        setDetailDrawerVisible(open)
        if (!open) {
          setVisibleKeys(new Set())
        }
      }}>
        <SheetContent className="w-[500px] sm:w-[640px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('applicationManagement.appDetails')}</SheetTitle>
            <SheetDescription>
              {selectedApp?.name}
              {selectedApp?.source === 'auto_discovery' && selectedApp?.external_id && (
                <span className="text-gray-500 ml-2">({selectedApp.external_id})</span>
              )}
            </SheetDescription>
          </SheetHeader>

          {selectedApp && (
            <div className="mt-6 space-y-6">
              {/* Basic Info Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">{t('applicationManagement.basicInfo')}</h4>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      handleEdit(selectedApp)
                    }}
                  >
                    <Edit className="h-4 w-4 mr-1" />
                    {t('common.edit')}
                  </Button>
                </div>
                <div className="rounded-lg border p-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">{t('applicationManagement.name')}:</span>
                    <span className="font-medium">{selectedApp.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">{t('applicationManagement.description')}:</span>
                    <span className="max-w-[250px] text-right">{selectedApp.description || '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">{t('applicationManagement.status')}:</span>
                    <Badge variant={selectedApp.is_active ? 'outline' : 'destructive'}>
                      {selectedApp.is_active ? t('applicationManagement.active') : t('applicationManagement.inactive')}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">{t('applicationManagement.source')}:</span>
                    <Badge variant={selectedApp.source === 'auto_discovery' ? 'default' : 'secondary'}>
                      {selectedApp.source === 'auto_discovery'
                        ? t('applicationManagement.sourceAutoDiscovery')
                        : t('applicationManagement.sourceManual')}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">{t('applicationManagement.createdAt')}:</span>
                    <span>{format(new Date(selectedApp.created_at), 'yyyy-MM-dd HH:mm:ss')}</span>
                  </div>
                </div>
              </div>

              {/* API Keys Section */}
              <div className="space-y-3">
                <h4 className="font-medium">{t('applicationManagement.apiKeysManagement')}</h4>
                <div className="rounded-lg border p-3 space-y-3">
                  {/* Create new key */}
                  <Form {...keyForm}>
                    <form onSubmit={keyForm.handleSubmit(handleCreateKey)} className="flex gap-2">
                      <FormField
                        control={keyForm.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem className="flex-1">
                            <FormControl>
                              <Input
                                placeholder={t('applicationManagement.keyNamePlaceholder')}
                                {...field}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <Button type="submit" size="sm">
                        <Plus className="h-4 w-4 mr-1" />
                        {t('applicationManagement.createApiKey')}
                      </Button>
                    </form>
                  </Form>

                  {/* Existing keys */}
                  {currentAppKeys.length > 0 ? (
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {currentAppKeys.map((apiKey) => (
                        <div key={apiKey.id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{apiKey.name || t('applicationManagement.unnamed')}</div>
                            <div className="flex items-center gap-1 mt-1">
                              <code className="text-xs bg-gray-200 px-1 py-0.5 rounded truncate max-w-[200px]">
                                {visibleKeys.has(apiKey.id) ? apiKey.key : maskApiKey(apiKey.key)}
                              </code>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleKeyVisibility(apiKey.id)}
                                className="h-6 w-6 p-0"
                              >
                                {visibleKeys.has(apiKey.id) ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => copyToClipboard(apiKey.key)}
                                className="h-6 w-6 p-0"
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 ml-2">
                            <Switch
                              checked={apiKey.is_active}
                              onCheckedChange={() => handleToggleKey(apiKey.id)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteKey(apiKey.id)}
                              className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500 text-center py-2">
                      {t('applicationManagement.noApiKeys')}
                    </div>
                  )}
                </div>
              </div>

              {/* Protection Summary Section */}
              {selectedApp.protection_summary && (
                <div className="space-y-3">
                  <h4 className="font-medium">{t('applicationManagement.protectionSummary')}</h4>
                  <div className="rounded-lg border p-3 space-y-3 text-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.scanners')}:</span>
                        <Badge variant="default">
                          {selectedApp.protection_summary.risk_types_enabled}/{selectedApp.protection_summary.total_risk_types}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.dlpEntities')}:</span>
                        <Badge variant="default">{selectedApp.protection_summary.data_security_entities}</Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.sensitivityLevel')}:</span>
                        <Badge variant="secondary">
                          {t(`sensitivity.${selectedApp.protection_summary.sensitivity_level}`)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.banPolicy')}:</span>
                        <Badge variant={selectedApp.protection_summary.ban_policy_enabled ? 'outline' : 'secondary'}>
                          {selectedApp.protection_summary.ban_policy_enabled ? t('common.enabled') : t('common.disabled')}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.blacklist')}:</span>
                        <Badge variant="destructive">{selectedApp.protection_summary.blacklist_count}</Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.whitelist')}:</span>
                        <Badge variant="outline">{selectedApp.protection_summary.whitelist_count}</Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600">{t('applicationManagement.knowledgeBase')}:</span>
                        <Badge variant="secondary">{selectedApp.protection_summary.knowledge_base_count}</Badge>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default ApplicationManagement
