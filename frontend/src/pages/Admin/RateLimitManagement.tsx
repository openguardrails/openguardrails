import React, { useState, useEffect } from 'react'
import { Zap, Edit, Trash2, Plus, RefreshCw, User, Info, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { InputNumber } from '@/components/ui/input-number'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/utils/confirm-dialog'
import { adminApi } from '../../services/api'
import type { ColumnDef } from '@tanstack/react-table'

interface UserType {
  id: string
  email: string
  is_active: boolean
  is_verified: boolean
  is_super_admin: boolean
}

interface RateLimit {
  tenant_id: string
  email: string
  requests_per_second: number
  is_active: boolean
}

const RateLimitManagement: React.FC = () => {
  const { t } = useTranslation()
  const [rateLimits, setRateLimits] = useState<RateLimit[]>([])
  const [users, setUsers] = useState<UserType[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingRateLimit, setEditingRateLimit] = useState<RateLimit | null>(null)
  const [searchText, setSearchText] = useState('')
  const [total, setTotal] = useState(0)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10 })
  const [sortBy, setSortBy] = useState<'requests_per_second' | 'email'>('requests_per_second')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  const formSchema = z.object({
    tenant_id: z.string().min(1, t('rateLimit.selectTenant')),
    requests_per_second: z.number().min(0).max(1000),
    is_active: z.boolean().default(true),
  })

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      requests_per_second: 1,
      is_active: true,
    },
  })

  const loadRateLimits = async (
    search?: string,
    page = 1,
    pageSize = 10,
    sortByParam?: string,
    sortOrderParam?: string
  ) => {
    setLoading(true)
    try {
      const response = await adminApi.getRateLimits({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        search: search || undefined,
        sort_by: sortByParam || sortBy,
        sort_order: sortOrderParam || sortOrder,
      })
      setRateLimits(response.data || [])
      setTotal(response.total || 0)
    } catch (error) {
      console.error('Failed to load rate limits:', error)
      toast.error(t('rateLimit.loadRateLimitsFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadUsers = async () => {
    try {
      const response = await adminApi.getUsers()
      setUsers(response.users || [])
    } catch (error) {
      console.error('Failed to load tenants:', error)
    }
  }

  useEffect(() => {
    loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder)
    loadUsers()
  }, [])

  const handleSearch = (value: string) => {
    setSearchText(value)
    setPagination({ ...pagination, current: 1 })
    loadRateLimits(value, 1, pagination.pageSize, sortBy, sortOrder)
  }

  const handleEdit = (rateLimit: RateLimit) => {
    setEditingRateLimit(rateLimit)
    form.reset({
      tenant_id: rateLimit.tenant_id,
      requests_per_second: rateLimit.requests_per_second,
      is_active: rateLimit.is_active,
    })
    setModalVisible(true)
  }

  const handleAdd = () => {
    setEditingRateLimit(null)
    form.reset({
      tenant_id: '',
      requests_per_second: 1,
      is_active: true,
    })
    setModalVisible(true)
  }

  const handleSave = async (values: z.infer<typeof formSchema>) => {
    try {
      if (editingRateLimit) {
        // Update rate limit config
        await adminApi.setUserRateLimit({
          tenant_id: editingRateLimit.tenant_id,
          requests_per_second: values.requests_per_second,
        })
        toast.success(t('rateLimit.rateLimitUpdated'))
      } else {
        // Create new rate limit config
        await adminApi.setUserRateLimit({
          tenant_id: values.tenant_id,
          requests_per_second: values.requests_per_second,
        })
        toast.success(t('rateLimit.rateLimitCreated'))
      }

      setModalVisible(false)
      loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder)
    } catch (error: any) {
      console.error('Save rate limit failed:', error)
      toast.error(error.response?.data?.detail || t('common.saveFailed'))
    }
  }

  const handleDelete = async (tenantId: string) => {
    const confirmed = await confirmDialog({
      title: t('rateLimit.confirmDeleteRateLimit'),
      description: t('rateLimit.deleteRateLimitWarning'),
    })

    if (!confirmed) return

    try {
      await adminApi.removeUserRateLimit(tenantId)
      toast.success(t('rateLimit.rateLimitDeleted'))
      loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder)
    } catch (error: any) {
      console.error('Delete rate limit failed:', error)
      toast.error(error.response?.data?.detail || t('common.deleteFailed'))
    }
  }

  const getAvailableUsers = () => {
    // Show all users - Allow configuring any tenant
    return users
  }

  const getRpsDisplay = (rps: number) => {
    if (rps === 0) {
      return <Badge variant="default">{t('rateLimit.unlimited')}</Badge>
    }
    const variant =
      rps > 10 ? 'default' : rps > 5 ? ('secondary' as const) : ('destructive' as const)
    return (
      <Badge variant={variant}>
        {rps} {t('rateLimit.requestsPerSecond')}
      </Badge>
    )
  }

  const getStatistics = () => {
    const totalUsers = rateLimits.length
    const unlimitedUsers = rateLimits.filter((rl) => rl.requests_per_second === 0).length
    const avgRps =
      rateLimits.length > 0
        ? rateLimits.filter((rl) => rl.requests_per_second > 0).reduce((sum, rl) => sum + rl.requests_per_second, 0) /
            rateLimits.filter((rl) => rl.requests_per_second > 0).length || 0
        : 0

    return { totalUsers, unlimitedUsers, avgRps }
  }

  const stats = getStatistics()

  const columns: ColumnDef<RateLimit>[] = [
    {
      id: 'user',
      header: t('rateLimit.tenant'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-gray-400" />
            <span>{record.email}</span>
          </div>
        )
      },
    },
    {
      id: 'rps',
      header: t('rateLimit.rateLimitConfig'),
      cell: ({ row }) => getRpsDisplay(row.original.requests_per_second),
    },
    {
      accessorKey: 'is_active',
      header: t('common.status'),
      cell: ({ row }) => {
        const isActive = row.getValue('is_active') as boolean
        return (
          <Badge variant={isActive ? 'default' : 'destructive'}>
            {isActive ? t('common.enabled') : t('common.disabled')}
          </Badge>
        )
      },
    },
    {
      id: 'description',
      header: t('common.description'),
      cell: ({ row }) => {
        const record = row.original
        if (record.requests_per_second === 0) {
          return <span className="text-sm text-gray-600">{t('rateLimit.allowUnlimitedCalls')}</span>
        }
        const dailyMax = record.requests_per_second * 86400
        return (
          <span className="text-sm text-gray-600">
            {t('rateLimit.dailyMaxCalls', { count: dailyMax.toLocaleString() })}
          </span>
        )
      },
    },
    {
      id: 'actions',
      header: t('common.operation'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleEdit(record)}
              title={t('rateLimit.editConfig')}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(record.tenant_id)}
              title={t('rateLimit.deleteConfig')}
            >
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('rateLimit.totalConfigurations')}
                </p>
                <p className="text-2xl font-bold mt-2">{stats.totalUsers}</p>
              </div>
              <User className="h-8 w-8 text-gray-400" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('rateLimit.unlimitedTenants')}
                </p>
                <p className="text-2xl font-bold mt-2 text-green-600">{stats.unlimitedUsers}</p>
              </div>
              <Zap className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('rateLimit.averageRateLimit')}
                </p>
                <p className="text-2xl font-bold mt-2">
                  {stats.avgRps.toFixed(1)} <span className="text-sm font-normal">RPS</span>
                </p>
              </div>
              <Zap className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {t('rateLimit.restrictedTenants')}
                </p>
                <p className="text-2xl font-bold mt-2 text-red-600">
                  {stats.totalUsers - stats.unlimitedUsers}
                </p>
              </div>
              <Zap className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div className="space-y-2">
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                {t('rateLimit.tenantRateLimitConfig')}
              </CardTitle>
              <div className="flex items-center gap-1 text-sm text-gray-600">
                <span>{t('rateLimit.configureApiCallFrequency')}</span>
                <Info
                  className="h-4 w-4 cursor-help"
                  title={t('rateLimit.rateLimitExplanation')}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder={t('rateLimit.searchByEmail')}
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value)
                    if (!e.target.value) {
                      handleSearch('')
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSearch(searchText)
                    }
                  }}
                  className="w-[300px] pl-10"
                />
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  loadRateLimits(searchText, pagination.current, pagination.pageSize, sortBy, sortOrder)
                }
                disabled={loading}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('common.refresh')}
              </Button>
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" />
                {t('rateLimit.addConfig')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} data={rateLimits} loading={loading} />
        </CardContent>
      </Card>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingRateLimit
                ? t('rateLimit.editRateLimitConfig')
                : t('rateLimit.addRateLimitConfig')}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
              {!editingRateLimit && (
                <FormField
                  control={form.control}
                  name="tenant_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('rateLimit.selectTenant')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={t('rateLimit.selectTenantPlaceholder')} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {getAvailableUsers().map((user) => (
                            <SelectItem key={user.id} value={user.id}>
                              <div className="flex items-center gap-2">
                                <span>{user.email}</span>
                                {user.is_super_admin && (
                                  <Badge variant="destructive">{t('admin.admin')}</Badge>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="requests_per_second"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('rateLimit.requestFrequencyLimit')}</FormLabel>
                    <FormControl>
                      <InputNumber
                        value={field.value}
                        onChange={field.onChange}
                        min={0}
                        max={1000}
                        placeholder={t('rateLimit.requestFrequencyPlaceholder')}
                        className="w-full"
                      />
                    </FormControl>
                    <FormDescription>{t('rateLimit.requestFrequencyExtra')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between border rounded-lg p-3">
                    <div>
                      <FormLabel>{t('rateLimit.enableStatus')}</FormLabel>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

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
    </div>
  )
}

export default RateLimitManagement
