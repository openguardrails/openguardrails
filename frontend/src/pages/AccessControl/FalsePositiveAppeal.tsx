import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Settings2, ChevronDown, ChevronUp, Download } from 'lucide-react'

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
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { configApi, resultsApi } from '../../services/api'
import { translateRiskLevel } from '../../utils/i18nMapper'
import type { DetectionResult } from '../../types'
import { useApplication } from '../../contexts/ApplicationContext'
import { useAuth } from '../../contexts/AuthContext'
import type { ColumnDef } from '@tanstack/react-table'

const appealConfigSchema = z.object({
  enabled: z.boolean(),
  message_template: z.string().min(1),
  appeal_base_url: z.string(),
  final_reviewer_email: z.string().email().optional().or(z.literal('')),
})

type AppealConfigFormData = z.infer<typeof appealConfigSchema>

interface AppealConfig {
  id?: string
  enabled: boolean
  message_template: string
  appeal_base_url: string
  final_reviewer_email?: string
  created_at?: string
  updated_at?: string
}

interface AppealRecord {
  id: string
  request_id: string
  user_id?: string
  application_id?: string
  application_name?: string
  original_content: string
  original_risk_level: string
  original_categories: string[]
  status: string
  ai_approved?: boolean
  ai_review_result?: string
  processor_type?: string
  processor_id?: string
  processor_reason?: string
  created_at?: string
  ai_reviewed_at?: string
  processed_at?: string
}

const FalsePositiveAppeal: React.FC = () => {
  const { t } = useTranslation()
  const [appealConfig, setAppealConfig] = useState<AppealConfig | null>(null)
  const [appealRecords, setAppealRecords] = useState<AppealRecord[]>([])
  const [appealRecordsTotal, setAppealRecordsTotal] = useState(0)
  const [appealRecordsPage, setAppealRecordsPage] = useState(1)
  const [appealRecordsPageSize] = useState(10)
  const [appealRecordsLoading, setAppealRecordsLoading] = useState(false)
  const [appealStatusFilter, setAppealStatusFilter] = useState<string>('all')
  const [appealLoading, setAppealLoading] = useState(false)
  const [configExpanded, setConfigExpanded] = useState(false)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [selectedResult, setSelectedResult] = useState<DetectionResult | null>(null)
  const [selectedAppeal, setSelectedAppeal] = useState<AppealRecord | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [exportLoading, setExportLoading] = useState(false)
  const { currentApplicationId } = useApplication()
  const { user, onUserSwitch } = useAuth()

  const appealForm = useForm<AppealConfigFormData>({
    resolver: zodResolver(appealConfigSchema),
    defaultValues: {
      enabled: false,
      message_template: t('appealConfig.templatePlaceholder'),
      appeal_base_url: '',
      final_reviewer_email: user?.email || '',
    },
  })

  const fetchAppealConfig = async () => {
    try {
      setAppealLoading(true)
      const config = await configApi.appealConfig.get()
      setAppealConfig(config)
      appealForm.reset({
        enabled: config.enabled,
        message_template: config.message_template,
        appeal_base_url: config.appeal_base_url,
        // Use current user's email as default if not set
        final_reviewer_email: config.final_reviewer_email || user?.email || '',
      })
    } catch (error: any) {
      // If no config exists, set default with user's email
      appealForm.reset({
        enabled: false,
        message_template: t('appealConfig.templatePlaceholder'),
        appeal_base_url: '',
        final_reviewer_email: user?.email || '',
      })
    } finally {
      setAppealLoading(false)
    }
  }

  const fetchAppealRecords = async (page = 1, status = 'all') => {
    try {
      setAppealRecordsLoading(true)
      const params: { page: number; page_size: number; status?: string } = {
        page,
        page_size: appealRecordsPageSize,
      }
      if (status && status !== 'all') {
        params.status = status
      }
      const response = await configApi.appealConfig.getRecords(params)
      setAppealRecords(response.items)
      setAppealRecordsTotal(response.total)
      setAppealRecordsPage(response.page)
    } catch (error: any) {
      toast.error(t('appealConfig.fetchRecordsFailed'))
    } finally {
      setAppealRecordsLoading(false)
    }
  }

  const handleReviewAppeal = async (appealId: string, action: 'approve' | 'reject') => {
    try {
      await configApi.appealConfig.reviewAppeal(appealId, { action })
      toast.success(t('appealConfig.reviewSuccess'))
      fetchAppealRecords(appealRecordsPage, appealStatusFilter)
    } catch (error: any) {
      toast.error(t('appealConfig.reviewFailed'))
    }
  }

  const handleExportRecords = async () => {
    try {
      setExportLoading(true)
      const params: { status?: string } = {}
      if (appealStatusFilter && appealStatusFilter !== 'all') {
        params.status = appealStatusFilter
      }
      const blob = await configApi.appealConfig.exportRecords(params)
      // Create download link
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `appeal_records_${new Date().toISOString().slice(0, 10)}.xlsx`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
      toast.success(t('results.exportSuccess'))
    } catch (error: any) {
      console.error('Export failed:', error)
      toast.error(t('results.exportFailed'))
    } finally {
      setExportLoading(false)
    }
  }

  useEffect(() => {
    if (currentApplicationId) {
      fetchAppealConfig()
      fetchAppealRecords(1, appealStatusFilter)
    }
  }, [currentApplicationId])

  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchAppealConfig()
      fetchAppealRecords(1, appealStatusFilter)
    })
    return unsubscribe
  }, [onUserSwitch])

  useEffect(() => {
    if (currentApplicationId) {
      fetchAppealRecords(1, appealStatusFilter)
    }
  }, [appealStatusFilter])

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

  const handleSaveAppealConfig = async (values: AppealConfigFormData) => {
    try {
      setAppealLoading(true)
      await configApi.appealConfig.update(values)
      toast.success(t('appealConfig.saveSuccess'))
      fetchAppealConfig()
      setConfigExpanded(false)
    } catch (error: any) {
      toast.error(t('appealConfig.saveFailed'))
    } finally {
      setAppealLoading(false)
    }
  }

  const getAppealStatusText = (status: string): string => {
    const statusMap: Record<string, string> = {
      pending: t('appealConfig.statusPending'),
      reviewing: t('appealConfig.statusReviewing'),
      pending_review: t('appealConfig.statusPendingReview'),
      approved: t('appealConfig.statusApproved'),
      rejected: t('appealConfig.statusRejected'),
    }
    return statusMap[status] || status
  }

  const getAppealStatusVariant = (status: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (status === 'approved') return 'default'
    if (status === 'rejected') return 'destructive'
    if (status === 'pending_review') return 'secondary'
    return 'outline'
  }

  const getProcessorText = (record: AppealRecord): string => {
    if (record.processor_type === 'agent') {
      return t('appealConfig.processorTypeAgent')
    }
    if (record.processor_type === 'human' && record.processor_id) {
      const emailPrefix = record.processor_id.split('@')[0]
      return `${t('appealConfig.processorTypeHuman')} (${emailPrefix})`
    }
    return '-'
  }

  // Risk badge styling helpers
  const getRiskBadgeClasses = (level: string): string => {
    if (level === 'high_risk' || level === '高风险') {
      return '!bg-red-100 !text-red-800 !border-red-200'
    }
    if (level === 'medium_risk' || level === '中风险') {
      return '!bg-orange-100 !text-orange-800 !border-orange-200'
    }
    if (level === 'low_risk' || level === '低风险') {
      return '!bg-yellow-100 !text-yellow-800 !border-yellow-200'
    }
    return '!bg-gray-100 !text-gray-800 !border-gray-200'
  }

  const getActionBadgeClasses = (action: string): string => {
    const passText = t('action.pass')
    const rejectText = t('action.reject')
    const replaceText = t('action.replace')
    if (action === 'pass' || action === passText) {
      return '!bg-green-100 !text-green-800 !border-green-200'
    }
    if (action === 'reject' || action === rejectText) {
      return '!bg-red-100 !text-red-800 !border-red-200'
    }
    if (action === 'replace' || action === replaceText) {
      return '!bg-orange-100 !text-orange-800 !border-orange-200'
    }
    return '!bg-gray-100 !text-gray-800 !border-gray-200'
  }

  const formatRiskDisplay = (riskLevel: string, categories: string[]) => {
    const translatedRiskLevel = translateRiskLevel(riskLevel, t)
    if (categories && categories.length > 0) {
      return `${translatedRiskLevel} ${categories[0]}`
    }
    return translatedRiskLevel
  }

  // Show combined appeal and detection result detail drawer
  const showDetail = async (appeal: AppealRecord) => {
    setDetailLoading(true)
    setDrawerVisible(true)
    setSelectedAppeal(appeal)
    try {
      // Search for detection result by request_id
      const result = await resultsApi.getResults({
        request_id_search: appeal.request_id,
        per_page: 1,
      })
      if (result.items && result.items.length > 0) {
        setSelectedResult(result.items[0])
      } else {
        setSelectedResult(null)
      }
    } catch (error) {
      console.error('Failed to fetch detection result:', error)
      setSelectedResult(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const appealRecordsColumns: ColumnDef<AppealRecord>[] = [
    {
      accessorKey: 'request_id',
      header: t('appealConfig.requestIdColumn'),
      size: 80,
      cell: ({ row }) => {
        const requestId = row.getValue('request_id') as string
        return (
          <button
            onClick={() => showDetail(row.original)}
            className="text-primary hover:underline cursor-pointer text-xs"
          >
            ...{requestId.slice(-8)}
          </button>
        )
      },
    },
    {
      accessorKey: 'application_name',
      header: t('appealConfig.applicationColumn'),
      size: 100,
      cell: ({ row }) => <span className="text-xs">{row.getValue('application_name') || '-'}</span>,
    },
    {
      accessorKey: 'user_id',
      header: t('appealConfig.appealUserColumn'),
      size: 100,
      cell: ({ row }) => <span className="text-xs truncate max-w-[100px] block">{row.getValue('user_id') || '-'}</span>,
    },
    {
      accessorKey: 'processor',
      header: t('appealConfig.processorColumn'),
      size: 100,
      cell: ({ row }) => <span className="text-xs">{getProcessorText(row.original)}</span>,
    },
    {
      accessorKey: 'status',
      header: t('appealConfig.decisionColumn'),
      size: 80,
      cell: ({ row }) => {
        const status = row.getValue('status') as string
        return (
          <Badge variant={getAppealStatusVariant(status)} className="text-xs">
            {getAppealStatusText(status)}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'reason',
      header: t('appealConfig.reasonColumn'),
      size: 150,
      cell: ({ row }) => {
        const record = row.original
        const reason = record.processor_reason || record.ai_review_result || '-'
        return (
          <span className="truncate max-w-[150px] block text-xs" title={reason}>
            {reason.length > 30 ? reason.slice(0, 30) + '...' : reason}
          </span>
        )
      },
    },
    {
      accessorKey: 'created_at',
      header: t('appealConfig.appealTimeColumn'),
      size: 90,
      cell: ({ row }) => {
        const value = row.getValue('created_at') as string
        return value ? <span className="text-xs">{format(new Date(value), 'MM-dd HH:mm')}</span> : '-'
      },
    },
    {
      accessorKey: 'processed_at',
      header: t('appealConfig.processTimeColumn'),
      size: 90,
      cell: ({ row }) => {
        const record = row.original
        const time = record.processed_at || record.ai_reviewed_at
        return time ? <span className="text-xs">{format(new Date(time), 'MM-dd HH:mm')}</span> : '-'
      },
    },
    {
      id: 'actions',
      header: t('appealConfig.actionColumn'),
      size: 200,
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => showDetail(record)}
            >
              {t('appealConfig.detailButton')}
            </Button>
            {record.status === 'pending_review' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => handleReviewAppeal(record.id, 'approve')}
                >
                  {t('appealConfig.approveAction')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => handleReviewAppeal(record.id, 'reject')}
                >
                  {t('appealConfig.rejectAction')}
                </Button>
              </>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="h-full flex flex-col gap-4 overflow-hidden">
      <h2 className="text-2xl font-bold tracking-tight flex-shrink-0">{t('appealConfig.pageTitle')}</h2>

      {/* Compact Config Section */}
      <Collapsible open={configExpanded} onOpenChange={setConfigExpanded} className="flex-shrink-0">
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Settings2 className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle className="text-base">{t('appealConfig.title')}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {appealConfig?.enabled ? t('common.enabled') : t('common.disabled')}
                      {appealConfig?.final_reviewer_email && ` - ${t('appealConfig.finalReviewerEmailLabel')}: ${appealConfig.final_reviewer_email}`}
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
            <CardContent className="pt-0">
              <Form {...appealForm}>
                <form onSubmit={appealForm.handleSubmit(handleSaveAppealConfig)} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={appealForm.control}
                      name="enabled"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between rounded-lg border p-3">
                          <div className="space-y-0.5">
                            <FormLabel className="text-sm">
                              {t('appealConfig.enableLabel')}
                            </FormLabel>
                            <FormDescription className="text-xs">{t('appealConfig.enableDesc')}</FormDescription>
                          </div>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={appealForm.control}
                      name="final_reviewer_email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('appealConfig.finalReviewerEmailLabel')}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type="email"
                              placeholder="reviewer@example.com"
                              className="h-9"
                            />
                          </FormControl>
                          <FormDescription className="text-xs">{t('appealConfig.finalReviewerEmailDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={appealForm.control}
                      name="appeal_base_url"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('appealConfig.baseUrlLabel')}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder="https://guardrails.example.com"
                              className="h-9"
                            />
                          </FormControl>
                          <FormDescription className="text-xs">{t('appealConfig.baseUrlDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={appealForm.control}
                      name="message_template"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">{t('appealConfig.templateLabel')}</FormLabel>
                          <FormControl>
                            <Textarea
                              {...field}
                              placeholder={t('appealConfig.templatePlaceholder')}
                              rows={2}
                              className="resize-none"
                            />
                          </FormControl>
                          <FormDescription className="text-xs">{t('appealConfig.templateDesc')}</FormDescription>
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="flex justify-end">
                    <Button type="submit" disabled={appealLoading} size="sm">
                      {t('appealConfig.saveConfig')}
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Appeal Records - Main Content */}
      <Card className="flex-1 flex flex-col overflow-hidden min-h-0">
        <CardHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle>{t('appealConfig.recordsTitle')}</CardTitle>
            <div className="flex items-center gap-2">
              <Select
                value={appealStatusFilter}
                onValueChange={(value) => setAppealStatusFilter(value)}
              >
                <SelectTrigger className="w-[150px] h-8 text-xs">
                  <SelectValue placeholder={t('appealConfig.filterByStatus')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('appealConfig.allStatuses')}</SelectItem>
                  <SelectItem value="pending">{t('appealConfig.statusPending')}</SelectItem>
                  <SelectItem value="pending_review">{t('appealConfig.statusPendingReview')}</SelectItem>
                  <SelectItem value="approved">{t('appealConfig.statusApproved')}</SelectItem>
                  <SelectItem value="rejected">{t('appealConfig.statusRejected')}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={handleExportRecords}
                disabled={exportLoading}
              >
                <Download className="h-3 w-3 mr-1" />
                {exportLoading ? t('common.loading') : t('common.export')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 overflow-hidden flex flex-col">
          <DataTable
            columns={appealRecordsColumns}
            data={appealRecords}
            loading={appealRecordsLoading}
            pageSize={appealRecordsPageSize}
            pageCount={Math.ceil(appealRecordsTotal / appealRecordsPageSize)}
            currentPage={appealRecordsPage}
            onPageChange={(page) => fetchAppealRecords(page, appealStatusFilter)}
            stickyLastColumn
            fillHeight={true}
          />
        </CardContent>
      </Card>

      {/* Appeal and Detection Detail Drawer */}
      <Sheet open={drawerVisible} onOpenChange={setDrawerVisible}>
        <SheetContent className="w-[800px] max-w-[80vw] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('appealConfig.appealDetailTitle')}</SheetTitle>
          </SheetHeader>

          {detailLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              <div className="mt-4">{t('results.loadingDetails')}</div>
            </div>
          ) : selectedAppeal ? (
            <div className="space-y-6 mt-6">
              {/* Appeal Information Section */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold border-b pb-2">{t('appealConfig.appealInfo')}</h3>

                {/* Request ID */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('results.requestId')}:</div>
                  <div className="col-span-2">
                    <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                      {selectedAppeal.request_id}
                    </code>
                  </div>
                </div>

                {/* Appeal User */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('appealConfig.appealUserColumn')}:</div>
                  <div className="col-span-2 text-sm">
                    {selectedAppeal.user_id || t('appealConfig.anonymous')}
                  </div>
                </div>

                {/* Application */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('appealConfig.applicationColumn')}:</div>
                  <div className="col-span-2 text-sm">
                    {selectedAppeal.application_name || '-'}
                  </div>
                </div>

                {/* Appeal Status */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('appealConfig.appealStatus')}:</div>
                  <div className="col-span-2">
                    <Badge variant={getAppealStatusVariant(selectedAppeal.status)}>
                      {getAppealStatusText(selectedAppeal.status)}
                    </Badge>
                  </div>
                </div>

                {/* Original Risk Level */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('appealConfig.originalRiskLevel')}:</div>
                  <div className="col-span-2">
                    <Badge className={getRiskBadgeClasses(selectedAppeal.original_risk_level)}>
                      {translateRiskLevel(selectedAppeal.original_risk_level, t)}
                    </Badge>
                  </div>
                </div>

                {/* Original Categories */}
                {selectedAppeal.original_categories && selectedAppeal.original_categories.length > 0 && (
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('appealConfig.originalCategories')}:</div>
                    <div className="col-span-2">
                      {selectedAppeal.original_categories.map((cat, idx) => (
                        <Badge key={idx} variant="outline" className="mr-1 mb-1 text-xs">
                          {cat}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Review Result */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('appealConfig.aiReviewResult')}:</div>
                  <div className="col-span-2">
                    {selectedAppeal.ai_approved !== undefined && selectedAppeal.ai_approved !== null ? (
                      <Badge variant={selectedAppeal.ai_approved ? 'default' : 'destructive'}>
                        {selectedAppeal.ai_approved ? t('appealConfig.aiApproved') : t('appealConfig.aiRejected')}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                </div>

                {/* AI Review Reason */}
                {selectedAppeal.ai_review_result && (
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('appealConfig.reasonColumn')}:</div>
                    <div className="col-span-2 text-sm whitespace-pre-wrap">
                      {selectedAppeal.ai_review_result}
                    </div>
                  </div>
                )}

                {/* Processor Info */}
                {selectedAppeal.processor_type && (
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('appealConfig.processorInfo')}:</div>
                    <div className="col-span-2 text-sm">
                      {getProcessorText(selectedAppeal)}
                      {selectedAppeal.processor_reason && (
                        <div className="mt-1 text-muted-foreground">
                          {selectedAppeal.processor_reason}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Appeal Time */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('appealConfig.appealTime')}:</div>
                  <div className="col-span-2 text-sm">
                    {selectedAppeal.created_at ? format(new Date(selectedAppeal.created_at), 'yyyy-MM-dd HH:mm:ss') : '-'}
                  </div>
                </div>

                {/* Process Time */}
                {(selectedAppeal.processed_at || selectedAppeal.ai_reviewed_at) && (
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('appealConfig.processTime')}:</div>
                    <div className="col-span-2 text-sm">
                      {format(new Date(selectedAppeal.processed_at || selectedAppeal.ai_reviewed_at!), 'yyyy-MM-dd HH:mm:ss')}
                    </div>
                  </div>
                )}

                {/* Original Content */}
                <div>
                  <div className="font-medium text-gray-600 mb-3 text-sm">{t('appealConfig.originalContent')}:</div>
                  <div className="mt-2 p-4 bg-gray-50 rounded-md">
                    <p className="whitespace-pre-wrap text-sm">{selectedAppeal.original_content}</p>
                  </div>
                </div>
              </div>

              {/* Detection Result Section */}
              {selectedResult && (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold border-b pb-2">{t('appealConfig.detectionDetailTitle')}</h3>

                  {/* Prompt Attack */}
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('results.promptAttack')}:</div>
                    <div className="col-span-2">
                      <Badge className={getRiskBadgeClasses(selectedResult.security_risk_level || 'no_risk')}>
                        {formatRiskDisplay(
                          selectedResult.security_risk_level || t('risk.level.no_risk'),
                          selectedResult.security_categories || []
                        )}
                      </Badge>
                    </div>
                  </div>

                  {/* Content Compliance */}
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">
                      {t('results.contentCompliance')}:
                    </div>
                    <div className="col-span-2">
                      <Badge className={getRiskBadgeClasses(selectedResult.compliance_risk_level || 'no_risk')}>
                        {formatRiskDisplay(
                          selectedResult.compliance_risk_level || t('risk.level.no_risk'),
                          selectedResult.compliance_categories || []
                        )}
                      </Badge>
                    </div>
                  </div>

                  {/* Data Leak */}
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('results.dataLeak')}:</div>
                    <div className="col-span-2">
                      <Badge className={getRiskBadgeClasses(selectedResult.data_risk_level || 'no_risk')}>
                        {formatRiskDisplay(
                          selectedResult.data_risk_level || t('risk.level.no_risk'),
                          selectedResult.data_categories || []
                        )}
                      </Badge>
                    </div>
                  </div>

                  {/* Suggested Action */}
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('results.suggestedAction')}:</div>
                    <div className="col-span-2">
                      <Badge className={getActionBadgeClasses(selectedResult.suggest_action || '')}>
                        {selectedResult.suggest_action || '-'}
                      </Badge>
                    </div>
                  </div>

                  {/* Detection Time */}
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('results.detectionTime')}:</div>
                    <div className="col-span-2 text-sm">
                      {format(new Date(selectedResult.created_at), 'yyyy-MM-dd HH:mm:ss')}
                    </div>
                  </div>

                  {/* Suggested Answer */}
                  {selectedResult.suggest_answer && (
                    <div>
                      <div className="font-medium text-gray-600 mb-3 text-sm">
                        {t('results.suggestedAnswer')}:
                      </div>
                      <div className="mt-2 p-4 bg-blue-50 rounded-md whitespace-pre-wrap text-sm">
                        {selectedResult.suggest_answer}
                      </div>
                    </div>
                  )}

                  {/* Source IP */}
                  {selectedResult.ip_address && (
                    <div className="grid grid-cols-3 gap-4 border-b pb-3">
                      <div className="font-medium text-gray-600 text-sm">{t('appealConfig.ipAddress')}:</div>
                      <div className="col-span-2">
                        <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                          {selectedResult.ip_address}
                        </code>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              {t('appealConfig.detectionResultNotFound')}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default FalsePositiveAppeal
