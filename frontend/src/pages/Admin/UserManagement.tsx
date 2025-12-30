import React, { useState, useEffect } from 'react'
import { User, Edit, Trash2, Plus, RefreshCw, Mail, Key, Copy, TrendingUp, Clock, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import ReactECharts from 'echarts-for-react'

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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/utils/confirm-dialog'
import { useAuth } from '../../contexts/AuthContext'
import { adminApi } from '../../services/api'
import type { ColumnDef } from '@tanstack/react-table'

interface UserType {
  id: string
  email: string
  is_active: boolean
  is_verified: boolean
  is_super_admin: boolean
  api_key: string
  detection_count: number
  last_activity: string | null
  created_at: string
  updated_at: string
}

interface AdminStats {
  total_users: number
  total_detections: number
  user_detection_counts: Array<{
    tenant_id: string
    email: string
    detection_count: number
  }>
}

interface TenantAnalytics {
  latest_created_tenants: Array<{
    id: string
    email: string
    created_at: string | null
    is_active: boolean
    is_verified: boolean
  }>
  recently_active_tenants: Array<{
    id: string
    email: string
    last_activity: string | null
    is_active: boolean
    is_verified: boolean
  }>
  creation_trend: Array<{
    date: string
    count: number
  }>
  usage_trend: Array<{
    date: string
    count: number
  }>
}

const UserManagement: React.FC = () => {
  const { t } = useTranslation()
  const [users, setUsers] = useState<UserType[]>([])
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null)
  const [tenantAnalytics, setTenantAnalytics] = useState<TenantAnalytics | null>(null)
  const [loading, setLoading] = useState(false)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingUser, setEditingUser] = useState<UserType | null>(null)
  const [searchText, setSearchText] = useState('')
  const [sortBy, setSortBy] = useState<'created_at' | 'detection_count' | 'last_activity'>('created_at')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)

  const { user: currentUser, switchToUser, switchInfo } = useAuth()

  const formSchema = z.object({
    email: z.string().email(t('admin.validEmailRequired')),
    password: z.string().min(6, t('admin.passwordMinLength')).optional(),
    is_active: z.boolean().default(true),
    is_verified: z.boolean().default(false),
  })

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      is_active: true,
      is_verified: false,
    },
  })

  const loadAdminStats = async () => {
    try {
      const response = await adminApi.getAdminStats()
      setAdminStats(response.data)
    } catch (error) {
      console.error('Failed to load admin stats:', error)
      toast.error(t('admin.loadStatsFailed'))
    }
  }

  const loadTenantAnalytics = async () => {
    setAnalyticsLoading(true)
    try {
      const response = await adminApi.getTenantAnalytics(30)
      setTenantAnalytics(response.data)
    } catch (error) {
      console.error('Failed to load tenant analytics:', error)
      toast.error(t('admin.loadAnalyticsFailed'))
    } finally {
      setAnalyticsLoading(false)
    }
  }

  const loadUsers = async () => {
    setLoading(true)
    try {
      const skip = (currentPage - 1) * pageSize
      const response = await adminApi.getUsers({ 
        sort_by: sortBy, 
        sort_order: sortOrder,
        skip,
        limit: pageSize
      })
      setUsers(response.users || [])
      setTotal(response.total || 0)
    } catch (error) {
      console.error('Failed to load users:', error)
      toast.error(t('admin.loadTenantsFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadData = async () => {
    await Promise.all([loadUsers(), loadAdminStats(), loadTenantAnalytics()])
  }

  useEffect(() => {
    loadData()
  }, [sortBy, sortOrder, currentPage, pageSize])

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
  }

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setCurrentPage(1) // Reset to first page when changing page size
  }

  const handleEdit = (user: UserType) => {
    setEditingUser(user)
    form.reset({
      email: user.email,
      is_active: user.is_active,
      is_verified: user.is_verified,
    })
    setModalVisible(true)
  }

  const handleAdd = () => {
    setEditingUser(null)
    form.reset({
      email: '',
      password: '',
      is_active: true,
      is_verified: false,
    })
    setModalVisible(true)
  }

  const handleSave = async (values: z.infer<typeof formSchema>) => {
    try {
      if (editingUser) {
        // Update tenant
        await adminApi.updateUser(editingUser.id, values)
        toast.success(t('admin.tenantUpdated'))
      } else {
        // Create new tenant
        await adminApi.createUser(values)
        toast.success(t('admin.tenantCreated'))
      }

      setModalVisible(false)
      loadUsers()
    } catch (error: any) {
      console.error('Save user failed:', error)
      toast.error(error.response?.data?.detail || t('admin.saveFailed'))
    }
  }

  const handleDelete = async (tenantId: string) => {
    const confirmed = await confirmDialog({
      title: t('admin.confirmDeleteTenant'),
      description: t('admin.cannotRecover'),
    })

    if (!confirmed) return

    try {
      await adminApi.deleteUser(tenantId)
      toast.success(t('admin.tenantDeleted'))
      loadUsers()
    } catch (error: any) {
      console.error('Delete user failed:', error)
      toast.error(error.response?.data?.detail || t('admin.deleteFailed'))
    }
  }

  const handleResetApiKey = async (tenantId: string) => {
    const confirmed = await confirmDialog({
      title: t('admin.resetApiKey'),
      description: t('admin.resetApiKeyConfirm'),
    })

    if (!confirmed) return

    try {
      await adminApi.resetUserApiKey(tenantId)
      toast.success(t('admin.apiKeyReset'))
      loadUsers()
    } catch (error: any) {
      console.error('Reset API key failed:', error)
      toast.error(error.response?.data?.detail || t('admin.resetApiFailed'))
    }
  }

  const handleSwitchToUser = async (tenantId: string, email: string) => {
    try {
      await switchToUser(tenantId)
      toast.success(t('admin.switchedToTenant', { email }))
      // Refresh current page to update status
      window.location.reload()
    } catch (error: any) {
      console.error('Switch user failed:', error)
      toast.error(error.response?.data?.detail || t('admin.switchTenantFailed'))
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success(t('common.copied'))
  }

  const columns: ColumnDef<UserType>[] = [
    {
      accessorKey: 'email',
      header: t('admin.tenantEmail'),
      cell: ({ row }) => {
        const record = row.original
        const canSwitch =
          currentUser?.is_super_admin &&
          record.id !== currentUser?.id &&
          !switchInfo.is_switched

        return (
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-gray-400" />
            {canSwitch ? (
              <span
                className="cursor-pointer text-blue-600 hover:underline"
                onClick={() => handleSwitchToUser(record.id, record.email)}
                title={t('admin.clickToSwitch')}
              >
                {record.email}
              </span>
            ) : (
              <span>{record.email}</span>
            )}
            {record.id === currentUser?.id && (
              <Badge variant="default">{t('admin.currentTenant')}</Badge>
            )}
            {switchInfo.is_switched && switchInfo.target_user?.id === record.id && (
              <Badge variant="secondary">{t('admin.switching')}</Badge>
            )}
          </div>
        )
      },
    },
    {
      id: 'status',
      header: t('common.status'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex flex-col gap-1">
            <Badge variant={record.is_active ? 'default' : 'destructive'}>
              {record.is_active ? t('admin.active') : t('admin.inactive')}
            </Badge>
            <Badge variant={record.is_verified ? 'default' : 'secondary'}>
              {record.is_verified ? t('admin.verified') : t('admin.unverified')}
            </Badge>
            {record.is_super_admin && <Badge variant="destructive">{t('admin.admin')}</Badge>}
          </div>
        )
      },
    },
    {
      accessorKey: 'id',
      header: 'UUID',
      cell: ({ row }) => {
        const id = row.getValue('id') as string
        return (
          <div className="flex items-center gap-2">
            <code className="text-xs bg-gray-100 px-2 py-1 rounded">{id.substring(0, 8)}...</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(id)}
              title={t('common.copy')}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        )
      },
    },
    {
      accessorKey: 'detection_count',
      header: () => {
        const isActive = sortBy === 'detection_count'
        return (
          <div
            className="flex items-center gap-1 cursor-pointer hover:text-primary"
            onClick={() => {
              if (isActive) {
                setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
              } else {
                setSortBy('detection_count')
                setSortOrder('desc')
              }
            }}
          >
            {t('admin.detectionCount')}
            {isActive && (
              <span className="text-xs">{sortOrder === 'desc' ? '↓' : '↑'}</span>
            )}
          </div>
        )
      },
      cell: ({ row }) => {
        const count = row.getValue('detection_count') as number
        return <Badge variant={count > 0 ? 'default' : 'outline'}>{count}</Badge>
      },
    },
    {
      accessorKey: 'last_activity',
      header: () => {
        const isActive = sortBy === 'last_activity'
        return (
          <div
            className="flex items-center gap-1 cursor-pointer hover:text-primary"
            onClick={() => {
              if (isActive) {
                setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
              } else {
                setSortBy('last_activity')
                setSortOrder('desc')
              }
            }}
          >
            {t('admin.lastActivity')}
            {isActive && (
              <span className="text-xs">{sortOrder === 'desc' ? '↓' : '↑'}</span>
            )}
          </div>
        )
      },
      cell: ({ row }) => {
        const lastActivity = row.getValue('last_activity') as string | null
        return (
          <span className="text-sm text-gray-600">
            {lastActivity ? new Date(lastActivity).toLocaleString() : '-'}
          </span>
        )
      },
    },
    {
      accessorKey: 'created_at',
      header: () => {
        const isActive = sortBy === 'created_at'
        return (
          <div
            className="flex items-center gap-1 cursor-pointer hover:text-primary"
            onClick={() => {
              if (isActive) {
                setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
              } else {
                setSortBy('created_at')
                setSortOrder('desc')
              }
            }}
          >
            {t('common.createdAt')}
            {isActive && (
              <span className="text-xs">{sortOrder === 'desc' ? '↓' : '↑'}</span>
            )}
          </div>
        )
      },
      cell: ({ row }) => {
        const date = row.getValue('created_at') as string
        return <span className="text-sm text-gray-600">{new Date(date).toLocaleString()}</span>
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
              title={t('admin.editTenant')}
            >
              <Edit className="h-4 w-4" />
            </Button>
            {record.id !== currentUser?.id && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(record.id)}
                title={t('admin.deleteTenant')}
              >
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            )}
          </div>
        )
      },
    },
  ]

  const filteredUsers = users.filter(
    (user) =>
      !searchText ||
      user.email.toLowerCase().includes(searchText.toLowerCase()) ||
      user.id.toLowerCase().includes(searchText.toLowerCase())
  )

  const getCreationTrendOption = () => {
    if (!tenantAnalytics) return {}

    const dates = tenantAnalytics.creation_trend.map((item) => item.date)
    const counts = tenantAnalytics.creation_trend.map((item) => item.count)

    return {
      title: {
        text: t('admin.tenantCreationTrend'),
        left: 'center',
      },
      tooltip: {
        trigger: 'axis',
      },
      xAxis: {
        type: 'category',
        data: dates,
      },
      yAxis: {
        type: 'value',
      },
      series: [
        {
          name: t('admin.newTenants'),
          type: 'line',
          data: counts,
          itemStyle: { color: '#1890ff' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(24, 144, 255, 0.3)' },
                { offset: 1, color: 'rgba(24, 144, 255, 0.1)' },
              ],
            },
          },
        },
      ],
    }
  }

  const getUsageTrendOption = () => {
    if (!tenantAnalytics) return {}

    const dates = tenantAnalytics.usage_trend.map((item) => item.date)
    const counts = tenantAnalytics.usage_trend.map((item) => item.count)

    return {
      title: {
        text: t('admin.tenantUsageTrend'),
        left: 'center',
      },
      tooltip: {
        trigger: 'axis',
      },
      xAxis: {
        type: 'category',
        data: dates,
      },
      yAxis: {
        type: 'value',
      },
      series: [
        {
          name: t('admin.detections'),
          type: 'line',
          data: counts,
          itemStyle: { color: '#52c41a' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(82, 196, 26, 0.3)' },
                { offset: 1, color: 'rgba(82, 196, 26, 0.1)' },
              ],
            },
          },
        },
      ],
    }
  }

  return (
    <div className="space-y-6">
      {/* Analytics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Latest Created Tenants */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              {t('admin.latestCreatedTenants')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {analyticsLoading ? (
              <div className="flex items-center justify-center h-48">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              </div>
            ) : tenantAnalytics?.latest_created_tenants.length ? (
              <div className="space-y-3">
                {tenantAnalytics.latest_created_tenants.slice(0, 5).map((tenant) => (
                  <div
                    key={tenant.id}
                    className="flex items-center justify-between p-2 border rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex-1">
                      <div className="font-medium">{tenant.email}</div>
                      <div className="text-sm text-gray-500">
                        {tenant.created_at
                          ? new Date(tenant.created_at).toLocaleString()
                          : '-'}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Badge variant={tenant.is_active ? 'default' : 'destructive'}>
                        {tenant.is_active ? t('admin.active') : t('admin.inactive')}
                      </Badge>
                      <Badge variant={tenant.is_verified ? 'default' : 'secondary'}>
                        {tenant.is_verified ? t('admin.verified') : t('admin.unverified')}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-gray-500 py-8">{t('admin.noData')}</div>
            )}
          </CardContent>
        </Card>

        {/* Recently Active Tenants */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t('admin.recentlyActiveTenants')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {analyticsLoading ? (
              <div className="flex items-center justify-center h-48">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              </div>
            ) : tenantAnalytics?.recently_active_tenants.length ? (
              <div className="space-y-3">
                {tenantAnalytics.recently_active_tenants.slice(0, 5).map((tenant) => (
                  <div
                    key={tenant.id}
                    className="flex items-center justify-between p-2 border rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex-1">
                      <div className="font-medium">{tenant.email}</div>
                      <div className="text-sm text-gray-500">
                        {t('admin.lastActivity')}:{' '}
                        {tenant.last_activity
                          ? new Date(tenant.last_activity).toLocaleString()
                          : '-'}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Badge variant={tenant.is_active ? 'default' : 'destructive'}>
                        {tenant.is_active ? t('admin.active') : t('admin.inactive')}
                      </Badge>
                      <Badge variant={tenant.is_verified ? 'default' : 'secondary'}>
                        {tenant.is_verified ? t('admin.verified') : t('admin.unverified')}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-gray-500 py-8">{t('admin.noData')}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trend Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardContent className="pt-6">
            {analyticsLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              </div>
            ) : (
              <ReactECharts option={getCreationTrendOption()} style={{ height: 300 }} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {analyticsLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              </div>
            ) : (
              <ReactECharts option={getUsageTrendOption()} style={{ height: 300 }} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tenant List */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div className="space-y-2">
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                {t('admin.tenantManagement')}
              </CardTitle>
              <p className="text-sm text-gray-600">{t('admin.manageTenants')}</p>
              {adminStats && (
                <div className="flex gap-4 text-sm">
                  <span>
                    <strong>{adminStats.total_users}</strong> {t('admin.totalTenants')}
                  </span>
                  <span className="text-gray-400">|</span>
                  <span>
                    {t('admin.totalDetections')}: <strong>{adminStats.total_detections}</strong>
                  </span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={loadData} disabled={loading}>
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('common.refresh')}
              </Button>
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" />
                {t('admin.addTenant')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Search box */}
          <div className="mb-4">
            <Input
              placeholder={t('admin.searchTenantPlaceholder')}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="max-w-xs"
            />
          </div>

          <DataTable 
            columns={columns} 
            data={filteredUsers} 
            loading={loading}
            pageCount={Math.ceil(total / pageSize)}
            currentPage={currentPage}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        </CardContent>
      </Card>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingUser ? t('admin.editTenantTitle') : t('admin.addTenantTitle')}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin.tenantEmailLabel')}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <Input
                          {...field}
                          placeholder={t('admin.tenantEmailPlaceholder')}
                          disabled={!!editingUser}
                          className="pl-10"
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {!editingUser && (
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('admin.initialPassword')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="password"
                          placeholder={t('admin.initialPasswordPlaceholder')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between border rounded-lg p-3">
                    <div>
                      <FormLabel>{t('admin.accountStatus')}</FormLabel>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="is_verified"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between border rounded-lg p-3">
                    <div>
                      <FormLabel>{t('admin.emailVerification')}</FormLabel>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              {editingUser && (
                <>
                  <div className="flex items-center justify-between border rounded-lg p-3 bg-gray-50">
                    <FormLabel>{t('admin.superAdmin')}</FormLabel>
                    <Switch checked={!!editingUser?.is_super_admin} disabled />
                  </div>
                  <div className="border rounded-lg p-3 bg-gray-50">
                    <FormLabel className="mb-2 block">{t('admin.apiKey')}</FormLabel>
                    <div className="flex items-center gap-2">
                      <code 
                        className="flex-1 min-w-0 text-xs bg-white px-3 py-2 rounded border overflow-hidden text-ellipsis whitespace-nowrap"
                        title={editingUser.api_key || t('admin.notGenerated')}
                      >
                        {editingUser.api_key 
                          ? (editingUser.api_key.length > 20
                              ? `${editingUser.api_key.substring(0, 12)}...${editingUser.api_key.substring(editingUser.api_key.length - 8)}`
                              : editingUser.api_key)
                          : t('admin.notGenerated')}
                      </code>
                      {editingUser.api_key && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(editingUser.api_key)}
                            title={t('common.copy')}
                            className="flex-shrink-0"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleResetApiKey(editingUser.id)}
                            title={t('admin.resetApiKey')}
                            className="flex-shrink-0"
                          >
                            <Key className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </>
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
    </div>
  )
}

export default UserManagement
