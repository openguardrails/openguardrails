import React, { useEffect, useState, useMemo } from 'react'
import { Edit, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { configApi, knowledgeBaseApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { ResponseTemplate } from '../../types'
import { eventBus, EVENTS } from '../../utils/eventBus'
import type { ColumnDef } from '@tanstack/react-table'
import { format } from 'date-fns'

const responseTemplateSchema = z.object({
  category: z.string(),
  template_content: z.string().min(1, 'Content is required').max(500),
})

type ResponseTemplateFormData = z.infer<typeof responseTemplateSchema>

const ResponseTemplateManagement: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [data, setData] = useState<ResponseTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<ResponseTemplate | null>(null)
  const { onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()
  const [currentLang, setCurrentLang] = useState(i18n.language || 'en')

  // Available scanners for template creation
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

  const form = useForm<ResponseTemplateFormData>({
    resolver: zodResolver(responseTemplateSchema),
    defaultValues: {
      category: '',
      template_content: '',
    },
  })

  const getRiskLevelLabel = (riskLevel: string) => {
    const riskLevelMap: { [key: string]: string } = {
      // English values (current format)
      high_risk: t('risk.level.high_risk'),
      medium_risk: t('risk.level.medium_risk'),
      low_risk: t('risk.level.low_risk'),
      no_risk: t('risk.level.no_risk'),
      // Chinese values (legacy format)
      高风险: t('risk.level.high_risk'),
      中风险: t('risk.level.medium_risk'),
      低风险: t('risk.level.low_risk'),
      无风险: t('risk.level.no_risk'),
    }
    return riskLevelMap[riskLevel] || riskLevel
  }

  const categories = [
    { value: 'S2', label: `S2 - ${t('category.S2')}`, riskLevel: 'high_risk' },
    { value: 'S3', label: `S3 - ${t('category.S3')}`, riskLevel: 'high_risk' },
    { value: 'S5', label: `S5 - ${t('category.S5')}`, riskLevel: 'high_risk' },
    { value: 'S9', label: `S9 - ${t('category.S9')}`, riskLevel: 'high_risk' },
    { value: 'S15', label: `S15 - ${t('category.S15')}`, riskLevel: 'high_risk' },
    { value: 'S17', label: `S17 - ${t('category.S17')}`, riskLevel: 'high_risk' },
    { value: 'S4', label: `S4 - ${t('category.S4')}`, riskLevel: 'medium_risk' },
    { value: 'S6', label: `S6 - ${t('category.S6')}`, riskLevel: 'medium_risk' },
    { value: 'S7', label: `S7 - ${t('category.S7')}`, riskLevel: 'medium_risk' },
    { value: 'S16', label: `S16 - ${t('category.S16')}`, riskLevel: 'medium_risk' },
    { value: 'S1', label: `S1 - ${t('category.S1')}`, riskLevel: 'low_risk' },
    { value: 'S8', label: `S8 - ${t('category.S8')}`, riskLevel: 'low_risk' },
    { value: 'S10', label: `S10 - ${t('category.S10')}`, riskLevel: 'low_risk' },
    { value: 'S11', label: `S11 - ${t('category.S11')}`, riskLevel: 'low_risk' },
    { value: 'S12', label: `S12 - ${t('category.S12')}`, riskLevel: 'low_risk' },
    { value: 'S13', label: `S13 - ${t('category.S13')}`, riskLevel: 'low_risk' },
    { value: 'S14', label: `S14 - ${t('category.S14')}`, riskLevel: 'low_risk' },
    { value: 'S18', label: `S18 - ${t('category.S18')}`, riskLevel: 'low_risk' },
    { value: 'S19', label: `S19 - ${t('category.S19')}`, riskLevel: 'low_risk' },
    { value: 'S20', label: `S20 - ${t('category.S20')}`, riskLevel: 'low_risk' },
    { value: 'S21', label: `S21 - ${t('category.S21')}`, riskLevel: 'low_risk' },
    { value: 'default', label: t('template.defaultReject'), riskLevel: 'no_risk' },
  ]

  useEffect(() => {
    if (currentApplicationId) {
      loadAllData()
    }
  }, [currentApplicationId])

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadAllData()
    })
    return unsubscribe
  }, [onUserSwitch])

  // Listen to scanner events from other components
  useEffect(() => {
    const handleScannerDeleted = (payload: { scannerId: string; scannerTag: string }) => {
      console.log('Scanner deleted event received in ResponseTemplateManagement:', payload)
      loadAllData()
    }

    const handleScannerCreated = () => {
      console.log('Scanner created event received in ResponseTemplateManagement')
      loadAllData()
    }

    const handleScannerUpdated = () => {
      console.log('Scanner updated event received in ResponseTemplateManagement')
      loadAllData()
    }

    const handleBlacklistDeleted = (payload: { blacklistId: string; blacklistName: string }) => {
      console.log('Blacklist deleted event received in ResponseTemplateManagement:', payload)
      loadAllData()
    }

    const handleBlacklistCreated = () => {
      console.log('Blacklist created event received in ResponseTemplateManagement')
      loadAllData()
    }

    const handleWhitelistDeleted = (payload: { whitelistId: string; whitelistName: string }) => {
      console.log('Whitelist deleted event received in ResponseTemplateManagement:', payload)
      loadAllData()
    }

    const handleWhitelistCreated = () => {
      console.log('Whitelist created event received in ResponseTemplateManagement')
      loadAllData()
    }

    const handleMarketplaceScannerPurchased = (payload: {
      packageId: string
      packageName: string
    }) => {
      console.log('Marketplace scanner purchased event received in ResponseTemplateManagement:', payload)
      loadAllData()
    }

    // Subscribe to all relevant events
    const unsubscribeScannerDeleted = eventBus.on(EVENTS.SCANNER_DELETED, handleScannerDeleted)
    const unsubscribeScannerCreated = eventBus.on(EVENTS.SCANNER_CREATED, handleScannerCreated)
    const unsubscribeScannerUpdated = eventBus.on(EVENTS.SCANNER_UPDATED, handleScannerUpdated)
    const unsubscribeBlacklistDeleted = eventBus.on(EVENTS.BLACKLIST_DELETED, handleBlacklistDeleted)
    const unsubscribeBlacklistCreated = eventBus.on(EVENTS.BLACKLIST_CREATED, handleBlacklistCreated)
    const unsubscribeWhitelistDeleted = eventBus.on(EVENTS.WHITELIST_DELETED, handleWhitelistDeleted)
    const unsubscribeWhitelistCreated = eventBus.on(EVENTS.WHITELIST_CREATED, handleWhitelistCreated)
    const unsubscribeMarketplaceScannerPurchased = eventBus.on(
      EVENTS.MARKETPLACE_SCANNER_PURCHASED,
      handleMarketplaceScannerPurchased
    )

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

  const loadAllData = async () => {
    await fetchAvailableScanners()
    await fetchData()
  }

  const fetchAvailableScanners = async () => {
    try {
      const result = await knowledgeBaseApi.getAvailableScanners()
      setAvailableScanners(result)
    } catch (error) {
      console.error('Error fetching available scanners:', error)
    }
  }

  // Listen to language change events to update currentLang state
  useEffect(() => {
    const handleLanguageChange = (lng: string) => {
      setCurrentLang(lng)
    }

    i18n.on('languageChanged', handleLanguageChange)

    return () => {
      i18n.off('languageChanged', handleLanguageChange)
    }
  }, [i18n])

  const fetchData = async () => {
    try {
      setLoading(true)
      const result = await configApi.responses.list()
      setData(result)
    } catch (error) {
      console.error('Error fetching response templates:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (record: ResponseTemplate) => {
    setEditingItem(record)

    // Get current language
    const currentLang = i18n.language || 'en'
    let currentContent = ''

    if (typeof record.template_content === 'string') {
      // Old format: single string
      currentContent = record.template_content
    } else if (typeof record.template_content === 'object') {
      // New format: JSON object with language keys
      currentContent = record.template_content[currentLang] || ''
    }

    // Prepare the display label for category field based on scanner type
    let categoryDisplayValue = record.category

    // For special scanner types (blacklist, custom_scanner, marketplace_scanner),
    // we need to set a display value since they don't use standard S1-S21 categories
    if (record.scanner_type === 'blacklist' && record.scanner_identifier) {
      categoryDisplayValue = `${t('config.blacklist')} - ${record.scanner_identifier}`
    } else if (record.scanner_type === 'custom_scanner' && record.scanner_identifier) {
      const displayText = record.scanner_name
        ? `${record.scanner_identifier} - ${record.scanner_name}`
        : record.scanner_identifier
      categoryDisplayValue = displayText
    } else if (record.scanner_type === 'marketplace_scanner' && record.scanner_identifier) {
      const displayText = record.scanner_name
        ? `${record.scanner_identifier} - ${record.scanner_name}`
        : record.scanner_identifier
      categoryDisplayValue = displayText
    }

    form.reset({
      category: categoryDisplayValue,
      template_content: currentContent,
    })
    setModalVisible(true)
  }

  const handleSubmit = async (values: ResponseTemplateFormData) => {
    try {
      if (!editingItem) {
        toast.error(t('template.invalidOperation'))
        return
      }

      // Get current language
      const currentLang = i18n.language || 'en'

      // Preserve existing content from other languages
      const existingContent =
        typeof editingItem.template_content === 'object' ? { ...editingItem.template_content } : {}

      // Update only the current language content
      const multilingualContent: Record<string, string> = {
        ...existingContent,
        [currentLang]: values.template_content,
      }

      // Validate that content is provided
      if (!values.template_content || !values.template_content.trim()) {
        toast.error(t('template.contentRequired'))
        return
      }

      // Update reject content, keep the original category and risk level
      const submissionData = {
        category: editingItem.category,
        scanner_type: editingItem.scanner_type,
        scanner_identifier: editingItem.scanner_identifier,
        risk_level: editingItem.risk_level,
        template_content: multilingualContent,
        is_default: editingItem.is_default,
        is_active: editingItem.is_active,
      }

      await configApi.responses.update(editingItem.id, submissionData)
      toast.success(t('template.updateSuccess'))

      setModalVisible(false)
      form.reset()
      await fetchData()
    } catch (error) {
      console.error('Error updating reject response:', error)
      toast.error(t('common.saveFailed'))
    }
  }

  const getCategoryLabel = (category: string) => {
    const item = categories.find((c) => c.value === category)
    return item?.label || category
  }

  const getRiskBadgeVariant = (
    riskLevel: string
  ): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (riskLevel === 'high_risk' || riskLevel === '高风险') return 'destructive'
    if (riskLevel === 'medium_risk' || riskLevel === '中风险') return 'default'
    if (riskLevel === 'low_risk' || riskLevel === '低风险') return 'secondary'
    return 'outline'
  }

  const getScannerBadgeVariant = (
    scannerType: string
  ): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (scannerType === 'blacklist') return 'destructive'
    if (scannerType === 'whitelist') return 'outline'
    if (scannerType === 'custom_scanner') return 'secondary'
    if (scannerType === 'official_scanner' || scannerType === 'marketplace_scanner') return 'default'
    return 'secondary'
  }

  // Use useMemo to ensure columns re-render when language changes
  const columns: ColumnDef<ResponseTemplate>[] = useMemo(
    () => [
      {
        accessorKey: 'category',
        header: t('template.riskCategory'),
        cell: ({ row }) => {
          const record = row.original
          const category = row.getValue('category') as string

          // If scanner_type is blacklist, show blacklist name
          if (record.scanner_type === 'blacklist' && record.scanner_identifier) {
            return (
              <Badge variant="destructive">
                {t('config.blacklist')} - {record.scanner_identifier}
              </Badge>
            )
          }
          // If scanner_type is whitelist, show whitelist name
          if (record.scanner_type === 'whitelist' && record.scanner_identifier) {
            return (
              <Badge variant="outline">
                {t('config.whitelist')} - {record.scanner_identifier}
              </Badge>
            )
          }
          // If scanner_type is custom_scanner, show "tag - name"
          if (record.scanner_type === 'custom_scanner' && record.scanner_identifier) {
            const displayText = record.scanner_name
              ? `${record.scanner_identifier} - ${record.scanner_name}`
              : record.scanner_identifier
            return <Badge variant="secondary">{displayText}</Badge>
          }
          // If scanner_type is official_scanner or marketplace_scanner, show "tag - name"
          if (
            (record.scanner_type === 'official_scanner' ||
              record.scanner_type === 'marketplace_scanner') &&
            record.scanner_identifier
          ) {
            const displayText = record.scanner_name
              ? `${record.scanner_identifier} - ${record.scanner_name}`
              : record.scanner_identifier
            return <Badge variant="default">{displayText}</Badge>
          }
          // Otherwise show standard category
          return (
            <Badge variant={category === 'default' ? 'default' : 'secondary'}>
              {getCategoryLabel(category)}
            </Badge>
          )
        },
      },
      {
        accessorKey: 'risk_level',
        header: t('results.riskLevel'),
        cell: ({ row }) => {
          const riskLevel = row.getValue('risk_level') as string
          const actualRiskLevel = riskLevel || 'no_risk'

          return (
            <Badge variant={getRiskBadgeVariant(actualRiskLevel)}>
              {getRiskLevelLabel(actualRiskLevel)}
            </Badge>
          )
        },
      },
      {
        accessorKey: 'template_content',
        header: t('template.rejectContent'),
        cell: ({ row }) => {
          const content = row.getValue('template_content') as any
          const record = row.original
          let displayText = ''

          if (typeof content === 'string') {
            displayText = content
          } else if (typeof content === 'object') {
            const displayContent = content[currentLang]

            if (displayContent) {
              displayText = displayContent
            } else {
              const availableLangs = Object.keys(content)
              if (availableLangs.length > 0) {
                return (
                  <span className="text-gray-400 italic">
                    {t('template.noContentForLanguage', {
                      language: currentLang === 'zh' ? '中文' : 'English',
                    })}{' '}
                    ({t('template.clickEditToAdd')})
                  </span>
                )
              }
              return ''
            }
          }

          // Replace {scanner_name} placeholder with actual scanner name (not tag)
          if (displayText) {
            if (record.scanner_type === 'blacklist' || record.scanner_type === 'whitelist') {
              displayText = displayText.replace(/{scanner_name}/g, record.scanner_identifier || '')
            } else if (record.scanner_name) {
              displayText = displayText.replace(/{scanner_name}/g, record.scanner_name)
            } else if (record.scanner_identifier) {
              displayText = displayText.replace(/{scanner_name}/g, record.scanner_identifier)
            }
          }

          return (
            <span className="truncate max-w-[400px] block" title={displayText}>
              {displayText || ''}
            </span>
          )
        },
      },
      {
        accessorKey: 'updated_at',
        header: t('common.updatedAt'),
        cell: ({ row }) => {
          const time = row.getValue('updated_at') as string
          return format(new Date(time), 'yyyy-MM-dd HH:mm:ss')
        },
      },
      {
        id: 'actions',
        header: t('common.operation'),
        cell: ({ row }) => {
          const record = row.original
          return (
            <Button variant="link" size="sm" onClick={() => handleEdit(record)} className="h-auto p-0">
              <Edit className="mr-1 h-4 w-4" />
              {t('template.editRejectContent')}
            </Button>
          )
        },
      },
    ],
    [currentLang, t]
  )

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{t('template.rejectAnswerLibrary')}</h2>
          <p className="text-gray-600 mt-2">{t('template.rejectAnswerDescription')}</p>
        </div>
        <Button onClick={loadAllData} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('common.refresh')}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={data} loading={loading} pagination={false} />
        </CardContent>
      </Card>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{t('template.editRejectContent')}</DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('template.riskCategory')}</FormLabel>
                    <FormControl>
                      <Input {...field} disabled />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="template_content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('template.rejectContent')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={6}
                        placeholder={
                          i18n.language === 'zh'
                            ? t('template.rejectContentPlaceholderZh')
                            : t('template.rejectContentPlaceholderEn')
                        }
                        maxLength={500}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('template.editLanguageHint', {
                        language: i18n.language === 'zh' ? '中文' : 'English',
                      })}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setModalVisible(false)
                    form.reset()
                  }}
                >
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

export default ResponseTemplateManagement
