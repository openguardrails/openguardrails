import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Edit2, Trash2, Route, TestTube } from 'lucide-react'
import api, { modelRoutesApi, proxyModelsApi, ModelRoute, ModelRouteCreateData, ModelRouteUpdateData } from '../../services/api'
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
import { Textarea } from '@/components/ui/textarea'

interface Application {
  id: string
  name: string
}

interface UpstreamApi {
  id: string
  config_name: string
  provider?: string
}

const formSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().optional(),
  model_pattern: z.string().min(1, 'Model pattern is required').max(255),
  match_type: z.enum(['exact', 'prefix']),
  upstream_api_config_id: z.string().min(1, 'Upstream API is required'),
  priority: z.number().min(0).max(10000),
})

type FormData = z.infer<typeof formSchema>

const ModelRoutes: React.FC = () => {
  const { t } = useTranslation()
  const [routes, setRoutes] = useState<ModelRoute[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [upstreamApis, setUpstreamApis] = useState<UpstreamApi[]>([])
  const [loading, setLoading] = useState(false)
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [isTestModalVisible, setIsTestModalVisible] = useState(false)
  const [editingRoute, setEditingRoute] = useState<ModelRoute | null>(null)
  const [selectedApplicationIds, setSelectedApplicationIds] = useState<string[]>([])
  const [isActive, setIsActive] = useState(true)
  const [testModelName, setTestModelName] = useState('')
  const [testApplicationId, setTestApplicationId] = useState<string | undefined>()
  const [testResult, setTestResult] = useState<any>(null)
  const { onUserSwitch } = useAuth()

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      description: '',
      model_pattern: '',
      match_type: 'prefix',
      upstream_api_config_id: '',
      priority: 100,
    },
  })

  // Fetch routes list
  const fetchRoutes = async () => {
    setLoading(true)
    try {
      const data = await modelRoutesApi.list(true)
      setRoutes(data)
    } catch (error) {
      console.error('Failed to fetch routes:', error)
      toast.error(t('modelRoutes.fetchFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Fetch applications
  const fetchApplications = async () => {
    try {
      const response = await api.get('/api/v1/applications')
      // Response is an array of applications directly
      setApplications(Array.isArray(response.data) ? response.data : [])
    } catch (error) {
      console.error('Failed to fetch applications:', error)
    }
  }

  // Fetch upstream APIs
  const fetchUpstreamApis = async () => {
    try {
      const response = await proxyModelsApi.list()
      if (response.success) {
        setUpstreamApis(response.data.filter((api: any) => api.is_active))
      }
    } catch (error) {
      console.error('Failed to fetch upstream APIs:', error)
    }
  }

  useEffect(() => {
    fetchRoutes()
    fetchApplications()
    fetchUpstreamApis()
  }, [])

  // Listen to user switch event
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchRoutes()
      fetchApplications()
      fetchUpstreamApis()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Open create modal
  const showCreateModal = () => {
    setEditingRoute(null)
    setSelectedApplicationIds([])
    setIsActive(true)
    form.reset({
      name: '',
      description: '',
      model_pattern: '',
      match_type: 'prefix',
      upstream_api_config_id: '',
      priority: 100,
    })
    setIsModalVisible(true)
  }

  // Open edit modal
  const showEditModal = async (route: ModelRoute) => {
    setEditingRoute(route)
    setSelectedApplicationIds(route.applications.map(a => a.id))
    setIsActive(route.is_active)
    form.reset({
      name: route.name,
      description: route.description || '',
      model_pattern: route.model_pattern,
      match_type: route.match_type,
      upstream_api_config_id: route.upstream_api_config.id,
      priority: route.priority,
    })
    setIsModalVisible(true)
  }

  // Handle form submit
  const onSubmit = async (values: FormData) => {
    try {
      if (editingRoute) {
        const updateData: ModelRouteUpdateData = {
          ...values,
          is_active: isActive,
          application_ids: selectedApplicationIds.length > 0 ? selectedApplicationIds : [],
        }
        await modelRoutesApi.update(editingRoute.id, updateData)
        toast.success(t('modelRoutes.updateSuccess'))
      } else {
        const createData: ModelRouteCreateData = {
          ...values,
          application_ids: selectedApplicationIds.length > 0 ? selectedApplicationIds : undefined,
        }
        await modelRoutesApi.create(createData)
        toast.success(t('modelRoutes.createSuccess'))
      }
      setIsModalVisible(false)
      fetchRoutes()
    } catch (error: any) {
      console.error('Failed to save route:', error)
      const message = error.response?.data?.detail || t('modelRoutes.saveFailed')
      toast.error(message)
    }
  }

  // Handle delete
  const handleDelete = async (route: ModelRoute) => {
    const confirmed = await confirmDialog({
      title: t('modelRoutes.deleteConfirmTitle'),
      description: t('modelRoutes.deleteConfirmDescription', { name: route.name }),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'destructive',
    })

    if (!confirmed) return

    try {
      await modelRoutesApi.delete(route.id)
      toast.success(t('modelRoutes.deleteSuccess'))
      fetchRoutes()
    } catch (error) {
      console.error('Failed to delete route:', error)
      toast.error(t('modelRoutes.deleteFailed'))
    }
  }

  // Handle test
  const handleTest = async () => {
    if (!testModelName.trim()) {
      toast.error(t('modelRoutes.enterModelName'))
      return
    }

    try {
      const result = await modelRoutesApi.test(testModelName, testApplicationId)
      setTestResult(result)
    } catch (error) {
      console.error('Failed to test route:', error)
      toast.error(t('modelRoutes.testFailed'))
    }
  }

  // Toggle application selection
  const toggleApplicationSelection = (appId: string) => {
    setSelectedApplicationIds(prev =>
      prev.includes(appId)
        ? prev.filter(id => id !== appId)
        : [...prev, appId]
    )
  }

  // Table columns
  const columns: ColumnDef<ModelRoute>[] = [
    {
      accessorKey: 'name',
      header: t('modelRoutes.name'),
      cell: ({ row }) => (
        <div className="font-medium">{row.original.name}</div>
      ),
    },
    {
      accessorKey: 'model_pattern',
      header: t('modelRoutes.pattern'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <code className="px-2 py-1 bg-slate-100 rounded text-sm">{row.original.model_pattern}</code>
          <Badge variant={row.original.match_type === 'exact' ? 'default' : 'secondary'}>
            {t(`modelRoutes.matchType.${row.original.match_type}`)}
          </Badge>
        </div>
      ),
    },
    {
      accessorKey: 'upstream_api_config',
      header: t('modelRoutes.upstreamApi'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span>{row.original.upstream_api_config.config_name}</span>
          {row.original.upstream_api_config.provider && (
            <Badge variant="outline">{row.original.upstream_api_config.provider}</Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'priority',
      header: t('modelRoutes.priority'),
      cell: ({ row }) => (
        <Badge variant="outline">{row.original.priority}</Badge>
      ),
    },
    {
      accessorKey: 'applications',
      header: t('modelRoutes.applications'),
      cell: ({ row }) => (
        <div>
          {row.original.applications.length === 0 ? (
            <Badge variant="secondary">{t('modelRoutes.allApplications')}</Badge>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.original.applications.slice(0, 2).map(app => (
                <Badge key={app.id} variant="outline">{app.name}</Badge>
              ))}
              {row.original.applications.length > 2 && (
                <Badge variant="outline">+{row.original.applications.length - 2}</Badge>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'is_active',
      header: t('common.status'),
      cell: ({ row }) => (
        <Badge variant={row.original.is_active ? 'default' : 'secondary'}>
          {row.original.is_active ? t('common.active') : t('common.inactive')}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => showEditModal(row.original)}>
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleDelete(row.original)}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Route className="h-5 w-5" />
                {t('modelRoutes.title')}
              </CardTitle>
              <CardDescription>{t('modelRoutes.description')}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setIsTestModalVisible(true)}>
                <TestTube className="h-4 w-4 mr-2" />
                {t('modelRoutes.testRouting')}
              </Button>
              <Button onClick={showCreateModal}>
                <Plus className="h-4 w-4 mr-2" />
                {t('modelRoutes.addRoute')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={routes}
            searchKey="name"
            searchPlaceholder={t('modelRoutes.searchPlaceholder')}
          />
        </CardContent>
      </Card>

      {/* Create/Edit Modal */}
      <Dialog open={isModalVisible} onOpenChange={setIsModalVisible}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingRoute ? t('modelRoutes.editRoute') : t('modelRoutes.createRoute')}
            </DialogTitle>
            <DialogDescription>
              {t('modelRoutes.modalDescription')}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('modelRoutes.name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('modelRoutes.namePlaceholder')} {...field} />
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
                    <FormLabel>{t('modelRoutes.descriptionLabel')}</FormLabel>
                    <FormControl>
                      <Textarea placeholder={t('modelRoutes.descriptionPlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="model_pattern"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('modelRoutes.pattern')}</FormLabel>
                      <FormControl>
                        <Input placeholder="gpt-4" {...field} />
                      </FormControl>
                      <FormDescription>{t('modelRoutes.patternHelp')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="match_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('modelRoutes.matchTypeLabel')}</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="prefix">{t('modelRoutes.matchType.prefix')}</SelectItem>
                          <SelectItem value="exact">{t('modelRoutes.matchType.exact')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>{t('modelRoutes.matchTypeHelp')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="upstream_api_config_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('modelRoutes.upstreamApi')}</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={t('modelRoutes.selectUpstreamApi')} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {upstreamApis.map(api => (
                            <SelectItem key={api.id} value={api.id}>
                              {api.config_name} {api.provider && `(${api.provider})`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('modelRoutes.priority')}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={10000}
                          {...field}
                          onChange={e => field.onChange(parseInt(e.target.value) || 0)}
                        />
                      </FormControl>
                      <FormDescription>{t('modelRoutes.priorityHelp')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div>
                <Label>{t('modelRoutes.applicationsLabel')}</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  {t('modelRoutes.applicationsHelp')}
                </p>
                <div className="flex flex-wrap gap-2 p-3 border rounded-md min-h-[60px]">
                  {applications.map(app => (
                    <Badge
                      key={app.id}
                      variant={selectedApplicationIds.includes(app.id) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => toggleApplicationSelection(app.id)}
                    >
                      {app.name}
                    </Badge>
                  ))}
                  {applications.length === 0 && (
                    <span className="text-sm text-muted-foreground">{t('modelRoutes.noApplications')}</span>
                  )}
                </div>
              </div>

              {editingRoute && (
                <div className="flex items-center space-x-2">
                  <Switch
                    id="is_active"
                    checked={isActive}
                    onCheckedChange={setIsActive}
                  />
                  <Label htmlFor="is_active">{t('modelRoutes.isActive')}</Label>
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsModalVisible(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">
                  {editingRoute ? t('common.save') : t('common.create')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Test Modal */}
      <Dialog open={isTestModalVisible} onOpenChange={setIsTestModalVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('modelRoutes.testRouting')}</DialogTitle>
            <DialogDescription>
              {t('modelRoutes.testDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>{t('modelRoutes.modelName')}</Label>
              <Input
                placeholder="gpt-4-turbo"
                value={testModelName}
                onChange={e => setTestModelName(e.target.value)}
              />
            </div>
            <div>
              <Label>{t('modelRoutes.applicationOptional')}</Label>
              <Select
                value={testApplicationId || '__all__'}
                onValueChange={value => setTestApplicationId(value === '__all__' ? undefined : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('modelRoutes.anyApplication')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('modelRoutes.anyApplication')}</SelectItem>
                  {applications.map(app => (
                    <SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleTest} className="w-full">
              <TestTube className="h-4 w-4 mr-2" />
              {t('modelRoutes.runTest')}
            </Button>

            {testResult && (
              <div className={`p-4 rounded-md ${testResult.matched ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
                {testResult.matched ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-green-700 font-medium">
                      <span>{t('modelRoutes.routeMatched')}</span>
                    </div>
                    <div className="text-sm text-green-600">
                      <p><strong>{t('modelRoutes.upstreamApi')}:</strong> {testResult.upstream_api_config?.config_name}</p>
                      {testResult.upstream_api_config?.provider && (
                        <p><strong>{t('modelRoutes.provider')}:</strong> {testResult.upstream_api_config.provider}</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-yellow-700">
                    <p className="font-medium">{t('modelRoutes.noRouteMatched')}</p>
                    <p className="text-sm">{testResult.message}</p>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setIsTestModalVisible(false)
              setTestResult(null)
              setTestModelName('')
              setTestApplicationId(undefined)
            }}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ModelRoutes
