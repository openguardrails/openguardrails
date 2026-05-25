import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import {
  RefreshCw,
  Download,
  X,
  RotateCcw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { DateRangePicker } from '@/components/forms/DateRangePicker'
import { auditLogApi } from '../../services/api'
import type { ColumnDef } from '@tanstack/react-table'
import type { DateRange } from 'react-day-picker'

interface AuditLogItem {
  id: string
  user_id: string | null
  user_email: string | null
  user_nickname: string | null
  action: string
  resource_type: string
  resource_id: string | null
  resource_name: string | null
  changes: Record<string, { old: any; new: any }> | null
  ip_address: string | null
  created_at: string | null
}

interface FilterOptions {
  actions: string[]
  resource_types: string[]
  operators: { user_id: string | null; email: string }[]
}

interface AuditLogResponse {
  items: AuditLogItem[]
  total: number
  page: number
  per_page: number
  pages: number
  filter_options: FilterOptions
}

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  update: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  delete: 'bg-red-500/10 text-red-400 border-red-500/20',
  login: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  logout: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  export: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  import: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
}

const isOldNewFormat = (value: any): value is { old: any; new: any } =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && ('old' in value || 'new' in value)

const formatValue = (v: any): string =>
  v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v)

const ChangesCell: React.FC<{ changes: Record<string, any> | null }> = ({ changes }) => {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation()

  if (!changes || Object.keys(changes).length === 0) {
    return <span className="text-muted-foreground">-</span>
  }

  const entries = Object.entries(changes)

  return (
    <div className="text-xs max-w-[300px]">
      <button
        className="flex items-center gap-1 text-sky-400 hover:underline"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {t('auditLog.changesCount', { count: entries.length })}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 p-2 rounded bg-muted/50">
          {entries.map(([field, change]) => (
            <div key={field} className="break-all">
              <span className="font-medium text-foreground">{field}</span>:
              {isOldNewFormat(change) ? (
                <>
                  <span className="text-red-400 line-through ml-1">
                    {formatValue(change.old)}
                  </span>
                  <span className="mx-1">&rarr;</span>
                  <span className="text-emerald-400">
                    {formatValue(change.new)}
                  </span>
                </>
              ) : (
                <span className="text-sky-300 ml-1">{formatValue(change)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const AuditLog: React.FC = () => {
  const { t } = useTranslation()
  const [data, setData] = useState<AuditLogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({
    actions: [],
    resource_types: [],
    operators: [],
  })
  const [filters, setFilters] = useState<{
    user_id?: string
    action?: string
    resource_type?: string
    keyword?: string
  }>({})
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
  })

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true)
      const params: any = {
        page: pagination.current,
        per_page: pagination.pageSize,
      }

      if (filters.user_id) params.user_id = filters.user_id
      if (filters.action) params.action = filters.action
      if (filters.resource_type) params.resource_type = filters.resource_type
      if (filters.keyword) params.keyword = filters.keyword
      if (dateRange?.from && dateRange?.to) {
        params.start_date = format(dateRange.from, 'yyyy-MM-dd')
        params.end_date = format(dateRange.to, 'yyyy-MM-dd')
        params.tz_offset = new Date().getTimezoneOffset()
      }

      const result = await auditLogApi.getLogs(params)
      setData(result)
      if (result.filter_options) {
        setFilterOptions(result.filter_options)
      }
    } catch (error) {
      console.error('Error fetching audit logs:', error)
      toast.error(t('common.loadError'))
    } finally {
      setLoading(false)
    }
  }, [pagination.current, pagination.pageSize, filters, dateRange, t])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  const handleFilterChange = (key: string, value: any) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPagination((prev) => ({ ...prev, current: 1 }))
  }

  const handleResetFilters = () => {
    setFilters({})
    setDateRange(undefined)
    setPagination((prev) => ({ ...prev, current: 1 }))
  }

  const handleExport = useCallback(async () => {
    try {
      const loadingToast = toast.loading(t('auditLog.exporting'))

      const params: any = {}
      if (filters.user_id) params.user_id = filters.user_id
      if (filters.action) params.action = filters.action
      if (filters.resource_type) params.resource_type = filters.resource_type
      if (filters.keyword) params.keyword = filters.keyword
      if (dateRange?.from && dateRange?.to) {
        params.start_date = format(dateRange.from, 'yyyy-MM-dd')
        params.end_date = format(dateRange.to, 'yyyy-MM-dd')
        params.tz_offset = new Date().getTimezoneOffset()
      }

      const blob = await auditLogApi.exportLogs(params)
      const url = window.URL.createObjectURL(new Blob([blob]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `audit_logs_${format(new Date(), 'yyyyMMdd_HHmmss')}.csv`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)

      toast.dismiss(loadingToast)
      toast.success(t('auditLog.exportSuccess'))
    } catch (error) {
      console.error('Export failed:', error)
      toast.error(t('auditLog.exportError'))
    }
  }, [filters, dateRange, t])

  const handlePageChange = (page: number, pageSize?: number) => {
    setPagination({
      current: page,
      pageSize: pageSize || pagination.pageSize,
    })
  }

  const hasActiveFilters = () => {
    return filters.user_id || filters.action || filters.resource_type || filters.keyword || dateRange?.from
  }

  const columns: ColumnDef<AuditLogItem>[] = [
    {
      accessorKey: 'created_at',
      header: t('auditLog.time'),
      cell: ({ row }) => {
        const val = row.original.created_at
        if (!val) return '-'
        try {
          return format(new Date(val), 'yyyy-MM-dd HH:mm:ss')
        } catch {
          return val
        }
      },
    },
    {
      accessorKey: 'user_email',
      header: t('auditLog.operator'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="text-xs">
            <div className="font-medium truncate max-w-[150px]" title={record.user_email || ''}>
              {record.user_nickname || record.user_email || '-'}
            </div>
            {record.user_nickname && record.user_email && (
              <div className="text-muted-foreground truncate max-w-[150px]" title={record.user_email}>
                {record.user_email}
              </div>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'action',
      header: t('auditLog.action'),
      cell: ({ row }) => {
        const action = row.original.action
        const colorClass = ACTION_COLORS[action] || 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
        return (
          <Badge variant="outline" className={colorClass}>
            {t(`auditLog.actions.${action}`, action)}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'resource_type',
      header: t('auditLog.resourceType'),
      cell: ({ row }) => {
        const type = row.original.resource_type
        return (
          <span className="text-xs font-mono">
            {t(`auditLog.resourceTypes.${type}`, type)}
          </span>
        )
      },
    },
    {
      accessorKey: 'resource_name',
      header: t('auditLog.resourceName'),
      cell: ({ row }) => {
        const name = row.original.resource_name
        return (
          <span className="truncate max-w-[150px] block text-xs" title={name || ''}>
            {name || '-'}
          </span>
        )
      },
    },
    {
      accessorKey: 'changes',
      header: t('auditLog.changes'),
      cell: ({ row }) => <ChangesCell changes={row.original.changes} />,
    },
    {
      accessorKey: 'ip_address',
      header: t('auditLog.ipAddress'),
      cell: ({ row }) => {
        const ip = row.original.ip_address
        return <code className="text-xs">{ip || '-'}</code>
      },
    },
  ]

  return (
    <div className="flex flex-col gap-4 min-h-0 flex-1">
      <h2 className="text-3xl font-bold tracking-tight shrink-0">
        {t('auditLog.title')}
      </h2>

      {/* Filters */}
      <Card className="shrink-0">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap gap-2 items-center">
            {/* Operator Filter */}
            <div className="relative">
              <Select
                value={filters.user_id || ''}
                onValueChange={(val) => handleFilterChange('user_id', val || undefined)}
              >
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder={t('auditLog.filterOperator')} />
                </SelectTrigger>
                <SelectContent>
                  {filterOptions.operators.map((op) => (
                    <SelectItem key={op.user_id || op.email} value={op.user_id || op.email}>
                      {op.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filters.user_id && (
                <button
                  className="absolute -right-1 -top-1 rounded-full bg-destructive text-destructive-foreground w-4 h-4 flex items-center justify-center"
                  onClick={() => handleFilterChange('user_id', undefined)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Action Filter */}
            <div className="relative">
              <Select
                value={filters.action || ''}
                onValueChange={(val) => handleFilterChange('action', val || undefined)}
              >
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder={t('auditLog.filterAction')} />
                </SelectTrigger>
                <SelectContent>
                  {filterOptions.actions.map((action) => (
                    <SelectItem key={action} value={action}>
                      {t(`auditLog.actions.${action}`, action)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filters.action && (
                <button
                  className="absolute -right-1 -top-1 rounded-full bg-destructive text-destructive-foreground w-4 h-4 flex items-center justify-center"
                  onClick={() => handleFilterChange('action', undefined)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Resource Type Filter */}
            <div className="relative">
              <Select
                value={filters.resource_type || ''}
                onValueChange={(val) => handleFilterChange('resource_type', val || undefined)}
              >
                <SelectTrigger className="w-[160px] h-8 text-xs">
                  <SelectValue placeholder={t('auditLog.filterResourceType')} />
                </SelectTrigger>
                <SelectContent>
                  {filterOptions.resource_types.map((rt) => (
                    <SelectItem key={rt} value={rt}>
                      {t(`auditLog.resourceTypes.${rt}`, rt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filters.resource_type && (
                <button
                  className="absolute -right-1 -top-1 rounded-full bg-destructive text-destructive-foreground w-4 h-4 flex items-center justify-center"
                  onClick={() => handleFilterChange('resource_type', undefined)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Keyword Search */}
            <Input
              className="w-[180px] h-8 text-xs"
              placeholder={t('auditLog.searchPlaceholder')}
              value={filters.keyword || ''}
              onChange={(e) => handleFilterChange('keyword', e.target.value || undefined)}
            />

            {/* Date Range */}
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
            />

            {/* Action Buttons */}
            {hasActiveFilters() && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={handleResetFilters}
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                {t('auditLog.resetFilters')}
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={fetchLogs}
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              {t('auditLog.refresh')}
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={handleExport}
            >
              <Download className="mr-1 h-3 w-3" />
              {t('auditLog.export')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <CardContent className="p-0 flex-1 min-h-0 flex flex-col overflow-hidden">
          <DataTable
            columns={columns}
            data={data?.items || []}
            pageCount={data?.pages || 0}
            currentPage={pagination.current}
            pageSize={pagination.pageSize}
            onPageChange={handlePageChange}
            onPageSizeChange={(size) => handlePageChange(1, size)}
            loading={loading}
            fillHeight={true}
          />
        </CardContent>
      </Card>
    </div>
  )
}

export default AuditLog
