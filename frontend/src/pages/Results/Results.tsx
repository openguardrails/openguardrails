import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { format, parse } from 'date-fns'
import {
  Eye,
  RefreshCw,
  Download,
  Image as ImageIcon,
  FileImage,
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { DataTable } from '@/components/data-table/DataTable'
import { DateRangePicker } from '@/components/forms/DateRangePicker'
import { resultsApi, dataSecurityApi } from '../../services/api'
import type { DetectionResult, PaginatedResponse, DataSecurityEntityType } from '../../types'
import { translateRiskLevel } from '../../utils/i18nMapper'
import { useApplication } from '../../contexts/ApplicationContext'
import type { ColumnDef } from '@tanstack/react-table'
import type { DateRange } from 'react-day-picker'

// Helper function to extract filters from navigation state
const extractFiltersFromState = (state: any) => {
  const filters: any = {
    risk_level: undefined,
    security_risk_level: undefined,
    compliance_risk_level: undefined,
    data_risk_level: undefined,
    category: undefined,
    data_entity_type: undefined,
    data_leak: undefined,
    date_range: undefined,
    content_search: undefined,
    request_id_search: undefined,
  }

  if (!state) return filters

  // Handle risk_level
  if (state.risk_level) {
    filters.risk_level = Array.isArray(state.risk_level)
      ? state.risk_level[0]
      : state.risk_level
  }

  // Handle security_risk_level
  if (state.security_risk_level) {
    filters.security_risk_level = Array.isArray(state.security_risk_level)
      ? state.security_risk_level[0]
      : state.security_risk_level
  }

  // Handle compliance_risk_level
  if (state.compliance_risk_level) {
    filters.compliance_risk_level = Array.isArray(state.compliance_risk_level)
      ? state.compliance_risk_level[0]
      : state.compliance_risk_level
  }

  // Handle data_risk_level
  if (state.data_risk_level) {
    filters.data_risk_level = Array.isArray(state.data_risk_level)
      ? state.data_risk_level[0]
      : state.data_risk_level
  }

  // Handle data_leak (deprecated)
  if (state.data_leak) {
    filters.data_risk_level = 'any_risk'
  }

  // Handle category
  if (state.category) {
    filters.category = state.category
  }

  // Handle data_entity_type
  if (state.data_entity_type) {
    filters.data_entity_type = state.data_entity_type
  }

  return filters
}

const Results: React.FC = () => {
  const { t } = useTranslation()
  const location = useLocation()
  const { currentApplicationId } = useApplication()
  const [data, setData] = useState<PaginatedResponse<DetectionResult> | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedResult, setSelectedResult] = useState<DetectionResult | null>(null)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [dataEntityTypes, setDataEntityTypes] = useState<DataSecurityEntityType[]>([])

  // Initialize filters from location.state if available
  const [filters, setFilters] = useState(() => extractFiltersFromState(location.state))
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
  })

  // Define functions before useEffect
  const fetchDataEntityTypes = async () => {
    try {
      const response = await dataSecurityApi.list()
      if (response && response.items) {
        setDataEntityTypes(response.items)
      }
    } catch (error) {
      console.error('Error fetching data entity types:', error)
    }
  }

  const fetchResults = useCallback(async () => {
    try {
      setLoading(true)
      const params: any = {
        page: pagination.current,
        per_page: pagination.pageSize,
      }

      if (filters.risk_level) {
        params.risk_level = filters.risk_level
      }
      if (filters.security_risk_level) {
        params.security_risk_level = filters.security_risk_level
      }
      if (filters.compliance_risk_level) {
        params.compliance_risk_level = filters.compliance_risk_level
      }
      if (filters.data_risk_level) {
        params.data_risk_level = filters.data_risk_level
      }
      if (filters.category) {
        params.category = filters.category
      }
      if (filters.data_entity_type) {
        params.data_entity_type = filters.data_entity_type
      }
      if (dateRange?.from && dateRange?.to) {
        params.start_date = format(dateRange.from, 'yyyy-MM-dd')
        params.end_date = format(dateRange.to, 'yyyy-MM-dd')
      }
      if (filters.content_search) {
        params.content_search = filters.content_search
      }
      if (filters.request_id_search) {
        params.request_id_search = filters.request_id_search
      }

      const result = await resultsApi.getResults(params)
      setData(result)
    } catch (error) {
      console.error('Error fetching results:', error)
    } finally {
      setLoading(false)
    }
  }, [pagination.current, pagination.pageSize, filters, dateRange])

  // Update filters when location.state changes
  useEffect(() => {
    const state = location.state as any
    if (state) {
      const newFilters = extractFiltersFromState(state)
      setFilters(newFilters)
      setPagination((prev) => ({ ...prev, current: 1 }))
    }
  }, [location.state])

  useEffect(() => {
    fetchResults()
  }, [fetchResults, currentApplicationId])

  useEffect(() => {
    fetchDataEntityTypes()
  }, [])

  const handlePageChange = (page: number, newPageSize?: number) => {
    setPagination((prev) => ({
      current: page,
      pageSize: newPageSize ?? prev.pageSize,
    }))
  }

  const handleFilterChange = (key: string, value: any) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }))
    setPagination((prev) => ({ ...prev, current: 1 }))
  }

  const handleExport = useCallback(async () => {
    try {
      const loadingToast = toast.loading(t('results.exporting'))

      const params: any = {}

      if (filters.risk_level) {
        params.risk_level = filters.risk_level
      }
      if (filters.security_risk_level) {
        params.security_risk_level = filters.security_risk_level
      }
      if (filters.compliance_risk_level) {
        params.compliance_risk_level = filters.compliance_risk_level
      }
      if (filters.data_risk_level) {
        params.data_risk_level = filters.data_risk_level
      }
      if (filters.category) {
        params.category = filters.category
      }
      if (filters.data_entity_type) {
        params.data_entity_type = filters.data_entity_type
      }
      if (dateRange?.from && dateRange?.to) {
        params.start_date = format(dateRange.from, 'yyyy-MM-dd')
        params.end_date = format(dateRange.to, 'yyyy-MM-dd')
      }
      if (filters.content_search) {
        params.content_search = filters.content_search
      }
      if (filters.request_id_search) {
        params.request_id_search = filters.request_id_search
      }

      const blob = await resultsApi.exportResults(params)

      // Create download link
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `detection_results_${format(new Date(), 'yyyyMMdd_HHmmss')}.xlsx`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      toast.dismiss(loadingToast)
      toast.success(t('results.exportSuccess'))
    } catch (error) {
      console.error('Export error:', error)
      toast.error(t('results.exportFailed'))
    }
  }, [filters, dateRange, t])

  const showDetail = async (record: DetectionResult) => {
    setDetailLoading(true)
    setDrawerVisible(true)
    try {
      const fullRecord = await resultsApi.getResult(record.id)
      console.log('Full record from API:', fullRecord)
      setSelectedResult(fullRecord)
    } catch (error) {
      console.error('Failed to fetch full record:', error)
      setSelectedResult(record)
    } finally {
      setDetailLoading(false)
    }
  }

  // Risk level colors: high -> red, medium -> orange, low -> yellow
  const getRiskBadgeClasses = (level: string): string => {
    // Match both English and Chinese formats
    if (level === 'high_risk' || level === '高风险') {
      return '!bg-red-100 !text-red-800 !border-red-200'
    }
    if (level === 'medium_risk' || level === '中风险') {
      return '!bg-orange-100 !text-orange-800 !border-orange-200'
    }
    if (level === 'low_risk' || level === '低风险') {
      return '!bg-yellow-100 !text-yellow-800 !border-yellow-200'
    }
    // no_risk or other
    return '!bg-gray-100 !text-gray-800 !border-gray-200'
  }

  // Action colors: pass -> green, reject -> red, replace -> orange
  const getActionBadgeClasses = (action: string): string => {
    // Match both original values and translated values
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

  // Helper function to format risk display
  const formatRiskDisplay = (riskLevel: string, categories: string[]) => {
    const translatedRiskLevel = translateRiskLevel(riskLevel, t)

    if (categories && categories.length > 0) {
      return `${translatedRiskLevel} ${categories[0]}`
    }
    return translatedRiskLevel
  }

  // Helper function to format request ID display
  const formatRequestId = (requestId: string) => {
    if (requestId.length <= 20) {
      return requestId
    }
    return '...' + requestId.slice(-18)
  }

  // Define all risk categories
  const getAllCategories = () => {
    return [
      { value: 'General Political Topics', label: t('config.riskTypes.s1') },
      { value: 'Sensitive Political Topics', label: t('config.riskTypes.s2') },
      { value: 'Insult to National Symbols or Leaders', label: t('config.riskTypes.s3') },
      { value: 'Harm to Minors', label: t('config.riskTypes.s4') },
      { value: 'Violent Crime', label: t('config.riskTypes.s5') },
      { value: 'Non-Violent Crime', label: t('config.riskTypes.s6') },
      { value: 'Pornography', label: t('config.riskTypes.s7') },
      { value: 'Hate & Discrimination', label: t('config.riskTypes.s8') },
      { value: 'Prompt Attacks', label: t('config.riskTypes.s9') },
      { value: 'Profanity', label: t('config.riskTypes.s10') },
      { value: 'Privacy Invasion', label: t('config.riskTypes.s11') },
      { value: 'Commercial Violations', label: t('config.riskTypes.s12') },
      { value: 'Intellectual Property Infringement', label: t('config.riskTypes.s13') },
      { value: 'Harassment', label: t('config.riskTypes.s14') },
      { value: 'Weapons of Mass Destruction', label: t('config.riskTypes.s15') },
      { value: 'Self-Harm', label: t('config.riskTypes.s16') },
      { value: 'Sexual Crimes', label: t('config.riskTypes.s17') },
      { value: 'Threats', label: t('config.riskTypes.s18') },
      { value: 'Professional Advice', label: t('config.riskTypes.s19') },
    ]
  }

  const columns: ColumnDef<DetectionResult>[] = [
    {
      accessorKey: 'content',
      header: t('results.detectionContent'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div
            className="flex items-center gap-2 cursor-pointer text-blue-600 hover:underline"
            onClick={() => showDetail(record)}
          >
            {record.has_image && (
              <Badge variant="secondary" className="shrink-0">
                <FileImage className="mr-1 h-3 w-3" />
                {record.image_count}
              </Badge>
            )}
            <span className="truncate max-w-[250px]" title={record.content}>
              {record.content}
            </span>
          </div>
        )
      },
    },
    {
      accessorKey: 'request_id',
      header: t('results.requestId'),
      cell: ({ row }) => {
        const requestId = row.getValue('request_id') as string
        return (
          <code
            className="text-xs cursor-pointer truncate block max-w-[130px]"
            title={requestId}
          >
            {formatRequestId(requestId)}
          </code>
        )
      },
    },
    {
      id: 'prompt_attack',
      header: t('results.promptAttack'),
      cell: ({ row }) => {
        const record = row.original
        const riskLevel = record.security_risk_level || t('risk.level.no_risk')
        const categories = record.security_categories || []
        const displayText = formatRiskDisplay(riskLevel, categories)

        return (
          <Badge className={getRiskBadgeClasses(riskLevel)} title={categories.join(', ')}>
            {displayText}
          </Badge>
        )
      },
    },
    {
      id: 'content_compliance',
      header: t('results.contentCompliance'),
      cell: ({ row }) => {
        const record = row.original
        const riskLevel = record.compliance_risk_level || t('risk.level.no_risk')
        const categories = record.compliance_categories || []
        const displayText = formatRiskDisplay(riskLevel, categories)

        return (
          <Badge className={getRiskBadgeClasses(riskLevel)} title={categories.join(', ')}>
            {displayText}
          </Badge>
        )
      },
    },
    {
      id: 'data_leak',
      header: t('results.dataLeak'),
      cell: ({ row }) => {
        const record = row.original
        const riskLevel = record.data_risk_level || t('risk.level.no_risk')
        const categories = record.data_categories || []
        const displayText = formatRiskDisplay(riskLevel, categories)

        return (
          <Badge className={getRiskBadgeClasses(riskLevel)} title={categories.join(', ')}>
            {displayText}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'suggest_action',
      header: t('results.suggestedAction'),
      cell: ({ row }) => {
        const action = row.getValue('suggest_action') as string

        return (
          <Badge className={getActionBadgeClasses(action)}>
            {action}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'created_at',
      header: t('results.detectionTime'),
      cell: ({ row }) => {
        const time = row.getValue('created_at') as string
        const date = new Date(time)
        return (
          <span className="text-xs" title={format(date, 'yyyy-MM-dd HH:mm:ss')}>
            {format(date, 'MM-dd HH:mm')}
          </span>
        )
      },
    },
    {
      id: 'action',
      header: t('results.action'),
      cell: ({ row }) => (
        <Button
          variant="link"
          size="sm"
          onClick={() => showDetail(row.original)}
          className="h-auto p-0"
        >
          <Eye className="mr-1 h-4 w-4" />
          {t('results.details')}
        </Button>
      ),
    },
  ]

  return (
    <div className="h-full flex flex-col gap-4 overflow-hidden">
      <h2 className="text-3xl font-bold tracking-tight flex-shrink-0">{t('results.title')}</h2>

      {/* Filters Card */}
      <Card className="flex-shrink-0">
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3">
            {/* Risk Level */}
            <Select
              value={filters.risk_level}
              onValueChange={(value) => handleFilterChange('risk_level', value)}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder={t('results.selectRiskLevel')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any_risk">{t('risk.level.any_risk')}</SelectItem>
                <SelectItem value="high_risk">{t('risk.level.high_risk')}</SelectItem>
                <SelectItem value="medium_risk">{t('risk.level.medium_risk')}</SelectItem>
                <SelectItem value="low_risk">{t('risk.level.low_risk')}</SelectItem>
                <SelectItem value="no_risk">{t('risk.level.no_risk')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Security Risk */}
            <Select
              value={filters.security_risk_level}
              onValueChange={(value) => handleFilterChange('security_risk_level', value)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('results.filterSecurityRisk')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any_risk">{t('risk.level.any_risk')}</SelectItem>
                <SelectItem value="high_risk">{t('risk.level.high_risk')}</SelectItem>
                <SelectItem value="medium_risk">{t('risk.level.medium_risk')}</SelectItem>
                <SelectItem value="low_risk">{t('risk.level.low_risk')}</SelectItem>
                <SelectItem value="no_risk">{t('risk.level.no_risk')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Compliance Risk */}
            <Select
              value={filters.compliance_risk_level}
              onValueChange={(value) => handleFilterChange('compliance_risk_level', value)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('results.filterComplianceRisk')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any_risk">{t('risk.level.any_risk')}</SelectItem>
                <SelectItem value="high_risk">{t('risk.level.high_risk')}</SelectItem>
                <SelectItem value="medium_risk">{t('risk.level.medium_risk')}</SelectItem>
                <SelectItem value="low_risk">{t('risk.level.low_risk')}</SelectItem>
                <SelectItem value="no_risk">{t('risk.level.no_risk')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Data Leak Risk */}
            <Select
              value={filters.data_risk_level}
              onValueChange={(value) => handleFilterChange('data_risk_level', value)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('results.filterDataLeakRisk')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any_risk">{t('risk.level.any_risk')}</SelectItem>
                <SelectItem value="high_risk">{t('risk.level.high_risk')}</SelectItem>
                <SelectItem value="medium_risk">{t('risk.level.medium_risk')}</SelectItem>
                <SelectItem value="low_risk">{t('risk.level.low_risk')}</SelectItem>
                <SelectItem value="no_risk">{t('risk.level.no_risk')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Category */}
            <Select
              value={filters.category}
              onValueChange={(value) => handleFilterChange('category', value)}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder={t('results.selectCategory')} />
              </SelectTrigger>
              <SelectContent>
                {getAllCategories().map((cat) => (
                  <SelectItem key={cat.value} value={cat.value}>
                    {cat.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Data Entity Type */}
            <Select
              value={filters.data_entity_type}
              onValueChange={(value) => handleFilterChange('data_entity_type', value)}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder={t('results.selectDataEntityType')} />
              </SelectTrigger>
              <SelectContent>
                {dataEntityTypes
                  .filter((et) => et.is_active)
                  .map((et) => (
                    <SelectItem key={et.entity_type} value={et.entity_type}>
                      {et.display_name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            {/* Content Search */}
            <Input
              placeholder={t('results.contentSearch')}
              value={filters.content_search || ''}
              onChange={(e) => handleFilterChange('content_search', e.target.value || undefined)}
              className="w-[200px]"
            />

            {/* Request ID Search */}
            <Input
              placeholder={t('results.requestIdSearch')}
              value={filters.request_id_search || ''}
              onChange={(e) =>
                handleFilterChange('request_id_search', e.target.value || undefined)
              }
              className="w-[200px]"
            />

            {/* Date Range */}
            <DateRangePicker value={dateRange} onChange={setDateRange} />

            {/* Refresh Button */}
            <Button variant="outline" onClick={fetchResults}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('results.refresh')}
            </Button>

            {/* Export Button */}
            <Button onClick={handleExport}>
              <Download className="mr-2 h-4 w-4" />
              {t('results.export')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results Table */}
      <Card className="flex-1 flex flex-col overflow-hidden min-h-0">
        <CardContent className="p-0 flex-1 overflow-hidden flex flex-col">
          <DataTable
            columns={columns}
            data={data?.items || []}
            pageCount={Math.ceil((data?.total || 0) / pagination.pageSize)}
            currentPage={pagination.current}
            pageSize={pagination.pageSize}
            onPageChange={handlePageChange}
            loading={loading}
            fillHeight={true}
          />
        </CardContent>
      </Card>

      {/* Detail Drawer */}
      <Sheet open={drawerVisible} onOpenChange={setDrawerVisible}>
        <SheetContent className="w-[800px] max-w-[80vw] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('results.detectionDetails')}</SheetTitle>
          </SheetHeader>

          {detailLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
              <div className="mt-4">{t('results.loadingDetails')}</div>
            </div>
          ) : (
            selectedResult && (
              <div className="space-y-4 mt-6">
                {/* Request ID */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-gray-600 text-sm">{t('results.requestId')}:</div>
                  <div className="col-span-2">
                    <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                      {selectedResult.request_id}
                    </code>
                  </div>
                </div>

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
                    <Badge className={getActionBadgeClasses(selectedResult.suggest_action)}>
                      {selectedResult.suggest_action}
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

                {/* Detection Content */}
                <div>
                  <div className="font-medium text-gray-600 mb-3 text-sm">
                    {t('results.detectionContent')}:
                  </div>
                  <div className="mt-2 p-4 bg-gray-50 rounded-md">
                    {selectedResult.content && (
                      <p className="mb-3 whitespace-pre-wrap text-sm">{selectedResult.content}</p>
                    )}

                    {selectedResult.has_image &&
                      selectedResult.image_urls &&
                      selectedResult.image_urls.length > 0 && (
                        <div className="mt-3">
                          <div className="font-medium mb-2">
                            {t('results.imagesCount', { count: selectedResult.image_count })}:
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            {selectedResult.image_urls.map((imageUrl, index) => (
                              <div
                                key={index}
                                className="border border-gray-300 rounded p-2 bg-white"
                              >
                                <img
                                  src={imageUrl}
                                  alt={`${t('results.image')} ${index + 1}`}
                                  className="w-full h-32 object-cover rounded"
                                />
                                <div className="text-xs text-gray-500 text-center mt-1">
                                  {t('results.image')} {index + 1}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                  <div className="text-xs text-gray-500 mt-2">
                    {t('results.contentLengthChars', { length: selectedResult.content.length })}
                    {selectedResult.has_image &&
                      ` | ${t('results.includesImages', { count: selectedResult.image_count })}`}
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

                {/* Risk Details */}
                {((selectedResult.security_categories &&
                  selectedResult.security_categories.length > 0) ||
                  (selectedResult.compliance_categories &&
                    selectedResult.compliance_categories.length > 0) ||
                  (selectedResult.data_categories &&
                    selectedResult.data_categories.length > 0)) && (
                  <div>
                    <div className="font-medium text-gray-600 mb-3 text-sm">
                      {t('results.riskDetails')}:
                    </div>
                    <div className="space-y-2">
                      {selectedResult.security_categories &&
                        selectedResult.security_categories.length > 0 && (
                          <div>
                            <span className="text-xs font-medium">
                              {t('results.promptAttack')}:{' '}
                            </span>
                            {selectedResult.security_categories.map((category, index) => (
                              <Badge key={`security-${index}`} variant="destructive" className="mr-1 mb-1 text-xs">
                                {category}
                              </Badge>
                            ))}
                          </div>
                        )}
                      {selectedResult.compliance_categories &&
                        selectedResult.compliance_categories.length > 0 && (
                          <div>
                            <span className="text-xs font-medium">
                              {t('results.contentCompliance')}:{' '}
                            </span>
                            {selectedResult.compliance_categories.map((category, index) => (
                              <Badge key={`compliance-${index}`} variant="default" className="mr-1 mb-1 text-xs">
                                {category}
                              </Badge>
                            ))}
                          </div>
                        )}
                      {selectedResult.data_categories &&
                        selectedResult.data_categories.length > 0 && (
                          <div>
                            <span className="text-xs font-medium">
                              {t('results.dataLeak')}:{' '}
                            </span>
                            {selectedResult.data_categories.map((category, index) => (
                              <Badge key={`data-${index}`} variant="secondary" className="mr-1 mb-1 text-xs">
                                {category}
                              </Badge>
                            ))}
                          </div>
                        )}
                    </div>
                  </div>
                )}

                {/* Source IP */}
                {selectedResult.ip_address && (
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-gray-600 text-sm">{t('results.sourceIP')}:</div>
                    <div className="col-span-2">
                      <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                        {selectedResult.ip_address}
                      </code>
                    </div>
                  </div>
                )}
              </div>
            )
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default Results
