import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Settings2, ChevronDown, ChevronUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { InputNumber } from '@/components/ui/input-number'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { configApi } from '../../services/api'
import { translateRiskLevel, getRiskLevelColor } from '../../utils/i18nMapper'
import { useApplication } from '../../contexts/ApplicationContext'
import { useAuth } from '../../contexts/AuthContext'
import type { ColumnDef } from '@tanstack/react-table'

const banPolicySchema = z.object({
  enabled: z.boolean(),
  risk_level: z.string(),
  trigger_count: z.number().min(1).max(100),
  time_window_minutes: z.number().min(1).max(1440),
  ban_duration_minutes: z.number().min(1).max(10080),
})

type BanPolicyFormData = z.infer<typeof banPolicySchema>

interface BanPolicy {
  id: string
  tenant_id: string
  enabled: boolean
  risk_level: string
  trigger_count: number
  time_window_minutes: number
  ban_duration_minutes: number
  created_at: string
  updated_at: string
}

interface BannedUser {
  id: string
  user_id: string
  banned_at: string
  ban_until: string
  trigger_count: number
  risk_level: string
  reason: string
  is_active: boolean
  status: string
}

interface RiskTrigger {
  id: string
  detection_result_id: string | null
  risk_level: string
  triggered_at: string
}

const BanPolicyPage: React.FC = () => {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<BanPolicy | null>(null)
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([])
  const [loading, setLoading] = useState(false)
  const [tableLoading, setTableLoading] = useState(false)
  const [historyVisible, setHistoryVisible] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [userHistory, setUserHistory] = useState<RiskTrigger[]>([])
  const [configExpanded, setConfigExpanded] = useState(false)
  const { currentApplicationId } = useApplication()
  const { onUserSwitch } = useAuth()

  const form = useForm<BanPolicyFormData>({
    resolver: zodResolver(banPolicySchema),
    defaultValues: {
      enabled: false,
      risk_level: 'high_risk',
      trigger_count: 5,
      time_window_minutes: 30,
      ban_duration_minutes: 60,
    },
  })

  const getRiskLevelText = (level: string): string => {
    return translateRiskLevel(level, t)
  }

  const getStatusText = (status: string): string => {
    if (status === 'banned') return t('banPolicy.banned')
    if (status === 'unbanned') return t('banPolicy.unbanned')
    return status
  }

  const getStatusColor = (status: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (status === 'banned') return 'destructive'
    if (status === 'unbanned') return 'outline'
    return 'secondary'
  }

  const getRiskBadgeVariant = (level: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    const color = getRiskLevelColor(level)
    if (color === 'red' || color === '#ff4d4f') return 'destructive'
    if (color === 'orange' || color === '#faad14') return 'default'
    if (color === 'yellow' || color === '#fadb14') return 'secondary'
    return 'outline'
  }

  const fetchPolicy = async () => {
    try {
      setLoading(true)
      const policyData = await configApi.banPolicy.get()
      setPolicy(policyData)
      form.reset({
        enabled: policyData.enabled,
        risk_level: policyData.risk_level,
        trigger_count: policyData.trigger_count,
        time_window_minutes: policyData.time_window_minutes,
        ban_duration_minutes: policyData.ban_duration_minutes,
      })
    } catch (error: any) {
      toast.error(t('banPolicy.fetchFailed'))
    } finally {
      setLoading(false)
    }
  }

  const fetchBannedUsers = async () => {
    try {
      setTableLoading(true)
      const data = await configApi.banPolicy.getBannedUsers()
      setBannedUsers(data.users)
    } catch (error: any) {
      toast.error(t('banPolicy.getBannedUsersFailed'))
    } finally {
      setTableLoading(false)
    }
  }

  useEffect(() => {
    if (currentApplicationId) {
      fetchPolicy()
      fetchBannedUsers()
    }
  }, [currentApplicationId])

  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchPolicy()
      fetchBannedUsers()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Disable html/body scroll to prevent double scrollbars
  useEffect(() => {
    const originalHtmlOverflow = document.documentElement.style.overflow
    const originalBodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = originalHtmlOverflow
      document.body.style.overflow = originalBodyOverflow
    }
  }, [])

  const handleSave = async (values: BanPolicyFormData) => {
    try {
      setLoading(true)
      await configApi.banPolicy.update(values)
      toast.success(t('banPolicy.saveSuccess'))
      fetchPolicy()
    } catch (error: any) {
      toast.error(t('banPolicy.saveFailed'))
    } finally {
      setLoading(false)
    }
  }

  const applyTemplate = (template: string) => {
    const templates: { [key: string]: BanPolicyFormData } = {
      strict: {
        enabled: true,
        risk_level: 'high_risk',
        trigger_count: 3,
        time_window_minutes: 10,
        ban_duration_minutes: 60,
      },
      standard: {
        enabled: true,
        risk_level: 'high_risk',
        trigger_count: 5,
        time_window_minutes: 30,
        ban_duration_minutes: 30,
      },
      relaxed: {
        enabled: true,
        risk_level: 'high_risk',
        trigger_count: 10,
        time_window_minutes: 60,
        ban_duration_minutes: 15,
      },
      disabled: {
        enabled: false,
        risk_level: 'high_risk',
        trigger_count: 3,
        time_window_minutes: 10,
        ban_duration_minutes: 60,
      },
    }

    form.reset(templates[template])
  }

  const handleUnban = async (userId: string) => {
    try {
      await configApi.banPolicy.unbanUser(userId)
      toast.success(t('banPolicy.unbanSuccess'))
      fetchBannedUsers()
    } catch (error: any) {
      toast.error(t('banPolicy.unbanFailed'))
    }
  }

  const viewUserHistory = async (userId: string) => {
    try {
      setSelectedUserId(userId)
      const data = await configApi.banPolicy.getUserHistory(userId)
      setUserHistory(data.history)
      setHistoryVisible(true)
    } catch (error: any) {
      toast.error(t('banPolicy.getUserHistoryFailed'))
    }
  }

  const bannedUsersColumns: ColumnDef<BannedUser>[] = [
    {
      accessorKey: 'user_id',
      header: t('banPolicy.userIdColumn'),
    },
    {
      accessorKey: 'banned_at',
      header: t('banPolicy.banTimeColumn'),
      cell: ({ row }) => format(new Date(row.getValue('banned_at')), 'yyyy-MM-dd HH:mm:ss'),
    },
    {
      accessorKey: 'ban_until',
      header: t('banPolicy.unbanTimeColumn'),
      cell: ({ row }) => format(new Date(row.getValue('ban_until')), 'yyyy-MM-dd HH:mm:ss'),
    },
    {
      accessorKey: 'trigger_count',
      header: t('banPolicy.triggerTimesColumn'),
    },
    {
      accessorKey: 'risk_level',
      header: t('banPolicy.riskLevelColumn'),
      cell: ({ row }) => {
        const level = row.getValue('risk_level') as string
        return <Badge variant={getRiskBadgeVariant(level)}>{getRiskLevelText(level)}</Badge>
      },
    },
    {
      accessorKey: 'reason',
      header: t('banPolicy.banReasonColumn'),
      cell: ({ row }) => {
        const reason = row.getValue('reason') as string
        return (
          <span className="truncate max-w-[200px] block" title={reason}>
            {reason}
          </span>
        )
      },
    },
    {
      accessorKey: 'status',
      header: t('banPolicy.statusColumn'),
      cell: ({ row }) => {
        const status = row.getValue('status') as string
        return <Badge variant={getStatusColor(status)}>{getStatusText(status)}</Badge>
      },
    },
    {
      id: 'actions',
      header: t('banPolicy.operationColumn'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex items-center gap-2">
            {record.status === 'banned' && (
              <Button
                variant="link"
                size="sm"
                onClick={() => handleUnban(record.user_id)}
                className="h-auto p-0"
              >
                {t('banPolicy.unbanUser')}
              </Button>
            )}
            <Button
              variant="link"
              size="sm"
              onClick={() => viewUserHistory(record.user_id)}
              className="h-auto p-0"
            >
              {t('banPolicy.viewHistory')}
            </Button>
          </div>
        )
      },
    },
  ]

  const historyColumns: ColumnDef<RiskTrigger>[] = [
    {
      accessorKey: 'triggered_at',
      header: t('banPolicy.triggeredAt'),
      cell: ({ row }) => format(new Date(row.getValue('triggered_at')), 'yyyy-MM-dd HH:mm:ss'),
    },
    {
      accessorKey: 'risk_level',
      header: t('banPolicy.riskLevelColumn'),
      cell: ({ row }) => {
        const level = row.getValue('risk_level') as string
        return <Badge variant={getRiskBadgeVariant(level)}>{getRiskLevelText(level)}</Badge>
      },
    },
    {
      accessorKey: 'detection_result_id',
      header: t('banPolicy.detectionResultId'),
      cell: ({ row }) => row.getValue('detection_result_id') || '-',
    },
  ]

  return (
    <div className="h-full flex flex-col gap-4 overflow-hidden">
      <h2 className="text-2xl font-bold tracking-tight flex-shrink-0">{t('banPolicy.title')}</h2>

      {/* Compact Config Section */}
      <Collapsible open={configExpanded} onOpenChange={setConfigExpanded} className="flex-shrink-0">
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Settings2 className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle className="text-base">{t('banPolicy.configTitle')}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {policy?.enabled ? t('common.enabled') : t('common.disabled')}
                      {policy?.enabled && ` - ${getRiskLevelText(policy.risk_level)}, ${policy.trigger_count}${t('banPolicy.triggerCountUnit')}/${policy.time_window_minutes}${t('banPolicy.timeWindowUnit')}, ${t('banPolicy.banDurationLabel')} ${policy.ban_duration_minutes}${t('banPolicy.timeWindowUnit')}`}
                    </p>
                  </div>
                </div>
                {configExpanded ? (
                  <ChevronUp className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0 space-y-4">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="enabled"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between rounded-lg border p-3">
                          <div className="space-y-0.5">
                            <FormLabel className="text-sm">
                              {t('banPolicy.enableBanPolicyLabel')}
                            </FormLabel>
                            <FormDescription className="text-xs">{t('banPolicy.enableBanPolicyDesc')}</FormDescription>
                          </div>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="risk_level"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('banPolicy.triggerRiskLevelLabel')}</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="high_risk">{t('banPolicy.highRisk')}</SelectItem>
                              <SelectItem value="medium_risk">{t('banPolicy.mediumRisk')}</SelectItem>
                              <SelectItem value="low_risk">{t('banPolicy.lowRisk')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription className="text-xs">{t('banPolicy.triggerRiskLevelDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <FormField
                      control={form.control}
                      name="trigger_count"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('banPolicy.triggerCountThresholdLabel')}</FormLabel>
                          <FormControl>
                            <InputNumber
                              min={1}
                              max={100}
                              value={field.value}
                              onChange={(val) => field.onChange(val)}
                              className="h-9"
                            />
                          </FormControl>
                          <FormDescription className="text-xs">{t('banPolicy.triggerCountThresholdDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="time_window_minutes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('banPolicy.timeWindowLabel')}</FormLabel>
                          <FormControl>
                            <InputNumber
                              min={1}
                              max={1440}
                              value={field.value}
                              onChange={(val) => field.onChange(val)}
                              className="h-9"
                            />
                          </FormControl>
                          <FormDescription className="text-xs">{t('banPolicy.timeWindowMinutesDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="ban_duration_minutes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('banPolicy.banDurationLabel')}</FormLabel>
                          <FormControl>
                            <InputNumber
                              min={1}
                              max={10080}
                              value={field.value}
                              onChange={(val) => field.onChange(val)}
                              className="h-9"
                            />
                          </FormControl>
                          <FormDescription className="text-xs">{t('banPolicy.banDurationMinutesDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => applyTemplate('strict')}>
                        {t('banPolicy.strictModeTemplate')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => applyTemplate('standard')}>
                        {t('banPolicy.standardModeTemplate')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => applyTemplate('relaxed')}>
                        {t('banPolicy.lenientModeTemplate')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => applyTemplate('disabled')}>
                        {t('common.disabled')}
                      </Button>
                    </div>
                    <Button type="submit" disabled={loading} size="sm">
                      {t('banPolicy.saveConfig')}
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Banned Users List - Main Content */}
      <Card className="flex-1 flex flex-col overflow-hidden min-h-0">
        <CardHeader className="flex-shrink-0">
          <CardTitle>{t('banPolicy.bannedUsersList')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 flex-1 overflow-hidden flex flex-col">
          <DataTable
            columns={bannedUsersColumns}
            data={bannedUsers}
            loading={tableLoading}
            pageSize={10}
            fillHeight={true}
          />
        </CardContent>
      </Card>

      <Dialog open={historyVisible} onOpenChange={setHistoryVisible}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t('banPolicy.userRiskHistoryTitle')} - {selectedUserId}
            </DialogTitle>
          </DialogHeader>
          <DataTable columns={historyColumns} data={userHistory} pageSize={10} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default BanPolicyPage
