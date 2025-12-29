import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Edit2, Trash2, RefreshCw, Crown, Lock, ChevronDown } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { customScannersApi } from '../../services/api'
import { useApplication } from '../../contexts/ApplicationContext'
import { eventBus, EVENTS } from '../../utils/eventBus'
import { billingService } from '../../services/billing'
import { features } from '../../config'
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ColumnDef } from '@tanstack/react-table'

interface CustomScanner {
  id: string
  custom_scanner_id: string
  tag: string
  name: string
  description?: string
  scanner_type: string
  definition: string
  default_risk_level: string
  default_scan_prompt: boolean
  default_scan_response: boolean
  notes?: string
  created_by: string
  created_at?: string
  updated_at?: string
  is_enabled?: boolean
}

const CustomScannersManagement: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentApplicationId } = useApplication()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scanners, setScanners] = useState<CustomScanner[]>([])
  const [modalVisible, setModalVisible] = useState(false)
  const [editingScanner, setEditingScanner] = useState<CustomScanner | null>(null)
  const [isSubscribed, setIsSubscribed] = useState<boolean | null>(null)
  const [subscriptionLoading, setSubscriptionLoading] = useState(true)
  const [guideOpen, setGuideOpen] = useState(false)

  useEffect(() => {
    // In enterprise mode, all features are available
    if (features.showSubscription()) {
      checkSubscription()
    } else {
      setIsSubscribed(true) // Enterprise mode has all features
      setSubscriptionLoading(false)
    }

    if (currentApplicationId) {
      loadData()
    }
  }, [currentApplicationId])

  const checkSubscription = async () => {
    try {
      setSubscriptionLoading(true)
      const subscription = await billingService.getCurrentSubscription()
      setIsSubscribed(subscription?.subscription_type === 'subscribed')
    } catch (error) {
      console.error('Failed to check subscription:', error)
      setIsSubscribed(false)
    } finally {
      setSubscriptionLoading(false)
    }
  }

  const loadData = async () => {
    try {
      setLoading(true)
      const scannersData = await customScannersApi.getAll()
      setScanners(scannersData)
    } catch (error: any) {
      // Handle 403 subscription error gracefully
      if (error.response?.status === 403) {
        setScanners([])
        // Don't show error message, the UI will show the upgrade prompt
      } else {
        toast.error(t('customScanners.loadFailed'))
        console.error('Failed to load custom scanners:', error)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    if (!isSubscribed) {
      showUpgradeDialog()
      return
    }
    setEditingScanner(null)
    form.reset()
    setModalVisible(true)
  }

  const showUpgradeDialog = async () => {
    const confirmed = await confirmDialog({
      title: t('customScanners.premiumFeature'),
      description: (
        <div className="space-y-4">
          <p className="text-base">{t('customScanners.premiumFeatureDesc')}</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>{t('customScanners.feature1')}</li>
            <li>{t('customScanners.feature2')}</li>
            <li>{t('customScanners.feature3')}</li>
            <li>{t('customScanners.feature4')}</li>
          </ul>
        </div>
      ),
      confirmText: t('customScanners.upgradeNow'),
      icon: <Crown className="h-6 w-6 text-yellow-500" />,
    })

    if (confirmed) {
      navigate('/subscription')
    }
  }

  const handleEdit = (scanner: CustomScanner) => {
    setEditingScanner(scanner)
    form.reset({
      scanner_type: scanner.scanner_type,
      name: scanner.name,
      definition: scanner.definition,
      risk_level: scanner.default_risk_level,
      scan_prompt: scanner.default_scan_prompt,
      scan_response: scanner.default_scan_response,
      notes: scanner.notes,
      is_enabled: scanner.is_enabled !== false,
    })
    setModalVisible(true)
  }

  const handleToggleEnable = async (scanner: CustomScanner, enabled: boolean) => {
    try {
      await customScannersApi.update(scanner.id, { is_enabled: enabled })
      toast.success(enabled ? t('customScanners.enableSuccess') : t('customScanners.disableSuccess'))
      await loadData()
    } catch (error) {
      toast.error(t('customScanners.toggleFailed'))
      console.error('Failed to toggle scanner:', error)
    }
  }

  const handleDelete = async (scanner: CustomScanner) => {
    const confirmed = await confirmDialog({
      title: t('customScanners.deleteScanner'),
      description: (
        <div className="space-y-2">
          <p>{t('customScanners.confirmDelete')}</p>
          <p className="text-sm text-red-600">{t('customScanners.deleteWarning')}</p>
        </div>
      ),
    })

    if (!confirmed) return

    try {
      await customScannersApi.delete(scanner.id)
      toast.success(t('customScanners.deleteSuccess'))
      await loadData()
      // Emit event to notify other components
      eventBus.emit(EVENTS.SCANNER_DELETED, { scannerId: scanner.id, scannerTag: scanner.tag })
    } catch (error) {
      toast.error(t('customScanners.deleteFailed'))
    }
  }

  const formSchema = z.object({
    scanner_type: z.string().min(1, t('customScanners.validationErrors.typeRequired')),
    name: z
      .string()
      .min(1, t('customScanners.validationErrors.nameRequired'))
      .max(200, t('customScanners.validationErrors.nameTooLong')),
    definition: z
      .string()
      .min(1, t('customScanners.validationErrors.definitionRequired'))
      .max(2000, t('customScanners.validationErrors.definitionTooLong')),
    risk_level: z.string().min(1, t('customScanners.validationErrors.riskLevelRequired')),
    scan_prompt: z.boolean().optional(),
    scan_response: z.boolean().optional(),
    notes: z.string().max(1000, t('customScanners.validationErrors.notesTooLong')).optional(),
    is_enabled: z.boolean().optional(),
  })

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      scanner_type: '',
      name: '',
      definition: '',
      risk_level: '',
      scan_prompt: true,
      scan_response: true,
      notes: '',
      is_enabled: true,
    },
  })

  const selectedScannerType = form.watch('scanner_type')

  const handleSubmit = async (values: any) => {
    try {
      setSaving(true)

      if (editingScanner) {
        await customScannersApi.update(editingScanner.id, values)
        toast.success(t('customScanners.updateSuccess'))
        // Emit event to notify other components
        eventBus.emit(EVENTS.SCANNER_UPDATED, { scannerId: editingScanner.id })
      } else {
        await customScannersApi.create(values)
        toast.success(t('customScanners.createSuccess'))
        // Emit event to notify other components
        eventBus.emit(EVENTS.SCANNER_CREATED)
      }

      setModalVisible(false)
      form.reset()
      await loadData()
    } catch (error: any) {
      toast.error(editingScanner ? t('customScanners.updateFailed') : t('customScanners.createFailed'))
      console.error('Failed to save scanner:', error)
    } finally {
      setSaving(false)
    }
  }

  const getRiskLevelColor = (level: string) => {
    const colors: { [key: string]: string } = {
      high_risk: 'destructive',
      medium_risk: 'secondary',
      low_risk: 'secondary',
    }
    return colors[level] || 'default'
  }

  const getRiskLevelClassName = (level: string) => {
    const classNames: { [key: string]: string } = {
      high_risk: '',
      medium_risk: 'bg-orange-100 text-orange-800 border-orange-200',
      low_risk: 'bg-green-100 text-green-800 border-green-200',
    }
    return classNames[level] || ''
  }

  const getScannerTypeLabel = (type: string) => {
    const types: { [key: string]: string } = {
      genai: t('scannerPackages.scannerTypeGenai'),
      regex: t('scannerPackages.scannerTypeRegex'),
      keyword: t('scannerPackages.scannerTypeKeyword'),
    }
    return types[type] || type
  }

  const getDefinitionPlaceholder = (type: string) => {
    if (type === 'keyword') {
      return t('customScanners.keywordPlaceholder') || ''
    }
    return t(`customScanners.definitionPlaceholder.${type}` as any) || ''
  }

  const columns: ColumnDef<CustomScanner>[] = [
    {
      accessorKey: 'tag',
      header: t('customScanners.scannerTag'),
      cell: ({ row }) => (
        <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">
          {row.original.tag}
        </Badge>
      ),
    },
    {
      accessorKey: 'name',
      header: t('customScanners.scannerName'),
      cell: ({ row }) => (
        <div className="whitespace-pre-wrap break-words leading-relaxed max-w-xs">
          {row.original.name}
        </div>
      ),
    },
    {
      accessorKey: 'scanner_type',
      header: t('customScanners.scannerType'),
      cell: ({ row }) => getScannerTypeLabel(row.original.scanner_type),
    },
    {
      accessorKey: 'default_risk_level',
      header: t('customScanners.riskLevel'),
      cell: ({ row }) => (
        <Badge
          variant={getRiskLevelColor(row.original.default_risk_level) as any}
          className={getRiskLevelClassName(row.original.default_risk_level)}
        >
          {t(`risk.level.${row.original.default_risk_level}`)}
        </Badge>
      ),
    },
    {
      accessorKey: 'definition',
      header: t('customScanners.scannerDefinition'),
      cell: ({ row }) => (
        <div className="whitespace-pre-wrap break-words leading-relaxed flex-1 max-w-md">
          {row.original.definition}
        </div>
      ),
    },
    {
      accessorKey: 'is_enabled',
      header: t('customScanners.enabled'),
      cell: ({ row }) => (
        <Switch
          checked={row.original.is_enabled !== false}
          onCheckedChange={(checked) => handleToggleEnable(row.original, checked)}
        />
      ),
    },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleEdit(row.original)}
          >
            <Edit2 className="h-4 w-4 mr-1" />
            {t('common.edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => handleDelete(row.original)}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ]

  // Show loading state while checking subscription
  if (subscriptionLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  // Show upgrade prompt if not subscribed
  if (isSubscribed === false) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center space-y-6">
              <Crown className="h-16 w-16 text-yellow-500 mx-auto" />
              <div className="space-y-2">
                <h3 className="text-xl font-semibold flex items-center justify-center gap-2">
                  <Lock className="h-5 w-5" />
                  {t('customScanners.premiumFeatureTitle')}
                </h3>
                <p className="text-gray-600">{t('customScanners.premiumFeatureSubtitle')}</p>
              </div>

              <Button
                size="lg"
                onClick={() => navigate('/subscription')}
                className="gap-2"
              >
                <Crown className="h-5 w-5" />
                {t('customScanners.upgradeNow')}
              </Button>

              <div className="max-w-2xl mx-auto p-6 bg-gray-50 rounded-lg text-left">
                <h4 className="font-semibold mb-4 flex items-center gap-2">
                  <Crown className="h-5 w-5 text-yellow-500" />
                  {t('customScanners.benefitsTitle')}
                </h4>
                <ul className="space-y-2 text-base">
                  <li>{t('customScanners.feature1')}</li>
                  <li>{t('customScanners.feature2')}</li>
                  <li>{t('customScanners.feature3')}</li>
                  <li>{t('customScanners.feature4')}</li>
                  <li>{t('customScanners.feature5')}</li>
                </ul>
                <div className="mt-6 p-4 bg-white rounded-lg border">
                  <p className="font-semibold text-base mb-2">
                    {t('customScanners.pricingInfo')}
                  </p>
                  <p className="text-sm text-gray-600">
                    {t('customScanners.pricingDetails')}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {features.showSubscription() && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-center gap-2 text-green-900 font-semibold mb-1">
            <Crown className="h-5 w-5 text-yellow-500" />
            <span>{t('customScanners.premiumActiveMessage')}</span>
          </div>
          <p className="text-sm text-green-800">{t('customScanners.premiumActiveDesc')}</p>
        </div>
      )}

      <Collapsible open={guideOpen} onOpenChange={setGuideOpen} className="bg-gray-50 rounded-lg border">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full flex justify-between p-4 hover:bg-gray-100">
            <span className="font-semibold">{t('customScanners.usageGuideTitle')}</span>
            <ChevronDown className={`h-5 w-5 transition-transform ${guideOpen ? 'rotate-180' : ''}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4 space-y-4">
          <div>
            <p className="font-semibold mb-2">{t('customScanners.whatIsCustomScanner')}</p>
            <p className="text-sm text-gray-700 mb-4">
              {t('customScanners.whatIsCustomScannerDesc')}
            </p>
          </div>

          <div>
            <p className="font-semibold mb-3">{t('customScanners.examplesTitle')}</p>

            <div className="space-y-3">
              <div className="p-4 bg-white border rounded-lg">
                <h4 className="font-semibold text-blue-600 mb-2">
                  {t('customScanners.example1Title')}
                </h4>
                <p className="font-semibold mb-2">{t('customScanners.example1Name')}</p>
                <p className="text-sm mb-1">
                  <strong>{t('customScanners.scannerType')}:</strong> {t('customScanners.exampleTypeGenai')}
                </p>
                <p className="text-sm mb-1">
                  <strong>{t('customScanners.scannerDefinition')}:</strong> {t('customScanners.example1Definition')}
                </p>
                <p className="text-sm text-gray-600">{t('customScanners.example1Desc')}</p>
              </div>

              <div className="p-4 bg-white border rounded-lg">
                <h4 className="font-semibold text-blue-600 mb-2">
                  {t('customScanners.example2Title')}
                </h4>
                <p className="font-semibold mb-2">{t('customScanners.example2Name')}</p>
                <p className="text-sm mb-1">
                  <strong>{t('customScanners.scannerType')}:</strong> {t('customScanners.exampleTypeGenai')}
                </p>
                <p className="text-sm mb-1">
                  <strong>{t('customScanners.scannerDefinition')}:</strong> {t('customScanners.example2Definition')}
                </p>
                <p className="text-sm text-gray-600">{t('customScanners.example2Desc')}</p>
              </div>

              <div className="p-4 bg-white border rounded-lg">
                <h4 className="font-semibold text-red-600 mb-2">
                  {t('customScanners.example3Title')}
                </h4>
                <p className="font-semibold mb-2">{t('customScanners.example3Name')}</p>
                <p className="text-sm mb-1">
                  <strong>{t('customScanners.scannerType')}:</strong> {t('customScanners.exampleTypeKeyword')}
                </p>
                <p className="text-sm mb-1">
                  <strong>{t('customScanners.scannerDefinition')}:</strong> {t('customScanners.example3Definition')}
                </p>
                <p className="text-sm text-gray-600">{t('customScanners.example3Desc')}</p>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t('customScanners.title')}</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={loadData} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-1" />
              {t('customScanners.createScanner')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={scanners}
            loading={loading}
            emptyMessage={t('customScanners.noScannersFound')}
          />
        </CardContent>
      </Card>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingScanner ? t('customScanners.editScanner') : t('customScanners.createScanner')}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="scanner_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('customScanners.scannerType')}</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={!!editingScanner}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('customScanners.selectType')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="genai">
                          <div>
                            <div className="font-semibold">{t('customScanners.typeGenai')}</div>
                            <div className="text-xs text-gray-500">{t('customScanners.typeGenaiDesc')}</div>
                          </div>
                        </SelectItem>
                        <SelectItem value="regex">
                          <div>
                            <div className="font-semibold">{t('customScanners.typeRegex')}</div>
                            <div className="text-xs text-gray-500">{t('customScanners.typeRegexDesc')}</div>
                          </div>
                        </SelectItem>
                        <SelectItem value="keyword">
                          <div>
                            <div className="font-semibold">{t('customScanners.typeKeyword')}</div>
                            <div className="text-xs text-gray-500">
                              {t('customScanners.typeKeywordDesc')} {t('customScanners.typeKeywordFormat')}
                            </div>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('customScanners.scannerName')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('customScanners.namePlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="definition"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('customScanners.scannerDefinition')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder={selectedScannerType ? getDefinitionPlaceholder(selectedScannerType) : ''}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="risk_level"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('customScanners.riskLevel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="high_risk">{t('risk.level.high_risk')}</SelectItem>
                        <SelectItem value="medium_risk">{t('risk.level.medium_risk')}</SelectItem>
                        <SelectItem value="low_risk">{t('risk.level.low_risk')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('customScanners.scannerNotes')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} placeholder={t('customScanners.notesPlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="is_enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between p-4 border rounded-lg">
                    <FormLabel>{t('customScanners.enabled')}</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              {!editingScanner && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-900">{t('customScanners.autoTag')}</p>
                </div>
              )}

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
                <Button type="submit" disabled={saving}>
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default CustomScannersManagement
