import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { format, parse } from 'date-fns'
import {
  Eye,
  EyeOff,
  RefreshCw,
  Download,
  Image as ImageIcon,
  FileImage,
  X,
  RotateCcw,
  Copy,
  Shield,
  Upload,
  FileSpreadsheet,
  Send,
  Trash2,
  Loader2,
  Globe,
  FolderOpen,
  MessageSquare,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DataTable } from '@/components/data-table/DataTable'
import { DateRangePicker } from '@/components/forms/DateRangePicker'
import api, { resultsApi, dataSecurityApi } from '../../services/api'
import type { DetectionResult, PaginatedResponse, DataSecurityEntityType } from '../../types'
import { translateRiskLevel } from '../../utils/i18nMapper'
import type { ColumnDef } from '@tanstack/react-table'
import type { DateRange } from 'react-day-picker'

// Helper function to extract filters from navigation state
const extractFiltersFromState = (state: any) => {
  const filters: any = {
    application_id: undefined,
    workspace_id: undefined,
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
    application_name_search: undefined,
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

interface AppOption {
  id: string
  name: string
  workspace_id?: string | null
  workspace_name?: string | null
}

interface WorkspaceOption {
  id: string
  name: string
  is_global?: boolean
}

// Replay related interfaces
interface ReplayMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ExcelRow {
  detection_content: string
  messages: ReplayMessage[]
  originalRow: Record<string, any>
}

interface BatchTestResult {
  detection_content: string
  compliance_risk_level: string
  compliance_categories: string
  security_risk_level: string
  security_categories: string
  data_risk_level: string
  data_categories: string
  overall_risk_level: string
  suggest_action: string
  suggest_answer: string
}

type BatchTestStatus = 'idle' | 'uploaded' | 'detecting' | 'completed' | 'error'

const ROLE_BADGE_CLASSES: Record<string, string> = {
  system: '!bg-purple-500/10 !text-purple-300 !border-purple-300/40',
  user: '!bg-blue-500/10 !text-blue-300 !border-blue-300/40',
  assistant: '!bg-emerald-500/10 !text-emerald-300 !border-emerald-300/40',
  tool: '!bg-amber-500/10 !text-amber-300 !border-amber-300/40',
}

// Collapse threshold for a single message body (chars). Anything longer is
// collapsed by default with an expand toggle.
const FULL_MESSAGE_PREVIEW_CHARS = 800

function flattenMessageContent(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part == null) return ''
        if (typeof part === 'string') return part
        if (part.type === 'text' && typeof part.text === 'string') return part.text
        if (part.type === 'image_url') return '[image]'
        try {
          return JSON.stringify(part)
        } catch {
          return String(part)
        }
      })
      .filter(Boolean)
      .join('\n')
  }
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

function extractImageUrls(content: any): string[] {
  if (!Array.isArray(content)) return []
  const urls: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url) urls.push(url)
    }
  }
  return urls
}

function tryPrettyJson(value: string): string {
  if (!value) return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return value
  }
}

interface FullMessagesViewerProps {
  messages: NonNullable<DetectionResult['full_messages']>
  expanded: Set<number>
  onToggle: (index: number) => void
  expandLabel: string
  collapseLabel: string
  charsLabel: (n: number) => string
  toolCallLabel: string
}

const FullMessagesViewer: React.FC<FullMessagesViewerProps> = ({
  messages,
  expanded,
  onToggle,
  expandLabel,
  collapseLabel,
  charsLabel,
  toolCallLabel,
}) => {
  return (
    <div className="space-y-3">
      {messages.map((msg, idx) => {
        const role = msg.role || 'unknown'
        const badgeCls = ROLE_BADGE_CLASSES[role] || '!bg-zinc-500/10 !text-zinc-300 !border-zinc-300/40'
        const contentText = flattenMessageContent(msg.content)
        const imageUrls = extractImageUrls(msg.content)
        const isLong = contentText.length > FULL_MESSAGE_PREVIEW_CHARS
        const isExpanded = expanded.has(idx)
        const displayContent = isLong && !isExpanded
          ? contentText.slice(0, FULL_MESSAGE_PREVIEW_CHARS) + '…'
          : contentText
        return (
          <div key={idx} className="rounded-md border border-border/60 bg-muted/30 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/40">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground tabular-nums">#{idx + 1}</span>
                <Badge variant="outline" className={`${badgeCls} text-xs`}>{role}</Badge>
                {msg.name && (
                  <span className="text-muted-foreground">name: <code className="font-mono">{msg.name}</code></span>
                )}
                {msg.tool_call_id && (
                  <span className="text-muted-foreground">tool_call_id: <code className="font-mono">{msg.tool_call_id}</code></span>
                )}
                {contentText && <span className="text-muted-foreground">{charsLabel(contentText.length)}</span>}
              </div>
              {isLong && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => onToggle(idx)}
                >
                  {isExpanded ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
                  {isExpanded ? collapseLabel : expandLabel}
                </Button>
              )}
            </div>
            {contentText && (
              <pre className="px-3 py-2 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[28rem] overflow-auto">
                {displayContent}
              </pre>
            )}
            {imageUrls.length > 0 && (
              <div className="border-t border-border/40 px-3 py-2 flex flex-wrap gap-2">
                {imageUrls.map((url, imgIdx) => (
                  <a
                    key={imgIdx}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded border border-border/50 overflow-hidden bg-background/60 hover:border-border"
                  >
                    <img
                      src={url}
                      alt={`message-${idx}-image-${imgIdx}`}
                      className="max-h-48 max-w-xs object-contain"
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            )}
            {Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && (
              <div className="border-t border-border/40 px-3 py-2 space-y-2">
                {msg.tool_calls.map((tc: any, tcIdx: number) => {
                  const fnName = tc.function?.name || tc.name || 'function'
                  const fnArgs = tc.function?.arguments ?? tc.arguments
                  const argsStr = typeof fnArgs === 'string' ? tryPrettyJson(fnArgs) : JSON.stringify(fnArgs ?? {}, null, 2)
                  return (
                    <div key={tc.id || tcIdx} className="rounded bg-background/60 border border-border/40">
                      <div className="px-2 py-1 text-xs flex items-center gap-2 border-b border-border/30">
                        <Badge variant="outline" className="text-[10px] !bg-amber-500/10 !text-amber-300 !border-amber-300/40">
                          {toolCallLabel}
                        </Badge>
                        <code className="font-mono">{fnName}</code>
                        {tc.id && <span className="text-muted-foreground">id: <code className="font-mono">{tc.id}</code></span>}
                      </div>
                      <pre className="px-2 py-1 text-xs whitespace-pre-wrap break-words font-mono max-h-64 overflow-auto">
                        {argsStr}
                      </pre>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const Results: React.FC = () => {
  const { t } = useTranslation()
  const location = useLocation()
  const [data, setData] = useState<PaginatedResponse<DetectionResult> | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedResult, setSelectedResult] = useState<DetectionResult | null>(null)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [segmentsLoading, setSegmentsLoading] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [showFullMessages, setShowFullMessages] = useState(false)
  const [expandedFullMessages, setExpandedFullMessages] = useState<Set<number>>(new Set())
  const [dataEntityTypes, setDataEntityTypes] = useState<DataSecurityEntityType[]>([])
  const [applicationOptions, setApplicationOptions] = useState<AppOption[]>([])
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>([])

  // Initialize filters from location.state if available
  const [filters, setFilters] = useState(() => extractFiltersFromState(location.state))
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
  })

  // Export confirm dialog state
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false)
  const [exportScope, setExportScope] = useState<'content' | 'full_messages'>('content')

  // Replay dialog states
  const [replayDialogOpen, setReplayDialogOpen] = useState(false)
  const [batchStatus, setBatchStatus] = useState<BatchTestStatus>('idle')
  const [batchFile, setBatchFile] = useState<File | null>(null)
  const [batchData, setBatchData] = useState<ExcelRow[]>([])
  const [batchResults, setBatchResults] = useState<BatchTestResult[]>([])
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 })
  const [selectedReplayWorkspaceId, setSelectedReplayWorkspaceId] = useState<string>('global')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Helper to get translated workspace display name
  const getWorkspaceDisplayName = (workspaceId?: string | null, workspaceName?: string | null) => {
    if (!workspaceId && !workspaceName) return null
    const ws = workspaceOptions.find(w => w.id === workspaceId)
    if (ws?.is_global) return t('workspaces.globalDefault', 'Default Workspace')
    return workspaceName || ws?.name || null
  }

  // Fetch applications and workspaces for filter dropdowns
  const fetchFilterOptions = async () => {
    try {
      const [appsRes, wsRes] = await Promise.all([
        api.get('/api/v1/applications'),
        api.get('/api/v1/workspaces'),
      ])
      setApplicationOptions(appsRes.data.map((a: any) => ({
        id: a.id, name: a.name,
        workspace_id: a.workspace_id, workspace_name: a.workspace_name,
      })))
      setWorkspaceOptions(wsRes.data.map((w: any) => ({ id: w.id, name: w.name, is_global: w.is_global })))
    } catch (error) {
      console.error('Error fetching filter options:', error)
    }
  }

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

      if (filters.application_id) {
        params.application_id = filters.application_id
      }
      if (filters.workspace_id) {
        params.workspace_id = filters.workspace_id
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
        params.tz_offset = new Date().getTimezoneOffset()
      }
      if (filters.content_search) {
        params.content_search = filters.content_search
      }
      if (filters.request_id_search) {
        params.request_id_search = filters.request_id_search
      }
      if (filters.application_name_search) {
        params.application_name_search = filters.application_name_search
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
  }, [fetchResults])

  useEffect(() => {
    fetchDataEntityTypes()
    fetchFilterOptions()
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

  const handleClearFilter = (key: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: undefined,
    }))
    setPagination((prev) => ({ ...prev, current: 1 }))
  }

  const handleResetAllFilters = () => {
    setFilters({
      application_id: undefined,
      workspace_id: undefined,
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
      application_name_search: undefined,
    })
    setDateRange(undefined)
    setPagination((prev) => ({ ...prev, current: 1 }))
  }

  // Check if any filter is active
  const hasActiveFilters = () => {
    return (
      filters.application_id ||
      filters.workspace_id ||
      filters.risk_level ||
      filters.security_risk_level ||
      filters.compliance_risk_level ||
      filters.data_risk_level ||
      filters.category ||
      filters.data_entity_type ||
      filters.content_search ||
      filters.request_id_search ||
      filters.application_name_search ||
      dateRange?.from ||
      dateRange?.to
    )
  }

  const handleExport = useCallback(async () => {
    setExportConfirmOpen(false)
    try {
      const loadingToast = toast.loading(t('results.exporting'))

      const params: any = {}

      if (filters.application_id) {
        params.application_id = filters.application_id
      }
      if (filters.workspace_id) {
        params.workspace_id = filters.workspace_id
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
        params.tz_offset = new Date().getTimezoneOffset()
      }
      if (filters.content_search) {
        params.content_search = filters.content_search
      }
      if (filters.request_id_search) {
        params.request_id_search = filters.request_id_search
      }
      if (filters.application_name_search) {
        params.application_name_search = filters.application_name_search
      }
      params.export_scope = exportScope

      const blob = await resultsApi.exportResults(params)

      // Create download link
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const ext = exportScope === 'full_messages' ? 'json' : 'xlsx'
      link.download = `detection_results_${format(new Date(), 'yyyyMMdd_HHmmss')}.${ext}`
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
  }, [filters, dateRange, exportScope, t])

  // ========== Replay Functions ==========

  // Parse detection content format: [User]: ...\n[Assistant]: ...
  const parseDetectionContent = (content: string): ReplayMessage[] => {
    const msgList: ReplayMessage[] = []
    const lines = content.split('\n')
    let currentRole: 'user' | 'assistant' | null = null
    let currentContent = ''

    for (const line of lines) {
      const userMatch = line.match(/^\[User\]:\s*(.*)/)
      const assistantMatch = line.match(/^\[Assistant\]:\s*(.*)/)

      if (userMatch) {
        if (currentRole && currentContent.trim()) {
          msgList.push({ role: currentRole, content: currentContent.trim() })
        }
        currentRole = 'user'
        currentContent = userMatch[1]
      } else if (assistantMatch) {
        if (currentRole && currentContent.trim()) {
          msgList.push({ role: currentRole, content: currentContent.trim() })
        }
        currentRole = 'assistant'
        currentContent = assistantMatch[1]
      } else if (currentRole) {
        currentContent += '\n' + line
      }
    }

    if (currentRole && currentContent.trim()) {
      msgList.push({ role: currentRole, content: currentContent.trim() })
    }

    return msgList
  }

  const handleReplayFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setBatchFile(file)
    setBatchStatus('idle')
    setBatchResults([])

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = e.target?.result
        const workbook = XLSX.read(data, { type: 'binary' })
        const sheetName = workbook.SheetNames[0]
        const sheet = workbook.Sheets[sheetName]
        const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' })

        if (jsonData.length === 0) {
          toast.error(t('onlineTest.batchTest.emptyFile'))
          setBatchFile(null)
          return
        }

        const firstRow = jsonData[0]
        const keys = Object.keys(firstRow)
        const detectionContentKey = keys.find(k =>
          k === 'Detection Content' || k === '检测内容'
        )

        if (!detectionContentKey) {
          toast.error(t('onlineTest.batchTest.missingColumns'))
          setBatchFile(null)
          return
        }

        const mappedData: ExcelRow[] = jsonData
          .map((row: any) => {
            const rawContent = String(row[detectionContentKey] || '').trim()
            if (!rawContent) return null

            const parsedMessages = parseDetectionContent(rawContent)
            if (parsedMessages.length === 0) {
              return {
                detection_content: rawContent,
                messages: [{ role: 'user' as const, content: rawContent }],
                originalRow: { ...row }
              }
            }
            return {
              detection_content: rawContent,
              messages: parsedMessages,
              originalRow: { ...row }
            }
          })
          .filter((row): row is ExcelRow => row !== null)

        if (mappedData.length === 0) {
          toast.error(t('onlineTest.batchTest.emptyFile'))
          setBatchFile(null)
          return
        }

        setBatchData(mappedData)
        setBatchStatus('uploaded')
        toast.success(t('onlineTest.batchTest.fileInfo', { name: file.name, rows: mappedData.length }))
      } catch (error) {
        console.error('Failed to parse Excel:', error)
        toast.error(t('onlineTest.batchTest.parseError'))
        setBatchFile(null)
      }
    }
    reader.readAsBinaryString(file)
  }

  const runBatchDetection = async () => {
    if (batchData.length === 0) return

    setBatchStatus('detecting')
    setBatchProgress({ current: 0, total: batchData.length })
    setBatchResults([])

    const results: BatchTestResult[] = []

    for (let i = 0; i < batchData.length; i++) {
      const row = batchData[i]
      try {
        const batchRequestData: any = {
          messages: row.messages,
        }
        if (selectedReplayWorkspaceId !== 'global') {
          batchRequestData.workspace_id = selectedReplayWorkspaceId
        }

        const response = await api.post('/api/v1/test/online', batchRequestData)

        const guardrail = response.data.guardrail
        results.push({
          detection_content: row.detection_content,
          compliance_risk_level: guardrail.compliance?.risk_level || 'no_risk',
          compliance_categories: (guardrail.compliance?.categories || []).join(', '),
          security_risk_level: guardrail.security?.risk_level || 'no_risk',
          security_categories: (guardrail.security?.categories || []).join(', '),
          data_risk_level: guardrail.data?.risk_level || 'no_risk',
          data_categories: (guardrail.data?.categories || []).join(', '),
          overall_risk_level: guardrail.overall_risk_level || 'no_risk',
          suggest_action: guardrail.suggest_action || 'pass',
          suggest_answer: guardrail.suggest_answer || '',
        })
      } catch (error: any) {
        console.error(`Detection failed for row ${i + 1}:`, error)
        results.push({
          detection_content: row.detection_content,
          compliance_risk_level: 'error',
          compliance_categories: '',
          security_risk_level: 'error',
          security_categories: '',
          data_risk_level: 'error',
          data_categories: '',
          overall_risk_level: 'error',
          suggest_action: 'error',
          suggest_answer: error?.response?.data?.detail || error?.message || 'Detection failed',
        })
      }

      setBatchProgress({ current: i + 1, total: batchData.length })
    }

    setBatchResults(results)
    setBatchStatus('completed')
    toast.success(t('onlineTest.batchTest.status.completed'))
  }

  const findDifferences = (original: ExcelRow[], replay: BatchTestResult[]) => {
    const differences: any[] = []

    for (let i = 0; i < original.length && i < replay.length; i++) {
      const orig = original[i].originalRow || {}
      const repl = replay[i]

      const origRequestId = orig['Request ID'] || orig['请求ID'] || ''
      const origApplication = orig['Application'] || orig['应用'] || ''
      const origWorkspace = orig['Workspace'] || orig['工作区'] || ''
      const origPromptAttackRisk = orig['Prompt Attack Risk'] || orig['提示词攻击风险'] || orig['安全风险'] || 'no_risk'
      const origPromptAttackCategories = orig['Prompt Attack Categories'] || orig['提示词攻击类别'] || orig['安全类别'] || ''
      const origContentComplianceRisk = orig['Content Compliance Risk'] || orig['内容合规风险'] || orig['合规风险'] || 'no_risk'
      const origContentComplianceCategories = orig['Content Compliance Categories'] || orig['内容合规类别'] || orig['合规类别'] || ''
      const origDataLeakRisk = orig['Data Leak Risk'] || orig['数据泄漏风险'] || orig['数据风险'] || 'no_risk'
      const origDataLeakCategories = orig['Data Leak Categories'] || orig['数据泄漏类别'] || orig['数据类别'] || ''
      const origSuggestedAction = orig['Suggested Action'] || orig['建议操作'] || 'pass'

      const isDifferent =
        origPromptAttackRisk !== repl.security_risk_level ||
        origPromptAttackCategories !== repl.security_categories ||
        origContentComplianceRisk !== repl.compliance_risk_level ||
        origContentComplianceCategories !== repl.compliance_categories ||
        origDataLeakRisk !== repl.data_risk_level ||
        origDataLeakCategories !== repl.data_categories ||
        origSuggestedAction !== repl.suggest_action

      if (isDifferent) {
        const truncatedContent = repl.detection_content.length > 32000
          ? repl.detection_content.slice(0, 32000) + '...(truncated)'
          : repl.detection_content
        differences.push({
          [t('onlineTest.batchTest.resultColumns.requestId') || 'Request ID']: origRequestId,
          [t('onlineTest.batchTest.resultColumns.application') || 'Application']: origApplication,
          [t('onlineTest.batchTest.resultColumns.workspace') || 'Workspace']: origWorkspace,
          [t('onlineTest.batchTest.resultColumns.detectionContent') || 'Detection Content']: truncatedContent,
          [t('onlineTest.batchTest.diffColumns.origPromptAttackRisk') || 'Original Prompt Attack Risk']: origPromptAttackRisk,
          [t('onlineTest.batchTest.diffColumns.replayPromptAttackRisk') || 'Replay Prompt Attack Risk']: repl.security_risk_level,
          [t('onlineTest.batchTest.diffColumns.origPromptAttackCategories') || 'Original Prompt Attack Categories']: origPromptAttackCategories,
          [t('onlineTest.batchTest.diffColumns.replayPromptAttackCategories') || 'Replay Prompt Attack Categories']: repl.security_categories,
          [t('onlineTest.batchTest.diffColumns.origContentComplianceRisk') || 'Original Content Compliance Risk']: origContentComplianceRisk,
          [t('onlineTest.batchTest.diffColumns.replayContentComplianceRisk') || 'Replay Content Compliance Risk']: repl.compliance_risk_level,
          [t('onlineTest.batchTest.diffColumns.origContentComplianceCategories') || 'Original Content Compliance Categories']: origContentComplianceCategories,
          [t('onlineTest.batchTest.diffColumns.replayContentComplianceCategories') || 'Replay Content Compliance Categories']: repl.compliance_categories,
          [t('onlineTest.batchTest.diffColumns.origDataLeakRisk') || 'Original Data Leak Risk']: origDataLeakRisk,
          [t('onlineTest.batchTest.diffColumns.replayDataLeakRisk') || 'Replay Data Leak Risk']: repl.data_risk_level,
          [t('onlineTest.batchTest.diffColumns.origDataLeakCategories') || 'Original Data Leak Categories']: origDataLeakCategories,
          [t('onlineTest.batchTest.diffColumns.replayDataLeakCategories') || 'Replay Data Leak Categories']: repl.data_categories,
          [t('onlineTest.batchTest.diffColumns.origSuggestedAction') || 'Original Suggested Action']: origSuggestedAction,
          [t('onlineTest.batchTest.diffColumns.replaySuggestedAction') || 'Replay Suggested Action']: repl.suggest_action,
        })
      }
    }

    return differences
  }

  const downloadReplayResults = () => {
    if (batchResults.length === 0) return

    const EXCEL_MAX_CELL_LENGTH = 32000
    const truncateText = (text: any): string => {
      const str = String(text ?? '')
      if (str.length > EXCEL_MAX_CELL_LENGTH) {
        return str.slice(0, EXCEL_MAX_CELL_LENGTH) + '...(truncated)'
      }
      return str
    }

    const truncateRow = (row: Record<string, any>): Record<string, any> => {
      const result: Record<string, any> = {}
      for (const [key, value] of Object.entries(row)) {
        result[key] = typeof value === 'string' ? truncateText(value) : value
      }
      return result
    }

    try {
      const wb = XLSX.utils.book_new()

      const sheetNameOriginal = String(t('onlineTest.batchTest.sheets.original') || 'Original Data').slice(0, 31)
      const sheetNameReplay = String(t('onlineTest.batchTest.sheets.replay') || 'Replay Results').slice(0, 31)
      const sheetNameDiff = String(t('onlineTest.batchTest.sheets.differences') || 'Differences').slice(0, 31)

      const originalSheetData = batchData.map(row => truncateRow(row.originalRow || { 'Detection Content': row.detection_content }))
      const ws1 = XLSX.utils.json_to_sheet(originalSheetData)
      XLSX.utils.book_append_sheet(wb, ws1, sheetNameOriginal)

      const replayData = batchResults.map((result, index) => {
        const orig = batchData[index]?.originalRow || {}
        const origRequestId = orig['Request ID'] || orig['请求ID'] || ''
        const origApplication = orig['Application'] || orig['应用'] || ''
        const origWorkspace = orig['Workspace'] || orig['工作区'] || ''

        return {
          [t('onlineTest.batchTest.resultColumns.requestId') || 'Request ID']: origRequestId,
          [t('onlineTest.batchTest.resultColumns.application') || 'Application']: origApplication,
          [t('onlineTest.batchTest.resultColumns.workspace') || 'Workspace']: origWorkspace,
          [t('onlineTest.batchTest.resultColumns.detectionContent') || 'Detection Content']: truncateText(result.detection_content),
          [t('onlineTest.batchTest.resultColumns.promptAttackRisk') || 'Prompt Attack Risk']: result.security_risk_level,
          [t('onlineTest.batchTest.resultColumns.promptAttackCategories') || 'Prompt Attack Categories']: result.security_categories,
          [t('onlineTest.batchTest.resultColumns.contentComplianceRisk') || 'Content Compliance Risk']: result.compliance_risk_level,
          [t('onlineTest.batchTest.resultColumns.contentComplianceCategories') || 'Content Compliance Categories']: result.compliance_categories,
          [t('onlineTest.batchTest.resultColumns.dataLeakRisk') || 'Data Leak Risk']: result.data_risk_level,
          [t('onlineTest.batchTest.resultColumns.dataLeakCategories') || 'Data Leak Categories']: result.data_categories,
          [t('onlineTest.batchTest.resultColumns.suggestedAction') || 'Suggested Action']: result.suggest_action,
          [t('onlineTest.batchTest.resultColumns.suggestedAnswer') || 'Suggested Answer']: truncateText(result.suggest_answer),
        }
      })
      const ws2 = XLSX.utils.json_to_sheet(replayData)
      ws2['!cols'] = [
        { wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 60 },
        { wch: 20 }, { wch: 30 }, { wch: 22 }, { wch: 30 },
        { wch: 18 }, { wch: 25 }, { wch: 18 }, { wch: 50 },
      ]
      XLSX.utils.book_append_sheet(wb, ws2, sheetNameReplay)

      const differences = findDifferences(batchData, batchResults)
      if (differences.length > 0) {
        const ws3 = XLSX.utils.json_to_sheet(differences)
        ws3['!cols'] = [
          { wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 50 },
          { wch: 22 }, { wch: 22 }, { wch: 25 }, { wch: 25 },
          { wch: 24 }, { wch: 24 }, { wch: 28 }, { wch: 28 },
          { wch: 20 }, { wch: 20 }, { wch: 22 }, { wch: 22 },
          { wch: 20 }, { wch: 20 },
        ]
        XLSX.utils.book_append_sheet(wb, ws3, sheetNameDiff)
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filename = `replay_comparison_${timestamp}.xlsx`

      XLSX.writeFile(wb, filename)
      toast.success(t('onlineTest.batchTest.downloadSuccess'))
    } catch (error: any) {
      console.error('Failed to download results:', error)
      toast.error(`${t('onlineTest.batchTest.downloadError')}: ${error?.message || error}`)
    }
  }

  const resetReplayTest = () => {
    setBatchStatus('idle')
    setBatchFile(null)
    setBatchData([])
    setBatchResults([])
    setBatchProgress({ current: 0, total: 0 })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const getReplayStatusColor = (status: BatchTestStatus) => {
    switch (status) {
      case 'idle':
        return 'bg-muted text-foreground'
      case 'uploaded':
        return 'bg-sky-500/15 text-sky-300'
      case 'detecting':
        return 'bg-yellow-500/15 text-yellow-300'
      case 'completed':
        return 'bg-emerald-500/15 text-emerald-300'
      case 'error':
        return 'bg-red-500/15 text-red-300'
      default:
        return 'bg-muted text-foreground'
    }
  }

  const translateRiskLevel = (riskLevel: string) => {
    const riskLevelMap: { [key: string]: string } = {
      high_risk: t('risk.level.high_risk'),
      medium_risk: t('risk.level.medium_risk'),
      low_risk: t('risk.level.low_risk'),
      no_risk: t('risk.level.no_risk'),
    }
    return riskLevelMap[riskLevel] || riskLevel
  }

  const getReplayRiskBgColor = (level: string) => {
    switch (level) {
      case 'high_risk':
        return 'bg-red-500/10 border-red-500/20 text-red-300'
      case 'medium_risk':
        return 'bg-orange-500/10 border-orange-500/20 text-orange-300'
      case 'low_risk':
        return 'bg-yellow-500/10 border-yellow-500/20 text-yellow-300'
      case 'no_risk':
      case 'safe':
        return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
      default:
        return 'bg-muted border-border text-foreground'
    }
  }

  // ========== End Replay Functions ==========

  const showDetail = async (record: DetectionResult) => {
    setDetailLoading(true)
    setSegmentsLoading(false)
    setShowOriginal(false)
    setShowFullMessages(false)
    setExpandedFullMessages(new Set())
    setDrawerVisible(true)
    try {
      const fullRecord = await resultsApi.getResult(record.id)
      console.log('Full record from API:', fullRecord)
      setSelectedResult(fullRecord)

      // On-demand extraction: if compliance/security risk exists and no segments cached yet
      const hasComplianceRisk = fullRecord.compliance_risk_level && fullRecord.compliance_risk_level !== 'no_risk'
      const hasSecurityRisk = fullRecord.security_risk_level && fullRecord.security_risk_level !== 'no_risk'
      const noSegments = !fullRecord.unsafe_segments || fullRecord.unsafe_segments.length === 0

      if ((hasComplianceRisk || hasSecurityRisk) && noSegments) {
        setSegmentsLoading(true)
        try {
          const segResult = await resultsApi.extractUnsafeSegments(fullRecord.id)
          if (segResult.unsafe_segments && segResult.unsafe_segments.length > 0) {
            setSelectedResult((prev: DetectionResult | null) =>
              prev ? { ...prev, unsafe_segments: segResult.unsafe_segments } : prev
            )
          }
        } catch (err) {
          console.warn('Failed to extract unsafe segments:', err)
        } finally {
          setSegmentsLoading(false)
        }
      }
    } catch (error) {
      console.error('Failed to fetch full record:', error)
      setSelectedResult(record)
    } finally {
      setDetailLoading(false)
    }
  }

  // Render content with highlighted unsafe segments
  const renderHighlightedContent = (
    content: string,
    segments: Array<{ text: string; start: number; end: number; categories: string[] }>
  ): React.ReactNode => {
    if (!segments || segments.length === 0) return content

    // Sort segments by start position
    const sorted = [...segments].sort((a, b) => a.start - b.start)

    const parts: React.ReactNode[] = []
    let lastEnd = 0

    sorted.forEach((seg, idx) => {
      // Add text before this segment
      if (seg.start > lastEnd) {
        parts.push(content.slice(lastEnd, seg.start))
      }
      // Add highlighted segment
      parts.push(
        <mark
          key={idx}
          className="bg-red-500/20 text-red-400 border-b-2 border-red-500 rounded-sm px-0.5"
          title={seg.categories.join(', ')}
        >
          {content.slice(seg.start, seg.end)}
        </mark>
      )
      lastEnd = Math.max(lastEnd, seg.end)
    })

    // Add remaining text
    if (lastEnd < content.length) {
      parts.push(content.slice(lastEnd))
    }

    return <>{parts}</>
  }

  // Risk level colors: high -> red, medium -> orange, low -> yellow
  const getRiskBadgeClasses = (level: string): string => {
    // Match both English and Chinese formats
    if (level === 'high_risk' || level === '高风险') {
      return '!bg-red-500/15 !text-red-300 !border-red-500/20'
    }
    if (level === 'medium_risk' || level === '中风险') {
      return '!bg-orange-500/15 !text-orange-300 !border-orange-500/20'
    }
    if (level === 'low_risk' || level === '低风险') {
      return '!bg-yellow-500/15 !text-yellow-300 !border-yellow-500/20'
    }
    // no_risk or other
    return '!bg-muted !text-foreground !border-border'
  }

  // Action colors: pass -> green, reject -> red, replace -> orange
  const getActionBadgeClasses = (action: string): string => {
    // Match both original values and translated values
    const passText = t('action.pass')
    const rejectText = t('action.reject')
    const replaceText = t('action.replace')

    if (action === 'pass' || action === passText) {
      return '!bg-emerald-500/15 !text-emerald-300 !border-emerald-500/20'
    }
    if (action === 'reject' || action === rejectText) {
      return '!bg-red-500/15 !text-red-300 !border-red-500/20'
    }
    if (action === 'replace' || action === replaceText) {
      return '!bg-orange-500/15 !text-orange-300 !border-orange-500/20'
    }
    return '!bg-muted !text-foreground !border-border'
  }

  // Helper function to format risk display
  const formatRiskDisplay = (riskLevel: string, categories: string[]) => {
    const translatedLevel = translateRiskLevel(riskLevel)

    if (categories && categories.length > 0) {
      // Show all categories, separated by commas
      return `${translatedLevel} ${categories.join(', ')}`
    }
    return translatedLevel
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
            className="flex items-center gap-2 cursor-pointer text-sky-400 hover:underline"
            onClick={() => showDetail(record)}
          >
            {record.is_direct_model_access && (
              <Badge variant="outline" className="shrink-0 !bg-purple-500/10 !text-purple-400 !border-purple-300">
                DMA
              </Badge>
            )}
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
      accessorKey: 'application_name',
      header: t('results.application'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="text-xs">
            <div className="font-medium truncate max-w-[100px]" title={record.application_name || ''}>
              {record.application_name || '-'}
            </div>
            {record.workspace_name && (
              <div className="text-muted-foreground truncate max-w-[100px]" title={getWorkspaceDisplayName(record.workspace_id, record.workspace_name) || record.workspace_name}>
                {getWorkspaceDisplayName(record.workspace_id, record.workspace_name) || record.workspace_name}
              </div>
            )}
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
        const riskLevel = record.security_risk_level || 'no_risk'
        const categories = record.security_categories || []
        const translatedLevel = translateRiskLevel(riskLevel)

        return (
          <div className="flex flex-wrap gap-1 items-center max-w-[180px]">
            <Badge className={getRiskBadgeClasses(riskLevel)}>
              {translatedLevel}
            </Badge>
            {categories.map((cat, idx) => (
              <Badge key={idx} variant="outline" className="text-xs !py-0 !px-1">
                {cat}
              </Badge>
            ))}
          </div>
        )
      },
    },
    {
      id: 'content_compliance',
      header: t('results.contentCompliance'),
      cell: ({ row }) => {
        const record = row.original
        const riskLevel = record.compliance_risk_level || 'no_risk'
        const categories = record.compliance_categories || []
        const translatedLevel = translateRiskLevel(riskLevel)

        return (
          <div className="flex flex-wrap gap-1 items-center max-w-[180px]">
            <Badge className={getRiskBadgeClasses(riskLevel)}>
              {translatedLevel}
            </Badge>
            {categories.map((cat, idx) => (
              <Badge key={idx} variant="outline" className="text-xs !py-0 !px-1">
                {cat}
              </Badge>
            ))}
          </div>
        )
      },
    },
    {
      id: 'data_leak',
      header: t('results.dataLeak'),
      cell: ({ row }) => {
        const record = row.original
        const riskLevel = record.data_risk_level || 'no_risk'
        const categories = record.data_categories || []
        const translatedLevel = translateRiskLevel(riskLevel)

        return (
          <div className="flex flex-wrap gap-1 items-center max-w-[180px]">
            <Badge className={getRiskBadgeClasses(riskLevel)}>
              {translatedLevel}
            </Badge>
            {categories.map((cat, idx) => (
              <Badge key={idx} variant="outline" className="text-xs !py-0 !px-1">
                {cat}
              </Badge>
            ))}
          </div>
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
    <div className="flex flex-col gap-4 min-h-0 flex-1">
      <h2 className="text-3xl font-bold tracking-tight shrink-0">{t('results.title')}</h2>

      {/* Filters Card */}
      <Card className="shrink-0">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap gap-2 items-center">
            {/* Application Filter */}
            <div className="relative">
              <Select
                key={`app-${filters.application_id || 'empty'}`}
                value={filters.application_id}
                onValueChange={(value) => handleFilterChange('application_id', value)}
              >
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder={t('results.filterApplication')} />
                </SelectTrigger>
                <SelectContent>
                  {applicationOptions.map((app) => (
                    <SelectItem key={app.id} value={app.id}>
                      {app.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filters.application_id && (
                <button
                  onClick={() => handleClearFilter('application_id')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Application Name Search */}
            <div className="relative">
              <Input
                placeholder={t('results.applicationNameSearch')}
                value={filters.application_name_search || ''}
                onChange={(e) => handleFilterChange('application_name_search', e.target.value || undefined)}
                className="w-[140px] h-8 text-xs"
              />
              {filters.application_name_search && (
                <button
                  onClick={() => handleClearFilter('application_name_search')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Workspace Filter */}
            {workspaceOptions.length > 0 && (
              <div className="relative">
                <Select
                  key={`ws-${filters.workspace_id || 'empty'}`}
                  value={filters.workspace_id}
                  onValueChange={(value) => handleFilterChange('workspace_id', value)}
                >
                  <SelectTrigger className="w-[140px] h-8 text-xs">
                    <SelectValue placeholder={t('results.filterWorkspace')} />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaceOptions.map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>
                        {ws.is_global ? t('workspaces.globalDefault', 'Default Workspace') : ws.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {filters.workspace_id && (
                  <button
                    onClick={() => handleClearFilter('workspace_id')}
                    className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                  >
                    <X className="w-2.5 h-2.5 text-white" />
                  </button>
                )}
              </div>
            )}

            {/* Risk Level */}
            <div className="relative">
              <Select
                key={`risk-${filters.risk_level || 'empty'}`}
                value={filters.risk_level}
                onValueChange={(value) => handleFilterChange('risk_level', value)}
              >
                <SelectTrigger className="w-[120px] h-8 text-xs">
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
              {filters.risk_level && (
                <button
                  onClick={() => handleClearFilter('risk_level')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Security Risk */}
            <div className="relative">
              <Select
                key={`sec-${filters.security_risk_level || 'empty'}`}
                value={filters.security_risk_level}
                onValueChange={(value) => handleFilterChange('security_risk_level', value)}
              >
                <SelectTrigger className="w-[120px] h-8 text-xs">
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
              {filters.security_risk_level && (
                <button
                  onClick={() => handleClearFilter('security_risk_level')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Compliance Risk */}
            <div className="relative">
              <Select
                key={`comp-${filters.compliance_risk_level || 'empty'}`}
                value={filters.compliance_risk_level}
                onValueChange={(value) => handleFilterChange('compliance_risk_level', value)}
              >
                <SelectTrigger className="w-[120px] h-8 text-xs">
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
              {filters.compliance_risk_level && (
                <button
                  onClick={() => handleClearFilter('compliance_risk_level')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Data Leak Risk */}
            <div className="relative">
              <Select
                key={`data-${filters.data_risk_level || 'empty'}`}
                value={filters.data_risk_level}
                onValueChange={(value) => handleFilterChange('data_risk_level', value)}
              >
                <SelectTrigger className="w-[130px] h-8 text-xs">
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
              {filters.data_risk_level && (
                <button
                  onClick={() => handleClearFilter('data_risk_level')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Category */}
            <div className="relative">
              <Select
                key={`cat-${filters.category || 'empty'}`}
                value={filters.category}
                onValueChange={(value) => handleFilterChange('category', value)}
              >
                <SelectTrigger className="w-[140px] h-8 text-xs">
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
              {filters.category && (
                <button
                  onClick={() => handleClearFilter('category')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Data Entity Type */}
            <div className="relative">
              <Select
                key={`entity-${filters.data_entity_type || 'empty'}`}
                value={filters.data_entity_type}
                onValueChange={(value) => handleFilterChange('data_entity_type', value)}
              >
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder={t('results.selectDataEntityType')} />
                </SelectTrigger>
                <SelectContent>
                  {dataEntityTypes
                    .filter((et) => et.is_active)
                    .map((et) => (
                      <SelectItem key={et.entity_type} value={et.entity_type}>
                        {et.entity_type_name || et.entity_type}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {filters.data_entity_type && (
                <button
                  onClick={() => handleClearFilter('data_entity_type')}
                  className="absolute -right-1 -top-1 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Content Search */}
            <div className="relative">
              <Input
                placeholder={t('results.contentSearch')}
                value={filters.content_search || ''}
                onChange={(e) => handleFilterChange('content_search', e.target.value || undefined)}
                className="w-[140px] h-8 text-xs"
              />
              {filters.content_search && (
                <button
                  onClick={() => handleClearFilter('content_search')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Request ID Search */}
            <div className="relative">
              <Input
                placeholder={t('results.requestIdSearch')}
                value={filters.request_id_search || ''}
                onChange={(e) =>
                  handleFilterChange('request_id_search', e.target.value || undefined)
                }
                className="w-[140px] h-8 text-xs"
              />
              {filters.request_id_search && (
                <button
                  onClick={() => handleClearFilter('request_id_search')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 bg-gray-400 hover:bg-card/50 rounded-full flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>

            {/* Date Range */}
            <DateRangePicker value={dateRange} onChange={setDateRange} />

            {/* Reset All Filters Button */}
            {hasActiveFilters() && (
              <Button variant="ghost" size="sm" onClick={handleResetAllFilters} className="h-8 text-xs text-muted-foreground hover:text-slate-200">
                <RotateCcw className="mr-1 h-3 w-3" />
                {t('common.reset')}
              </Button>
            )}

            {/* Refresh Button */}
            <Button variant="outline" size="sm" onClick={fetchResults} className="h-8 text-xs">
              <RefreshCw className="mr-1 h-3 w-3" />
              {t('results.refresh')}
            </Button>

            {/* Export Button */}
            <Button size="sm" onClick={() => setExportConfirmOpen(true)} className="h-8 text-xs">
              <Download className="mr-1 h-3 w-3" />
              {t('results.export')}
            </Button>

            {/* Replay Button */}
            <Button variant="outline" size="sm" onClick={() => setReplayDialogOpen(true)} className="h-8 text-xs">
              <Upload className="mr-1 h-3 w-3" />
              {t('results.replay')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results Table */}
      <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <CardContent className="p-0 flex-1 min-h-0 flex flex-col overflow-hidden">
          <DataTable
            columns={columns}
            data={data?.items || []}
            pageCount={data?.total != null ? Math.ceil(data.total / pagination.pageSize) : undefined}
            hasMore={data?.has_more}
            currentPage={pagination.current}
            pageSize={pagination.pageSize}
            onPageChange={handlePageChange}
            onPageSizeChange={(size) => handlePageChange(1, size)}
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
                {/* Application & Workspace */}
                {selectedResult.application_name && (
                  <div className="grid grid-cols-3 gap-4 border-b pb-3">
                    <div className="font-medium text-muted-foreground text-sm">{t('results.application')}:</div>
                    <div className="col-span-2 flex items-center gap-2">
                      <span className="text-sm">{selectedResult.application_name}</span>
                      {selectedResult.workspace_name && (
                        <Badge variant="outline" className="text-xs">
                          {getWorkspaceDisplayName(selectedResult.workspace_id, selectedResult.workspace_name) || selectedResult.workspace_name}
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {/* Request ID */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-muted-foreground text-sm">{t('results.requestId')}:</div>
                  <div className="col-span-2 flex items-center gap-2">
                    <code className="text-xs bg-muted px-2 py-1 rounded">
                      {selectedResult.request_id}
                    </code>
                    {selectedResult.is_direct_model_access && (
                      <Badge variant="outline" className="!bg-purple-500/10 !text-purple-400 !border-purple-300 text-xs">
                        Direct Model Access
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Detection Source */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-muted-foreground text-sm">{t('results.detectionSource')}:</div>
                  <div className="col-span-2">
                    <Badge variant="outline" className={
                      selectedResult.source === 'proxy' ? '!bg-blue-500/10 !text-blue-400 !border-blue-300 text-xs' :
                      selectedResult.source === 'gateway' ? '!bg-orange-500/10 !text-orange-400 !border-orange-300 text-xs' :
                      selectedResult.source === 'guardrail_api' ? '!bg-green-500/10 !text-green-400 !border-green-300 text-xs' :
                      selectedResult.source === 'direct_model' ? '!bg-purple-500/10 !text-purple-400 !border-purple-300 text-xs' :
                      selectedResult.source === 'content_scan' ? '!bg-cyan-500/10 !text-cyan-400 !border-cyan-300 text-xs' :
                      '!bg-gray-500/10 !text-gray-400 !border-gray-300 text-xs'
                    }>
                      {t(`results.source_${selectedResult.source || 'unknown'}`)}
                    </Badge>
                  </div>
                </div>

                {/* Prompt Attack */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-muted-foreground text-sm">{t('results.promptAttack')}:</div>
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
                  <div className="font-medium text-muted-foreground text-sm">
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
                  <div className="font-medium text-muted-foreground text-sm">{t('results.dataLeak')}:</div>
                  <div className="col-span-2">
                    <Badge className={getRiskBadgeClasses(selectedResult.data_risk_level || 'no_risk')}>
                      {formatRiskDisplay(
                        selectedResult.data_risk_level || t('risk.level.no_risk'),
                        selectedResult.data_categories || []
                      )}
                    </Badge>
                  </div>
                </div>

                {/* Whitelist / Blacklist Hit Info */}
                {selectedResult.model_response && (selectedResult.model_response === 'whitelist_hit' || selectedResult.model_response === 'blacklist_hit') && (
                  <div className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge className={
                        selectedResult.model_response === 'whitelist_hit'
                          ? '!bg-green-500/10 !text-green-400 !border-green-300 text-xs'
                          : '!bg-red-500/10 !text-red-400 !border-red-300 text-xs'
                      }>
                        {selectedResult.model_response === 'whitelist_hit'
                          ? t('results.whitelistHit')
                          : t('results.blacklistHit')}
                      </Badge>
                      {selectedResult.compliance_categories && selectedResult.compliance_categories.length > 0 && (
                        <span className="text-sm text-muted-foreground">
                          {t('results.hitListName')}: <span className="font-medium text-foreground">{selectedResult.compliance_categories[0]}</span>
                        </span>
                      )}
                    </div>
                    {selectedResult.hit_keywords && (() => {
                      try {
                        const keywords = JSON.parse(selectedResult.hit_keywords);
                        if (Array.isArray(keywords) && keywords.length > 0) {
                          return (
                            <div>
                              <div className="text-xs text-muted-foreground mb-1.5">{t('results.hitKeywords')}:</div>
                              <div className="flex flex-wrap gap-1">
                                {keywords.map((kw: string, i: number) => (
                                  <Badge key={i} variant="outline" className="text-xs">
                                    {kw}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      } catch { return null; }
                    })()}
                  </div>
                )}

                {/* Suggested Action */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-muted-foreground text-sm">{t('results.suggestedAction')}:</div>
                  <div className="col-span-2">
                    <Badge className={getActionBadgeClasses(selectedResult.suggest_action || '')}>
                      {selectedResult.suggest_action || '-'}
                    </Badge>
                  </div>
                </div>

                {/* Doublecheck Result */}
                {selectedResult.doublecheck_result && (
                  <div className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                      <RotateCcw className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{t('results.doublecheckResult')}</span>
                      <Badge className={
                        selectedResult.doublecheck_result === 'overturned_safe'
                          ? '!bg-green-500/10 !text-green-400 !border-green-300 text-xs'
                          : '!bg-red-500/10 !text-red-400 !border-red-300 text-xs'
                      }>
                        {selectedResult.doublecheck_result === 'overturned_safe'
                          ? t('results.doublecheckOverturnedSafe')
                          : t('results.doublecheckConfirmedUnsafe')}
                      </Badge>
                    </div>
                    {selectedResult.doublecheck_categories && selectedResult.doublecheck_categories.length > 0 && (
                      <div className="grid grid-cols-3 gap-4">
                        <div className="text-xs text-muted-foreground">{t('results.doublecheckOriginalCategories')}:</div>
                        <div className="col-span-2 flex flex-wrap gap-1">
                          {selectedResult.doublecheck_categories.map((cat, i) => (
                            <Badge key={i} variant="outline" className="text-xs">{cat}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedResult.doublecheck_reasoning && (
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">{t('results.doublecheckReasoning')}:</div>
                        <div className="text-sm p-2 bg-secondary rounded-md whitespace-pre-wrap">
                          {selectedResult.doublecheck_reasoning}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Detection Time */}
                <div className="grid grid-cols-3 gap-4 border-b pb-3">
                  <div className="font-medium text-muted-foreground text-sm">{t('results.detectionTime')}:</div>
                  <div className="col-span-2 text-sm">
                    {format(new Date(selectedResult.created_at), 'yyyy-MM-dd HH:mm:ss')}
                  </div>
                </div>

                {/* Detection Content */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-medium text-muted-foreground text-sm flex items-center gap-2">
                      {t('results.detectionContent')}:
                      {selectedResult.has_data_masking && (
                        <Badge variant="outline" className="!bg-amber-500/10 !text-amber-400 !border-amber-300 text-xs">
                          <Shield className="h-3 w-3 mr-1" />
                          {t('results.dataMasked')}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedResult.has_data_masking && selectedResult.original_content && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setShowOriginal(!showOriginal)}
                        >
                          {showOriginal ? (
                            <>
                              <EyeOff className="h-3 w-3 mr-1" />
                              {t('results.showMaskedContent')}
                            </>
                          ) : (
                            <>
                              <Eye className="h-3 w-3 mr-1" />
                              {t('results.showOriginalContent')}
                            </>
                          )}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          const contentToCopy = showOriginal && selectedResult.original_content
                            ? selectedResult.original_content
                            : selectedResult.content
                          navigator.clipboard.writeText(contentToCopy).then(() => {
                            toast.success(t('results.contentCopied'))
                          }).catch(() => {
                            toast.error(t('results.copyFailed'))
                          })
                        }}
                      >
                        <Copy className="h-3 w-3 mr-1" />
                        {t('results.copyContent')}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 p-4 bg-secondary rounded-md">
                    {(() => {
                      const displayContent = showOriginal && selectedResult.original_content
                        ? selectedResult.original_content
                        : selectedResult.content
                      return displayContent && (
                        <p className="mb-3 whitespace-pre-wrap text-sm">
                          {!showOriginal && selectedResult.unsafe_segments && selectedResult.unsafe_segments.length > 0
                            ? renderHighlightedContent(displayContent, selectedResult.unsafe_segments)
                            : displayContent}
                        </p>
                      )
                    })()}
                    {segmentsLoading && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2 mb-1">
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        {t('results.analyzingUnsafeSegments')}
                      </div>
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
                                className="border border-border rounded p-2 bg-card"
                              >
                                <img
                                  src={imageUrl}
                                  alt={`${t('results.image')} ${index + 1}`}
                                  className="w-full h-32 object-cover rounded"
                                />
                                <div className="text-xs text-muted-foreground text-center mt-1">
                                  {t('results.image')} {index + 1}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    {t('results.contentLengthChars', { length: selectedResult.content.length })}
                    {selectedResult.has_image &&
                      ` | ${t('results.includesImages', { count: selectedResult.image_count })}`}
                    {selectedResult.unsafe_segments && selectedResult.unsafe_segments.length > 0 &&
                      ` | ${t('results.unsafeSegments', { count: selectedResult.unsafe_segments.length })}`}
                  </div>
                  {/* Detection Scope Info */}
                  {selectedResult.detection_scope && (
                    <div className="text-xs text-muted-foreground mt-1 p-2 bg-muted/50 rounded">
                      <span className="font-medium">{t('results.detectionScope')}:</span>{' '}
                      {t(`results.scope_${selectedResult.detection_scope}`, selectedResult.detection_scope)}
                      {selectedResult.sliding_window_count && selectedResult.sliding_window_count > 1 && (
                        <span className="ml-2">
                          ({t('results.slidingWindows', { count: selectedResult.sliding_window_count })})
                          {selectedResult.matched_window_indices && selectedResult.matched_window_indices.length > 0 && (
                            <span className="text-red-400 ml-1">
                              {t('results.matchedWindows')}: [{selectedResult.matched_window_indices.join(', ')}]
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Full Messages (audit) */}
                {selectedResult.full_messages && selectedResult.full_messages.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="font-medium text-muted-foreground text-sm flex items-center gap-2">
                        <MessageSquare className="h-4 w-4" />
                        {t('results.fullMessages')}
                        <Badge variant="outline" className="text-xs ml-1">
                          {selectedResult.full_messages.length}
                        </Badge>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          setShowFullMessages(prev => {
                            if (prev) setExpandedFullMessages(new Set())
                            return !prev
                          })
                        }}
                      >
                        {showFullMessages ? (
                          <>
                            <EyeOff className="h-3 w-3 mr-1" />
                            {t('results.hideFullMessages')}
                          </>
                        ) : (
                          <>
                            <Eye className="h-3 w-3 mr-1" />
                            {t('results.showFullMessages')}
                          </>
                        )}
                      </Button>
                    </div>
                    {!showFullMessages ? (
                      <div className="text-xs text-muted-foreground p-3 bg-muted/30 rounded-md border border-dashed">
                        {t('results.fullMessagesHint')}
                      </div>
                    ) : (
                      <FullMessagesViewer
                        messages={selectedResult.full_messages}
                        expanded={expandedFullMessages}
                        onToggle={(idx) => {
                          setExpandedFullMessages(prev => {
                            const next = new Set(prev)
                            if (next.has(idx)) next.delete(idx)
                            else next.add(idx)
                            return next
                          })
                        }}
                        expandLabel={t('results.expand')}
                        collapseLabel={t('results.collapse')}
                        charsLabel={(n) => t('results.contentLengthChars', { length: n })}
                        toolCallLabel={t('results.toolCall')}
                      />
                    )}
                  </div>
                )}

                {/* Suggested Answer */}
                {selectedResult.suggest_answer && (
                  <div>
                    <div className="font-medium text-muted-foreground mb-3 text-sm">
                      {t('results.suggestedAnswer')}:
                    </div>
                    <div className="mt-2 p-4 bg-sky-500/10 rounded-md whitespace-pre-wrap text-sm">
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
                    <div className="font-medium text-muted-foreground mb-3 text-sm">
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
                    <div className="font-medium text-muted-foreground text-sm">{t('results.sourceIP')}:</div>
                    <div className="col-span-2">
                      <code className="text-xs bg-muted px-2 py-1 rounded">
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

      {/* Export Confirm Dialog */}
      <AlertDialog open={exportConfirmOpen} onOpenChange={setExportConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('results.exportConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('results.exportConfirmDescription')}</p>
                <div className="rounded-md bg-muted p-3 text-sm space-y-1">
                  <p><span className="font-medium">{t('results.exportConfirmTotal')}:</span> {data?.total != null ? `${data.total.toLocaleString()} ${t('results.exportConfirmRecords')}` : `10000+ ${t('results.exportConfirmRecords')}`}</p>
                  {hasActiveFilters() && (
                    <p className="text-xs text-muted-foreground">{t('results.exportConfirmFiltered')}</p>
                  )}
                  <p><span className="font-medium">{t('results.exportConfirmFormat')}:</span> {exportScope === 'full_messages' ? 'JSON (.json)' : 'Excel (.xlsx)'}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">{t('results.exportScopeLabel')}</p>
                  <label className="flex items-start gap-2 cursor-pointer rounded-md border border-border/60 p-2 hover:bg-muted/30">
                    <input
                      type="radio"
                      name="export-scope"
                      className="mt-1"
                      checked={exportScope === 'content'}
                      onChange={() => setExportScope('content')}
                    />
                    <span className="text-sm">
                      <span className="font-medium">{t('results.exportScopeContent')}</span>
                      <span className="block text-xs text-muted-foreground">{t('results.exportScopeContentHint')}</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer rounded-md border border-border/60 p-2 hover:bg-muted/30">
                    <input
                      type="radio"
                      name="export-scope"
                      className="mt-1"
                      checked={exportScope === 'full_messages'}
                      onChange={() => setExportScope('full_messages')}
                    />
                    <span className="text-sm">
                      <span className="font-medium">{t('results.exportScopeFullMessages')}</span>
                      <span className="block text-xs text-muted-foreground">{t('results.exportScopeFullMessagesHint')}</span>
                    </span>
                  </label>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleExport}>{t('results.exportConfirmAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Replay Dialog */}
      <Dialog open={replayDialogOpen} onOpenChange={(open) => {
        setReplayDialogOpen(open)
        if (!open) resetReplayTest()
      }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              {t('results.replayTitle')}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('onlineTest.batchTest.description')}</p>

            {/* Workspace selector for replay */}
            {workspaceOptions.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{t('onlineTest.guardrailConfig')}:</span>
                <Select value={selectedReplayWorkspaceId} onValueChange={setSelectedReplayWorkspaceId}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">
                      <div className="flex items-center gap-2">
                        <Globe className="h-3.5 w-3.5" />
                        <span>{t('workspaces.globalDefault', 'Default Workspace')}</span>
                      </div>
                    </SelectItem>
                    {workspaceOptions.filter(ws => !ws.is_global).map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>
                        <div className="flex items-center gap-2">
                          <FolderOpen className="h-3.5 w-3.5" />
                          <span>{ws.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleReplayFileUpload}
              className="hidden"
              id="replay-excel-upload"
            />

            {batchStatus === 'idle' && !batchFile ? (
              <label
                htmlFor="replay-excel-upload"
                className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-border rounded-lg cursor-pointer bg-secondary hover:bg-card/5 transition-colors"
              >
                <Upload className="h-8 w-8 text-slate-500 mb-2" />
                <span className="text-sm text-muted-foreground">{t('onlineTest.batchTest.uploadArea')}</span>
                <span className="text-xs text-slate-500 mt-1">{t('onlineTest.batchTest.uploadHint')}</span>
              </label>
            ) : (
              <div className="p-4 bg-secondary rounded-lg border border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileSpreadsheet className="h-8 w-8 text-emerald-400" />
                    <div>
                      <p className="text-sm font-medium text-slate-300">{batchFile?.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {batchData.length} {t('onlineTest.batchTest.rowCount')}
                      </p>
                    </div>
                  </div>
                  <span className={`px-3 py-1 text-xs font-medium rounded-full ${getReplayStatusColor(batchStatus)}`}>
                    {t(`onlineTest.batchTest.status.${batchStatus}`)}
                  </span>
                </div>

                {batchStatus === 'detecting' && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-sm text-muted-foreground mb-2">
                      <span>{t('onlineTest.batchTest.progress', { current: batchProgress.current, total: batchProgress.total })}</span>
                      <span>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</span>
                    </div>
                    <div className="w-full bg-border rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              {batchStatus === 'uploaded' && (
                <Button onClick={runBatchDetection} className="bg-blue-600 hover:bg-blue-700">
                  <Send className="h-4 w-4 mr-2" />
                  {t('onlineTest.batchTest.startDetection')}
                </Button>
              )}

              {batchStatus === 'detecting' && (
                <Button disabled className="bg-blue-600">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('onlineTest.batchTest.status.detecting')}
                </Button>
              )}

              {batchStatus === 'completed' && (
                <Button onClick={downloadReplayResults} className="bg-green-600 hover:bg-green-700">
                  <Download className="h-4 w-4 mr-2" />
                  {t('onlineTest.batchTest.downloadResult')}
                </Button>
              )}

              {(batchStatus === 'uploaded' || batchStatus === 'completed' || batchStatus === 'error') && (
                <Button variant="outline" onClick={resetReplayTest}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  {t('onlineTest.batchTest.reupload')}
                </Button>
              )}
            </div>

            {/* Results preview */}
            {batchResults.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <div className="p-3 bg-muted border-b">
                  <h4 className="font-medium text-sm">{t('onlineTest.testResult')}</h4>
                </div>
                <div className="overflow-x-auto max-h-[300px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-3 font-medium text-slate-300">#</th>
                        <th className="text-left py-2 px-3 font-medium text-slate-300">{t('onlineTest.batchTest.resultColumns.detectionContent')}</th>
                        <th className="text-left py-2 px-3 font-medium text-slate-300">{t('onlineTest.batchTest.resultColumns.overallRiskLevel')}</th>
                        <th className="text-left py-2 px-3 font-medium text-slate-300">{t('onlineTest.batchTest.resultColumns.action')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchResults.slice(0, 20).map((result, index) => (
                        <tr key={index} className="border-b border-border hover:bg-card/5">
                          <td className="py-2 px-3 text-muted-foreground">{index + 1}</td>
                          <td className="py-2 px-3 max-w-[300px] truncate" title={result.detection_content}>{result.detection_content}</td>
                          <td className="py-2 px-3">
                            <span className={`px-2 py-0.5 text-xs rounded border ${getReplayRiskBgColor(result.overall_risk_level)}`}>
                              {translateRiskLevel(result.overall_risk_level)}
                            </span>
                          </td>
                          <td className="py-2 px-3">
                            <span className={`px-2 py-0.5 text-xs rounded border ${
                              result.suggest_action === 'pass' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' :
                              result.suggest_action === 'reject' ? 'bg-red-500/10 border-red-500/20 text-red-300' :
                              'bg-orange-500/10 border-orange-500/20 text-orange-300'
                            }`}>
                              {result.suggest_action}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {batchResults.length > 20 && (
                    <p className="text-sm text-muted-foreground py-2 text-center">
                      {t('onlineTest.batchTest.progress', { current: 20, total: batchResults.length })} ...
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Results
