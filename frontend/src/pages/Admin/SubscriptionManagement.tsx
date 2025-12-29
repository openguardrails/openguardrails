import React, { useEffect, useState } from 'react'
import { RefreshCw, Edit, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/lib/confirm-dialog'
import { billingService } from '../../services/billing'
import type { SubscriptionListItem } from '../../types/billing'
import type { ColumnDef } from '@tanstack/react-table'

const SubscriptionManagement: React.FC = () => {
  const { t } = useTranslation()
  const [subscriptions, setSubscriptions] = useState<SubscriptionListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'free' | 'subscribed' | undefined>(undefined)
  const [sortBy, setSortBy] = useState<'current_month_usage' | 'usage_reset_at'>(
    'current_month_usage'
  )
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [selectedSubscription, setSelectedSubscription] = useState<SubscriptionListItem | null>(
    null
  )
  const [newSubscriptionType, setNewSubscriptionType] = useState<'free' | 'subscribed'>('free')

  const fetchSubscriptions = async () => {
    try {
      setLoading(true)
      const { data, total: totalCount } = await billingService.listAllSubscriptions({
        skip: (currentPage - 1) * pageSize,
        limit: pageSize,
        search: search || undefined,
        subscription_type: filterType,
        sort_by: sortBy,
        sort_order: sortOrder,
      })
      setSubscriptions(data)
      setTotal(totalCount)
    } catch (error: any) {
      toast.error(error.message || t('admin.subscriptions.fetchFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSubscriptions()
  }, [currentPage, pageSize, search, filterType, sortBy, sortOrder])

  const handleEditSubscription = (subscription: SubscriptionListItem) => {
    setSelectedSubscription(subscription)
    setNewSubscriptionType(subscription.subscription_type)
    setEditModalVisible(true)
  }

  const handleUpdateSubscription = async () => {
    if (!selectedSubscription) return

    try {
      await billingService.updateSubscription(selectedSubscription.tenant_id, {
        subscription_type: newSubscriptionType,
      })
      toast.success(t('admin.subscriptions.updateSuccess'))
      setEditModalVisible(false)
      fetchSubscriptions()
    } catch (error: any) {
      toast.error(error.message || t('admin.subscriptions.updateFailed'))
    }
  }

  const handleResetQuota = async (tenantId: string) => {
    const confirmed = await confirmDialog({
      title: t('admin.subscriptions.resetConfirm'),
      description: t('admin.subscriptions.resetWarning'),
    })

    if (!confirmed) return

    try {
      await billingService.resetTenantQuota(tenantId)
      toast.success(t('admin.subscriptions.resetSuccess'))
      fetchSubscriptions()
    } catch (error: any) {
      toast.error(error.message || t('admin.subscriptions.resetFailed'))
    }
  }

  const columns: ColumnDef<SubscriptionListItem>[] = [
    {
      accessorKey: 'email',
      header: t('admin.subscriptions.email'),
      size: 250,
    },
    {
      accessorKey: 'subscription_type',
      header: t('admin.subscriptions.plan'),
      size: 150,
      cell: ({ row }) => {
        const type = row.getValue('subscription_type') as string
        const record = row.original
        return (
          <Badge variant={type === 'subscribed' ? 'default' : 'outline'}>
            {record.plan_name}
          </Badge>
        )
      },
    },
    {
      id: 'usage',
      header: t('admin.subscriptions.usage'),
      size: 300,
      cell: ({ row }) => {
        const record = row.original
        const percentage = Math.min(record.usage_percentage, 100)
        return (
          <div className="space-y-2">
            <div className="text-sm">
              {record.current_month_usage.toLocaleString()} /{' '}
              {record.monthly_quota.toLocaleString()} ({record.usage_percentage.toFixed(1)}%)
            </div>
            <Progress
              value={percentage}
              className={`h-2 ${record.usage_percentage >= 90 ? '[&>div]:bg-red-500' : '[&>div]:bg-blue-500'}`}
            />
          </div>
        )
      },
    },
    {
      accessorKey: 'usage_reset_at',
      header: t('admin.subscriptions.resetDate'),
      size: 150,
      cell: ({ row }) => {
        const date = row.getValue('usage_reset_at') as string
        return <span className="text-sm">{new Date(date).toLocaleDateString()}</span>
      },
    },
    {
      id: 'actions',
      header: t('common.actions'),
      size: 180,
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleEditSubscription(record)}>
              <Edit className="mr-2 h-4 w-4" />
              {t('common.edit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleResetQuota(record.tenant_id)}
              className="text-red-600 hover:text-red-700"
            >
              <RotateCw className="mr-2 h-4 w-4" />
              {t('admin.subscriptions.reset')}
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>{t('admin.subscriptions.title')}</CardTitle>
          <Button variant="outline" onClick={fetchSubscriptions} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex gap-4">
            <Input
              placeholder={t('admin.subscriptions.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <Select value={filterType} onValueChange={(value) => setFilterType(value as any)}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder={t('admin.subscriptions.filterByType')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">{t('admin.subscriptions.freePlan')}</SelectItem>
                <SelectItem value="subscribed">
                  {t('admin.subscriptions.subscribedPlan')}
                </SelectItem>
              </SelectContent>
            </Select>
            {(search || filterType) && (
              <Button
                variant="outline"
                onClick={() => {
                  setSearch('')
                  setFilterType(undefined)
                }}
              >
                {t('common.reset')}
              </Button>
            )}
          </div>

          <DataTable columns={columns} data={subscriptions} loading={loading} />
        </div>
      </CardContent>

      <Dialog open={editModalVisible} onOpenChange={setEditModalVisible}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('admin.subscriptions.editSubscription')}</DialogTitle>
          </DialogHeader>

          {selectedSubscription && (
            <div className="space-y-4">
              <div>
                <span className="font-semibold">{t('admin.subscriptions.tenant')}:</span>{' '}
                {selectedSubscription.email}
              </div>
              <div>
                <span className="font-semibold">{t('admin.subscriptions.currentPlan')}:</span>{' '}
                <Badge
                  variant={
                    selectedSubscription.subscription_type === 'subscribed' ? 'default' : 'outline'
                  }
                >
                  {selectedSubscription.plan_name}
                </Badge>
              </div>
              <div className="space-y-2">
                <label className="font-semibold">{t('admin.subscriptions.newPlan')}:</label>
                <Select value={newSubscriptionType} onValueChange={setNewSubscriptionType as any}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">
                      {t('admin.subscriptions.freePlan')} (10,000 {t('account.calls')}/month)
                    </SelectItem>
                    <SelectItem value="subscribed">
                      {t('admin.subscriptions.subscribedPlan')} (1,000,000 {t('account.calls')}
                      /month)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalVisible(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUpdateSubscription}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default SubscriptionManagement
