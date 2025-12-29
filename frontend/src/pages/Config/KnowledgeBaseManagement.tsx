import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Edit2, Trash2, Upload as UploadIcon, Search, Info, RefreshCw } from 'lucide-react'
import { knowledgeBaseApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { KnowledgeBase, SimilarQuestionResult } from '../../types'
import { eventBus, EVENTS } from '../../utils/eventBus'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { confirmDialog } from '@/utils/confirm-dialog'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ColumnDef } from '@tanstack/react-table'

const KnowledgeBaseManagement: React.FC = () => {
  const { t } = useTranslation()
  const [data, setData] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<KnowledgeBase | null>(null)
  const [fileUploadLoading, setFileUploadLoading] = useState(false)
  const [fileReplaceModalVisible, setFileReplaceModalVisible] = useState(false)
  const [replacingKb, setReplacingKb] = useState<KnowledgeBase | null>(null)
  const [searchModalVisible, setSearchModalVisible] = useState(false)
  const [searchingKb, setSearchingKb] = useState<KnowledgeBase | null>(null)
  const [searchResults, setSearchResults] = useState<SimilarQuestionResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [replaceFile, setReplaceFile] = useState<File | null>(null)
  const { user, onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()

  // Available scanners for knowledge base creation
  const [availableScanners, setAvailableScanners] = useState<{
    blacklists: Array<{ value: string; label: string }>
    whitelists: Array<{ value: string; label: string }>
    official_scanners: Array<{ value: string; label: string }>
    marketplace_scanners: Array<{ value: string; label: string }>
    custom_scanners: Array<{ value: string; label: string }>
  }>({
    blacklists: [],
    whitelists: [],
    official_scanners: [],
    marketplace_scanners: [],
    custom_scanners: [],
  })

  // Selected scanner type
  const [selectedScannerType, setSelectedScannerType] = useState<string>('official_scanner')

  const categories = [
    { value: 'S1', label: `S1 - ${t('category.S1')}` },
    { value: 'S2', label: `S2 - ${t('category.S2')}` },
    { value: 'S3', label: `S3 - ${t('category.S3')}` },
    { value: 'S4', label: `S4 - ${t('category.S4')}` },
    { value: 'S5', label: `S5 - ${t('category.S5')}` },
    { value: 'S6', label: `S6 - ${t('category.S6')}` },
    { value: 'S7', label: `S7 - ${t('category.S7')}` },
    { value: 'S8', label: `S8 - ${t('category.S8')}` },
    { value: 'S9', label: `S9 - ${t('category.S9')}` },
    { value: 'S10', label: `S10 - ${t('category.S10')}` },
    { value: 'S11', label: `S11 - ${t('category.S11')}` },
    { value: 'S12', label: `S12 - ${t('category.S12')}` },
    { value: 'S13', label: `S13 - ${t('category.S13')}` },
    { value: 'S14', label: `S14 - ${t('category.S14')}` },
    { value: 'S15', label: `S15 - ${t('category.S15')}` },
    { value: 'S16', label: `S16 - ${t('category.S16')}` },
    { value: 'S17', label: `S17 - ${t('category.S17')}` },
    { value: 'S18', label: `S18 - ${t('category.S18')}` },
    { value: 'S19', label: `S19 - ${t('category.S19')}` },
    { value: 'S20', label: `S20 - ${t('category.S20')}` },
    { value: 'S21', label: `S21 - ${t('category.S21')}` },
  ]

  useEffect(() => {
    if (currentApplicationId) {
      fetchData()
      fetchAvailableScanners()
    }
  }, [currentApplicationId])

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchData()
      fetchAvailableScanners()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Listen to scanner events from other components
  useEffect(() => {
    const handleScannerDeleted = (payload: { scannerId: string; scannerTag: string }) => {
      fetchAvailableScanners()
      fetchData()
    }

    const handleScannerCreated = () => {
      fetchAvailableScanners()
    }

    const handleScannerUpdated = () => {
      fetchAvailableScanners()
    }

    const handleBlacklistDeleted = (payload: { blacklistId: string; blacklistName: string }) => {
      fetchAvailableScanners()
      fetchData()
    }

    const handleBlacklistCreated = () => {
      fetchAvailableScanners()
    }

    const handleWhitelistDeleted = (payload: { whitelistId: string; whitelistName: string }) => {
      fetchAvailableScanners()
      fetchData()
    }

    const handleWhitelistCreated = () => {
      fetchAvailableScanners()
    }

    const handleMarketplaceScannerPurchased = (payload: { packageId: string; packageName: string }) => {
      fetchAvailableScanners()
    }

    // Subscribe to all relevant events
    const unsubscribeScannerDeleted = eventBus.on(EVENTS.SCANNER_DELETED, handleScannerDeleted)
    const unsubscribeScannerCreated = eventBus.on(EVENTS.SCANNER_CREATED, handleScannerCreated)
    const unsubscribeScannerUpdated = eventBus.on(EVENTS.SCANNER_UPDATED, handleScannerUpdated)
    const unsubscribeBlacklistDeleted = eventBus.on(EVENTS.BLACKLIST_DELETED, handleBlacklistDeleted)
    const unsubscribeBlacklistCreated = eventBus.on(EVENTS.BLACKLIST_CREATED, handleBlacklistCreated)
    const unsubscribeWhitelistDeleted = eventBus.on(EVENTS.WHITELIST_DELETED, handleWhitelistDeleted)
    const unsubscribeWhitelistCreated = eventBus.on(EVENTS.WHITELIST_CREATED, handleWhitelistCreated)
    const unsubscribeMarketplaceScannerPurchased = eventBus.on(EVENTS.MARKETPLACE_SCANNER_PURCHASED, handleMarketplaceScannerPurchased)

    // Cleanup subscriptions on unmount
    return () => {
      unsubscribeScannerDeleted()
      unsubscribeScannerCreated()
      unsubscribeScannerUpdated()
      unsubscribeBlacklistDeleted()
      unsubscribeBlacklistCreated()
      unsubscribeWhitelistDeleted()
      unsubscribeWhitelistCreated()
      unsubscribeMarketplaceScannerPurchased()
    }
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      const result = await knowledgeBaseApi.list()
      setData(result)
    } catch (error) {
      console.error('Error fetching knowledge bases:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchAvailableScanners = async () => {
    try {
      const result = await knowledgeBaseApi.getAvailableScanners()
      setAvailableScanners(result)
    } catch (error) {
      console.error('Error fetching available scanners:', error)
    }
  }

  const handleAdd = async () => {
    setEditingItem(null)
    form.reset()
    setSelectedFile(null)
    setSelectedScannerType('official_scanner')
    await fetchAvailableScanners()
    setModalVisible(true)
  }

  const handleEdit = (record: KnowledgeBase) => {
    setEditingItem(record)
    form.reset({
      category: record.category,
      name: record.name,
      description: record.description,
      similarity_threshold: record.similarity_threshold,
      is_active: record.is_active,
      is_global: record.is_global,
    })
    setModalVisible(true)
  }

  // Strict file content validation
  const validateTextFile = async (file: File): Promise<boolean> => {
    try {
      const text = await file.text()

      if (!text.trim()) {
        toast.error(t('knowledge.emptyFile'))
        return false
      }

      const lines = text.trim().split('\n').filter((line) => line.trim())

      if (lines.length === 0) {
        toast.error(t('knowledge.emptyFile'))
        return false
      }

      // Strictly validate the first few lines (up to 5 lines)
      const linesToCheck = Math.min(5, lines.length)
      let validLines = 0

      for (let i = 0; i < linesToCheck; i++) {
        const line = lines[i].trim()

        // Check if it is a JSON format
        if (!line.startsWith('{') || !line.endsWith('}')) {
          toast.error(t('knowledge.formatError', { line: i + 1, error: t('knowledge.invalidJSON') }))
          return false
        }

        try {
          const jsonObj = JSON.parse(line)

          // Check required fields
          if (!jsonObj.questionid || !jsonObj.question || !jsonObj.answer) {
            toast.error(t('knowledge.missingFields', { line: i + 1 }))
            return false
          }

          // Check field types
          if (typeof jsonObj.questionid !== 'string' || typeof jsonObj.question !== 'string' || typeof jsonObj.answer !== 'string') {
            toast.error(t('knowledge.invalidFieldType', { line: i + 1 }))
            return false
          }

          // Check content is not empty
          if (!jsonObj.question.trim() || !jsonObj.answer.trim()) {
            toast.error(t('knowledge.emptyContent', { line: i + 1 }))
            return false
          }

          validLines++
        } catch (parseError: any) {
          toast.error(t('knowledge.parseError', { line: i + 1, error: parseError.message }))
          return false
        }
      }

      if (validLines === 0) {
        toast.error(t('knowledge.noValidPairs'))
        return false
      }

      toast.success(t('knowledge.validationSuccess', { count: validLines }))
      return true
    } catch (error) {
      toast.error(t('knowledge.readFileFailed'))
      return false
    }
  }

  const formSchema = z.object({
    scanner_type: editingItem ? z.string().optional() : z.string().min(1, t('knowledge.selectScannerType')),
    scanner_identifier: editingItem ? z.string().optional() : z.string().min(1, t('knowledge.selectScanner')),
    name: z.string().min(1, t('knowledge.knowledgeBaseNameRequired')),
    description: z.string().optional(),
    similarity_threshold: z.number().min(0).max(1),
    is_active: z.boolean().optional(),
    is_global: z.boolean().optional(),
  })

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      scanner_type: 'official_scanner',
      scanner_identifier: '',
      name: '',
      description: '',
      similarity_threshold: 0.7,
      is_active: true,
      is_global: false,
    },
  })

  const handleSubmit = async (values: any) => {
    try {
      if (editingItem) {
        await knowledgeBaseApi.update(editingItem.id, values)
        toast.success(t('common.updateSuccess'))
      } else {
        // Creating a knowledge base requires file upload
        if (!selectedFile) {
          toast.error(t('knowledge.selectFile'))
          return
        }

        // Validate file content
        const isValid = await validateTextFile(selectedFile)
        if (!isValid) {
          return
        }

        const formData = new FormData()
        formData.append('file', selectedFile)

        // Support both old (category) and new (scanner_type + scanner_identifier) formats
        if (values.scanner_type && values.scanner_identifier) {
          formData.append('scanner_type', values.scanner_type)
          formData.append('scanner_identifier', values.scanner_identifier)
        } else if (values.category) {
          formData.append('category', values.category)
        }

        formData.append('name', values.name)
        formData.append('description', values.description || '')
        formData.append('similarity_threshold', values.similarity_threshold?.toString() || '0.7')
        formData.append('is_active', values.is_active ? 'true' : 'false')
        formData.append('is_global', values.is_global ? 'true' : 'false')

        setFileUploadLoading(true)
        await knowledgeBaseApi.create(formData)
        toast.success(t('knowledge.uploadSuccess'))
      }

      setModalVisible(false)
      setSelectedScannerType('official_scanner')
      setSelectedFile(null)
      fetchData()
    } catch (error: any) {
      console.error('Error saving knowledge base:', error)
      toast.error(error.response?.data?.detail || t('common.saveFailed'))
    } finally {
      setFileUploadLoading(false)
    }
  }

  const handleDelete = async (record: KnowledgeBase) => {
    const confirmed = await confirmDialog({
      title: t('knowledge.deleteConfirmKB', { name: record.name }),
      description: t('common.deleteWarning'),
    })

    if (!confirmed) return

    try {
      await knowledgeBaseApi.delete(record.id)
      toast.success(t('knowledge.deleteSuccess'))
      fetchData()
    } catch (error) {
      console.error('Error deleting knowledge base:', error)
      toast.error(t('knowledge.deleteFailed'))
    }
  }

  const handleToggleDisable = async (record: KnowledgeBase) => {
    try {
      await knowledgeBaseApi.toggleDisable(record.id)
      const action = record.is_disabled_by_me ? 'enabled' : 'disabled'
      toast.success(t(`knowledge.${action}Success`) || `Global knowledge base ${action} successfully`)
      fetchData()
    } catch (error: any) {
      console.error('Error toggling knowledge base disable:', error)
      toast.error(error.response?.data?.detail || t('knowledge.toggleFailed') || 'Failed to toggle knowledge base')
    }
  }

  const handleReplaceFile = (record: KnowledgeBase) => {
    setReplacingKb(record)
    setReplaceFile(null)
    setFileReplaceModalVisible(true)
  }

  const handleFileReplace = async () => {
    if (!replacingKb || !replaceFile) {
      toast.error(t('knowledge.selectFile'))
      return
    }

    // Validate file content
    const isValid = await validateTextFile(replaceFile)
    if (!isValid) {
      return
    }

    try {
      setFileUploadLoading(true)
      await knowledgeBaseApi.replaceFile(replacingKb.id, replaceFile)
      toast.success(t('knowledge.replaceSuccess'))
      setFileReplaceModalVisible(false)
      setReplaceFile(null)
      fetchData()
    } catch (error: any) {
      console.error('Error replacing file:', error)
      toast.error(error.response?.data?.detail || t('knowledge.replaceFailed'))
    } finally {
      setFileUploadLoading(false)
    }
  }

  const handleSearch = (record: KnowledgeBase) => {
    setSearchingKb(record)
    setSearchResults([])
    setSearchQuery('')
    setSearchModalVisible(true)
  }

  const handleSearchQuery = async () => {
    if (!searchingKb || !searchQuery.trim()) {
      toast.error(t('knowledge.enterSearchContent'))
      return
    }

    try {
      setSearchLoading(true)
      const results = await knowledgeBaseApi.search(searchingKb.id, searchQuery.trim(), 5)
      setSearchResults(results)
      if (results.length === 0) {
        toast.info(t('knowledge.noSimilarQuestions'))
      }
    } catch (error: any) {
      console.error('Error searching knowledge base:', error)
      toast.error(error.response?.data?.detail || t('knowledge.searchFailed'))
    } finally {
      setSearchLoading(false)
    }
  }

  const getCategoryLabel = (kb: KnowledgeBase) => {
    // Handle new scanner type format
    if (kb.scanner_type) {
      switch (kb.scanner_type) {
        case 'blacklist':
          return kb.scanner_identifier ? `${t('config.blacklist')} - ${kb.scanner_identifier}` : t('config.blacklist') || 'Blacklist'
        case 'whitelist':
          return kb.scanner_identifier ? `${t('config.whitelist')} - ${kb.scanner_identifier}` : t('config.whitelist') || 'Whitelist'
        case 'official_scanner':
          if (kb.scanner_identifier) {
            const item = categories.find((c) => c.value === kb.scanner_identifier)
            if (item) {
              return item.label
            }
            if (kb.scanner_name) {
              return `${kb.scanner_identifier} - ${kb.scanner_name}`
            }
            return kb.scanner_identifier
          }
          return t('scannerPackages.builtinPackages') || 'Built-in Scanner'
        case 'marketplace_scanner':
          if (kb.scanner_identifier && kb.scanner_name) {
            return `${kb.scanner_identifier} - ${kb.scanner_name}`
          }
          return kb.scanner_identifier || (t('scannerPackages.purchasedPackages') || 'Premium Scanner')
        case 'custom_scanner':
          if (kb.scanner_identifier && kb.scanner_name) {
            return `${kb.scanner_identifier} - ${kb.scanner_name}`
          }
          return kb.scanner_identifier || (t('customScanners.title') || 'Custom Scanner')
        default:
          return kb.scanner_type
      }
    }

    // Fallback to legacy category field
    if (kb.category) {
      const item = categories.find((c) => c.value === kb.category)
      return item?.label || kb.category
    }

    return '-'
  }

  const getFileName = (filePath: string) => {
    if (!filePath) return '-'
    const parts = filePath.split('/')
    const fileName = parts[parts.length - 1]
    const match = fileName.match(/^kb_\d+_(.+)$/)
    return match ? match[1] : fileName
  }

  const columns: ColumnDef<KnowledgeBase>[] = [
    {
      accessorKey: 'category',
      header: t('results.category'),
      cell: ({ row }) => <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200">{getCategoryLabel(row.original)}</Badge>,
    },
    {
      accessorKey: 'name',
      header: t('knowledge.knowledgeBaseName'),
      cell: ({ row }) => <div className="truncate max-w-xs">{row.original.name}</div>,
    },
    {
      accessorKey: 'description',
      header: t('common.description'),
      cell: ({ row }) => <div className="truncate max-w-xs">{row.original.description || '-'}</div>,
    },
    {
      accessorKey: 'file_path',
      header: t('knowledge.fileName'),
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger>
            <div className="truncate max-w-xs">{getFileName(row.original.file_path)}</div>
          </TooltipTrigger>
          <TooltipContent>{getFileName(row.original.file_path)}</TooltipContent>
        </Tooltip>
      ),
    },
    {
      accessorKey: 'total_qa_pairs',
      header: t('knowledge.qaPairsCount'),
      cell: ({ row }) => <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">{row.original.total_qa_pairs}</Badge>,
    },
    {
      accessorKey: 'similarity_threshold',
      header: t('knowledge.similarityThreshold'),
      cell: ({ row }) => (
        <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200">
          {(row.original.similarity_threshold * 100).toFixed(0)}%
        </Badge>
      ),
    },
    {
      accessorKey: 'is_active',
      header: t('common.status'),
      cell: ({ row }) => {
        if (row.original.is_global && row.original.is_disabled_by_me) {
          return (
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="secondary" className="bg-orange-100 text-orange-800 border-orange-200">
                  {t('common.disabled')}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t('knowledge.disabledByYou') || 'Disabled by you'}</TooltipContent>
            </Tooltip>
          )
        }
        return (
          <Badge variant={row.original.is_active ? 'secondary' : 'destructive'} className={row.original.is_active ? 'bg-green-100 text-green-800 border-green-200' : ''}>
            {row.original.is_active ? t('common.enabled') : t('common.disabled')}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'is_global',
      header: t('entityType.sourceColumn'),
      cell: ({ row }) => (
        <Badge variant={row.original.is_global ? 'secondary' : 'default'} className={row.original.is_global ? 'bg-blue-100 text-blue-800 border-blue-200' : ''}>
          {row.original.is_global ? t('entityType.system') : t('entityType.custom')}
        </Badge>
      ),
    },
    {
      accessorKey: 'created_at',
      header: t('common.createdAt'),
      cell: ({ row }) => new Date(row.original.created_at).toLocaleString(),
    },
    {
      id: 'actions',
      header: t('common.operation'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2 flex-wrap">
          {(!row.original.is_global || user?.is_super_admin) && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => handleEdit(row.original)}>
                    <Edit2 className="h-4 w-4 mr-1" />
                    {t('common.edit')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('knowledge.editBasicInfo')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => handleReplaceFile(row.original)}>
                    <UploadIcon className="h-4 w-4 mr-1" />
                    {t('knowledge.replaceFile')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('knowledge.replaceKBFile')}</TooltipContent>
              </Tooltip>
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={() => handleSearch(row.original)}>
                <Search className="h-4 w-4 mr-1" />
                {t('knowledge.searchTest')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('knowledge.searchTest')}</TooltipContent>
          </Tooltip>
          {row.original.is_global ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => handleToggleDisable(row.original)}>
                {row.original.is_disabled_by_me ? t('common.enable') : t('common.disable')}
              </Button>
              {user?.is_super_admin && (
                <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => handleDelete(row.original)}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  {t('common.delete')}
                </Button>
              )}
            </>
          ) : (
            <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => handleDelete(row.original)}>
              <Trash2 className="h-4 w-4 mr-1" />
              {t('common.delete')}
            </Button>
          )}
        </div>
      ),
    },
  ]

  const currentScanners =
    selectedScannerType === 'official_scanner'
      ? availableScanners.official_scanners
      : selectedScannerType === 'blacklist'
        ? availableScanners.blacklists
        : selectedScannerType === 'marketplace_scanner'
          ? availableScanners.marketplace_scanners
          : availableScanners.custom_scanners

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>{t('knowledge.knowledgeBaseManagement')}</CardTitle>
            <p className="text-sm text-gray-600 mt-1">{t('knowledge.knowledgeBaseDescription')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                await fetchAvailableScanners()
                await fetchData()
              }}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
            <Button onClick={handleAdd}>
              <Plus className="h-4 w-4 mr-1" />
              {t('knowledge.addKnowledgeBase')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="font-medium text-blue-900 mb-2">{t('knowledge.fileFormatDescription')}</p>
            <p className="text-sm text-blue-800 mb-2">{t('knowledge.fileFormatDetails')}</p>
            <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto">
              {`{"questionid": "Unique question ID", "question": "Question content", "answer": "Answer content"}`}
            </pre>
            <p className="text-sm text-blue-800 mt-2 flex items-center gap-2">
              <Info className="h-4 w-4" />
              {t('knowledge.fileFormatNote')}
            </p>
          </div>

          <DataTable columns={columns} data={data} loading={loading} />
        </CardContent>
      </Card>

      {/* Add/edit knowledge base modal */}
      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? t('knowledge.editKnowledgeBase') : t('knowledge.addKnowledgeBase')}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="scanner_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('knowledge.scannerType') || 'Scanner Type'}</FormLabel>
                    <Select
                      onValueChange={(value) => {
                        field.onChange(value)
                        setSelectedScannerType(value)
                        form.setValue('scanner_identifier', '')
                      }}
                      value={field.value}
                      disabled={!!editingItem}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('knowledge.selectScannerTypePlaceholder') || 'Select scanner type'} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="official_scanner">{t('scannerPackages.builtinPackages') || 'Basic Package'}</SelectItem>
                        <SelectItem value="marketplace_scanner">{t('scannerPackages.purchasedPackages') || 'Premium Package'}</SelectItem>
                        <SelectItem value="custom_scanner">{t('customScanners.title') || 'Custom Scanners'}</SelectItem>
                        <SelectItem value="blacklist">{t('config.blacklist') || 'Blacklist'}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="scanner_identifier"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('knowledge.scanner') || 'Scanner'}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={!!editingItem}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('knowledge.selectScannerPlaceholder') || 'Select scanner'} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {currentScanners.map((scanner) => (
                          <SelectItem key={scanner.value} value={scanner.value}>
                            {scanner.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedScannerType === 'marketplace_scanner' && availableScanners.marketplace_scanners.length === 0 && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="font-medium text-blue-900 mb-1">{t('knowledge.noPurchasedScannersTitle') || 'No Purchased Premium Scanners'}</p>
                  <p className="text-sm text-blue-800">
                    {t('knowledge.noPurchasedScannersDescription') || "You haven't purchased any premium scanner packages yet. "}
                    <a href="/platform/config/official-scanners#marketplace" target="_blank" rel="noopener noreferrer" className="underline">
                      {t('knowledge.goToMarketplace') || 'Go to Marketplace'}
                    </a>
                    {t('knowledge.toBrowseAndPurchase') || ' to browse and purchase scanner packages.'}
                  </p>
                </div>
              )}

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('knowledge.knowledgeBaseName')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('knowledge.knowledgeBaseNamePlaceholder')} {...field} />
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
                    <FormLabel>{t('common.description')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} placeholder={t('knowledge.descriptionPlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="similarity_threshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t('knowledge.similarityThreshold')}
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-4 w-4" />
                        </TooltipTrigger>
                        <TooltipContent>{t('knowledge.similarityThresholdTooltip')}</TooltipContent>
                      </Tooltip>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        placeholder={t('knowledge.similarityThresholdPlaceholder')}
                        {...field}
                        onChange={(e) => field.onChange(parseFloat(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {!editingItem && (
                <div>
                  <Label>{t('knowledge.file')}</Label>
                  <div className="mt-2">
                    <Input
                      type="file"
                      accept="*"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          setSelectedFile(file)
                        }
                      }}
                    />
                    {selectedFile && <p className="text-sm text-gray-600 mt-1">{selectedFile.name}</p>}
                  </div>
                </div>
              )}

              <FormField
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between p-4 border rounded-lg">
                    <FormLabel>{t('knowledge.enableStatus')}</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              {user?.is_super_admin && (
                <FormField
                  control={form.control}
                  name="is_global"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between p-4 border rounded-lg">
                      <FormLabel className="flex items-center gap-2">
                        {t('knowledge.globalKnowledgeBase')}
                        <Tooltip>
                          <TooltipTrigger>
                            <Info className="h-4 w-4" />
                          </TooltipTrigger>
                          <TooltipContent>{t('knowledge.globalKnowledgeBaseTooltip')}</TooltipContent>
                        </Tooltip>
                      </FormLabel>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setModalVisible(false)
                    setSelectedScannerType('official_scanner')
                    setSelectedFile(null)
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={fileUploadLoading}>
                  {fileUploadLoading ? t('common.saving') : t('common.save')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Replace file modal */}
      <Dialog open={fileReplaceModalVisible} onOpenChange={setFileReplaceModalVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('knowledge.replaceFileTitle', { name: replacingKb?.name })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="font-medium text-yellow-900 mb-1">{t('knowledge.attention')}</p>
              <p className="text-sm text-yellow-800">{t('knowledge.replaceFileWarning')}</p>
            </div>
            <div>
              <Label>{t('knowledge.selectNewFile')}</Label>
              <div className="mt-2">
                <Input
                  type="file"
                  accept="*"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      setReplaceFile(file)
                    }
                  }}
                />
                {replaceFile && <p className="text-sm text-gray-600 mt-1">{replaceFile.name}</p>}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setFileReplaceModalVisible(false)
                setReplaceFile(null)
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleFileReplace} disabled={fileUploadLoading}>
              {fileUploadLoading ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Search test modal */}
      <Dialog open={searchModalVisible} onOpenChange={setSearchModalVisible}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('knowledge.searchTestTitle', { name: searchingKb?.name })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                placeholder={t('knowledge.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSearchQuery()
                  }
                }}
              />
              <Button onClick={handleSearchQuery} disabled={searchLoading}>
                {searchLoading ? t('common.searching') : t('common.search')}
              </Button>
            </div>

            {searchResults.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-semibold">{t('knowledge.searchResults')}</h4>
                {searchResults.map((result, index) => (
                  <Card key={index}>
                    <CardContent className="pt-4 space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200">
                          {t('knowledge.similarity', { score: (result.similarity_score * 100).toFixed(1) })}
                        </Badge>
                        <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                          {t('knowledge.rank', { rank: result.rank })}
                        </Badge>
                      </div>
                      <div>
                        <strong>{t('knowledge.questionLabel')}</strong>
                        {result.question}
                      </div>
                      <div>
                        <strong>{t('knowledge.answerLabel')}</strong>
                        {result.answer}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default KnowledgeBaseManagement
