import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, RefreshCw, ShoppingCart, Eye, Loader2 } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useCanEdit } from '../../hooks/useCanEdit'
import api, { scannerPackagesApi, scannerConfigsApi, purchasesApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { eventBus, EVENTS } from '../../utils/eventBus'
import paymentService, { PaymentConfig } from '../../services/payment'
import { usePaymentSuccess } from '../../hooks/usePaymentSuccess'
import { features } from '../../config'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from 'sonner'
import { confirmDialog } from '@/utils/confirm-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ColumnDef } from '@tanstack/react-table'

interface ScannerConfig {
  id: string
  tag: string
  name: string
  description?: string
  scanner_type: string
  package_name: string
  package_id?: string
  is_custom: boolean
  is_enabled: boolean
  risk_level: string
  scan_prompt: boolean
  scan_response: boolean
  default_risk_level: string
  default_scan_prompt: boolean
  default_scan_response: boolean
  has_risk_level_override: boolean
  has_scan_prompt_override: boolean
  has_scan_response_override: boolean
}

interface Package {
  id: string
  package_code: string
  package_name: string
  author: string
  description?: string
  version: string
  scanner_count: number
  package_type: string
  bundle?: string
  created_at?: string
  // Marketplace specific fields
  price?: number
  price_display?: string
  purchase_status?: string
  purchased?: boolean
  purchase_requested?: boolean
}

interface OfficialScannersManagementProps {
  workspaceId?: string
}

const OfficialScannersManagement: React.FC<OfficialScannersManagementProps> = ({ workspaceId }) => {
  const { t, i18n } = useTranslation()
  const canEdit = useCanEdit()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()

  // Workspace-scoped API helpers
  const wsPrefix = workspaceId ? `/api/v1/workspaces/${workspaceId}/config` : null

  // Dynamic price display function based on current language
  const formatPriceDisplay = (price: number | undefined, priceDisplay: string | undefined): string => {
    if (price === undefined || price === null) {
      return priceDisplay || t('scannerPackages.free')
    }

    // Format the price based on current language
    const currentLang = i18n.language
    if (currentLang === 'zh') {
      return `￥${price}元`
    } else {
      return `$${price}`
    }
  }

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scannerConfigs, setScannerConfigs] = useState<ScannerConfig[]>([])
  const [builtinPackages, setBuiltinPackages] = useState<Package[]>([])
  const [purchasedPackages, setPurchasedPackages] = useState<Package[]>([])
  const [marketplacePackages, setMarketplacePackages] = useState<Package[]>([])
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [selectedPackage, setSelectedPackage] = useState<Package | null>(null)
  const [purchaseModalVisible, setPurchaseModalVisible] = useState(false)
  const [purchasePackage, setPurchasePackage] = useState<Package | null>(null)
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null)
  const [paymentLoading, setPaymentLoading] = useState(false)

  // Active tab key - support URL hash for direct navigation
  const [activeTabKey, setActiveTabKey] = useState<string>(() => {
    const hash = window.location.hash.replace('#', '')
    if (hash && ['builtin', 'purchased', 'marketplace'].includes(hash)) {
      return hash
    }
    return 'builtin'
  })

  // Reload scanner configs when workspace changes
  useEffect(() => {
    loadScannerConfigs()
  }, [workspaceId])

  useEffect(() => {
    loadPackagesOnly()

    // Load payment config (only in SaaS mode)
    if (features.showPayment()) {
      const loadPaymentConfig = async () => {
        try {
          const config = await paymentService.getConfig()
          setPaymentConfig(config)
        } catch (e) {
          console.error('Failed to load payment config:', e)
        }
      }
      loadPaymentConfig()
    }

    // Handle payment cancellation (no verification needed)
    const paymentStatus = searchParams.get('payment')
    if (paymentStatus === 'cancelled') {
      toast.info(t('payment.cancelled'))
      setSearchParams({})
    }
  }, [])

  // Handle payment success with polling verification
  const handlePaymentSuccess = React.useCallback(
    (result: any) => {
      // Only refresh if this is a package payment
      if (result.order_type === 'package') {
        loadPackagesOnly()
        loadScannerConfigs()
      }
    },
    []
  )

  usePaymentSuccess({
    onSuccess: handlePaymentSuccess,
  })

  const loadPackagesOnly = async () => {
    try {
      // Load basic packages (no application needed)
      const allBuiltin = await scannerPackagesApi.getAll('basic')
      setBuiltinPackages(allBuiltin)

      // Only load marketplace packages in SaaS mode
      if (features.showMarketplace()) {
        const marketplace = await scannerPackagesApi.getMarketplace()

        // Filter purchased packages (those with purchased=true)
        setPurchasedPackages(marketplace.filter((p: Package) => p.purchased))

        // Filter marketplace packages (available for purchase, not yet purchased)
        setMarketplacePackages(marketplace.filter((p: Package) => !p.purchased))
      }
    } catch (error) {
      toast.error(t('scannerPackages.loadFailed'))
      console.error('Failed to load packages:', error)
    }
  }

  const loadScannerConfigs = async () => {
    try {
      setLoading(true)
      let configs: ScannerConfig[]
      if (wsPrefix) {
        const res = await api.get(`${wsPrefix}/scanners`)
        configs = res.data
      } else {
        configs = await scannerConfigsApi.getAll(true)
      }
      setScannerConfigs(configs.filter((c: ScannerConfig) => !c.is_custom))
    } catch (error) {
      toast.error(t('scannerPackages.loadFailed'))
      console.error('Failed to load scanner configs:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadData = () => {
    loadScannerConfigs()
  }

  const updateScannerConfig = async (scannerId: string, updates: any) => {
    if (wsPrefix) {
      // Workspace mode: bulk update via workspace endpoint
      const configs = scannerConfigs.map(s => {
        if (s.id === scannerId) {
          return {
            scanner_id: s.id,
            is_enabled: updates.is_enabled !== undefined ? updates.is_enabled : s.is_enabled,
            risk_level: s.risk_level !== s.default_risk_level ? s.risk_level : undefined,
            scan_prompt: updates.scan_prompt !== undefined ? updates.scan_prompt : (s.scan_prompt !== s.default_scan_prompt ? s.scan_prompt : undefined),
            scan_response: updates.scan_response !== undefined ? updates.scan_response : (s.scan_response !== s.default_scan_response ? s.scan_response : undefined),
          }
        }
        return {
          scanner_id: s.id,
          is_enabled: s.is_enabled,
          risk_level: s.risk_level !== s.default_risk_level ? s.risk_level : undefined,
          scan_prompt: s.scan_prompt !== s.default_scan_prompt ? s.scan_prompt : undefined,
          scan_response: s.scan_response !== s.default_scan_response ? s.scan_response : undefined,
        }
      })
      await api.put(`${wsPrefix}/scanners`, { configs })
    } else {
      await scannerConfigsApi.update(scannerId, updates)
    }
  }

  const handleToggleScanner = async (scannerId: string, enabled: boolean) => {
    try {
      setSaving(true)
      await updateScannerConfig(scannerId, { is_enabled: enabled })
      toast.success(t('scannerPackages.configurationSaved'))
      setScannerConfigs((prev) => prev.map((s) => (s.id === scannerId ? { ...s, is_enabled: enabled } : s)))
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
      console.error('Failed to update scanner:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleScanPrompt = async (scannerId: string, enabled: boolean) => {
    try {
      setSaving(true)
      await updateScannerConfig(scannerId, { scan_prompt: enabled })
      toast.success(t('scannerPackages.configurationSaved'))
      setScannerConfigs((prev) =>
        prev.map((s) => (s.id === scannerId ? { ...s, scan_prompt: enabled, has_scan_prompt_override: true } : s))
      )
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
      console.error('Failed to update scanner:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleScanResponse = async (scannerId: string, enabled: boolean) => {
    try {
      setSaving(true)
      await updateScannerConfig(scannerId, { scan_response: enabled })
      toast.success(t('scannerPackages.configurationSaved'))
      setScannerConfigs((prev) =>
        prev.map((s) => (s.id === scannerId ? { ...s, scan_response: enabled, has_scan_response_override: true } : s))
      )
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
      console.error('Failed to update scanner:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleChangeRiskLevel = async (scannerId: string, riskLevel: string) => {
    try {
      setSaving(true)

      if (user?.is_super_admin && !wsPrefix) {
        // Super admin (not in workspace mode): update global default risk level
        await scannerPackagesApi.updateScannerDefaultRiskLevel(scannerId, riskLevel)
        toast.success(t('scannerPackages.defaultRiskLevelUpdated'))
        setScannerConfigs((prev) =>
          prev.map((s) =>
            s.id === scannerId
              ? {
                  ...s,
                  default_risk_level: riskLevel,
                  risk_level: s.has_risk_level_override ? s.risk_level : riskLevel,
                }
              : s
          )
        )
      } else {
        // Admin/Owner or workspace mode: update workspace-level risk level override
        if (wsPrefix) {
          // Workspace mode: use bulk update endpoint
          const configs = scannerConfigs.map(s => {
            if (s.id === scannerId) {
              return {
                scanner_id: s.id,
                is_enabled: s.is_enabled,
                risk_level: riskLevel,
                scan_prompt: s.scan_prompt !== s.default_scan_prompt ? s.scan_prompt : undefined,
                scan_response: s.scan_response !== s.default_scan_response ? s.scan_response : undefined,
              }
            }
            return {
              scanner_id: s.id,
              is_enabled: s.is_enabled,
              risk_level: s.risk_level !== s.default_risk_level ? s.risk_level : undefined,
              scan_prompt: s.scan_prompt !== s.default_scan_prompt ? s.scan_prompt : undefined,
              scan_response: s.scan_response !== s.default_scan_response ? s.scan_response : undefined,
            }
          })
          await api.put(`${wsPrefix}/scanners`, { configs })
        } else {
          await scannerConfigsApi.update(scannerId, { risk_level: riskLevel })
        }
        toast.success(t('scannerPackages.configurationSaved'))
        setScannerConfigs((prev) =>
          prev.map((s) =>
            s.id === scannerId
              ? {
                  ...s,
                  risk_level: riskLevel,
                  has_risk_level_override: true,
                }
              : s
          )
        )
      }
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
      console.error('Failed to update risk level:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async (scannerId: string) => {
    if (wsPrefix) return // Workspace mode doesn't support individual reset
    try {
      setSaving(true)
      await scannerConfigsApi.reset(scannerId)
      toast.success(t('scannerPackages.resetSuccess'))
      loadData()
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleResetAll = async () => {
    if (wsPrefix) return // Workspace mode doesn't support reset all
    const confirmed = await confirmDialog({
      title: t('scannerPackages.resetAllToDefault'),
      description: t('scannerPackages.confirmResetAll'),
    })

    if (!confirmed) return

    try {
      setSaving(true)
      await scannerConfigsApi.resetAll()
      toast.success(t('scannerPackages.resetAllSuccess'))
      loadData()
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleRequestPurchase = (pkg: Package) => {
    setPurchasePackage(pkg)
    setPurchaseModalVisible(true)
  }

  const handleClosePurchaseModal = () => {
    setPurchaseModalVisible(false)
    setPurchasePackage(null)
  }

  const handleSubmitPurchase = async () => {
    try {
      if (!purchasePackage) return

      // In enterprise mode, all packages are free
      if (features.showPayment() && purchasePackage.price && purchasePackage.price > 0) {
        // Paid package - redirect to payment
        setPaymentLoading(true)

        const response = await paymentService.createPackagePayment(purchasePackage.id)

        if (response.success) {
          // Keep the modal open while redirecting
          setTimeout(() => {
            paymentService.redirectToPayment(response)
          }, 500)
        } else {
          toast.error(response.error || t('payment.error.createFailed'))
          setPaymentLoading(false)
          setPurchaseModalVisible(false)
        }
      } else {
        // Free package - direct purchase (auto-approved, no admin review needed)
        setPaymentLoading(true)

        await purchasesApi.directPurchase(purchasePackage.id, user?.email || '')

        toast.success(t('scannerPackages.purchaseCompleted'))
        handleClosePurchaseModal()
        setPaymentLoading(false)

        // Reload data to refresh marketplace packages
        await loadPackagesOnly()

        // Emit event to notify other components
        eventBus.emit(EVENTS.MARKETPLACE_SCANNER_PURCHASED, {
          packageId: purchasePackage.id,
          packageName: purchasePackage.package_name,
        })
      }
    } catch (error: any) {
      console.error('Failed to purchase package:', error)
      toast.error(error.response?.data?.detail || t('scannerPackages.purchaseFailed'))
      setPaymentLoading(false)
      setPurchaseModalVisible(false)
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
      medium_risk: 'bg-orange-500/15 text-orange-300 border-orange-500/20',
      low_risk: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
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

  const getEnabledCount = (packageId: string) => {
    const packageScanners = scannerConfigs.filter((s) => s.package_id === packageId)
    const enabledCount = packageScanners.filter((s) => s.is_enabled).length
    const totalCount = packageScanners.length
    return `${enabledCount}/${totalCount}`
  }

  // Columns for built-in and purchased packages (with configuration)
  const packageColumns: ColumnDef<Package>[] = [
    {
      accessorKey: 'package_name',
      header: t('scannerPackages.packageName'),
    },
    {
      accessorKey: 'description',
      header: t('scannerPackages.description'),
    },
    {
      accessorKey: 'author',
      header: t('scannerPackages.author'),
    },
    {
      accessorKey: 'version',
      header: t('scannerPackages.version'),
    },
    {
      accessorKey: 'bundle',
      header: 'Bundle',
      cell: ({ row }) => (
        <Badge variant="secondary" className="bg-sky-500/15 text-sky-300 border-sky-500/20 text-xs">
          {row.original.bundle || '-'}
        </Badge>
      ),
    },
    {
      accessorKey: 'scanner_count',
      header: t('scannerPackages.enabled'),
      cell: ({ row }) => getEnabledCount(row.original.id),
    },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleOpenDrawer(row.original)}
        >
          <Eye className="h-4 w-4 mr-1" />
          {t('scannerPackages.viewScanners')}
        </Button>
      ),
    },
  ]

  // Columns for marketplace packages (no configuration, show purchase info)
  const marketplaceColumns: ColumnDef<Package>[] = [
    {
      accessorKey: 'package_name',
      header: t('scannerPackages.packageName'),
    },
    {
      accessorKey: 'description',
      header: t('scannerPackages.description'),
    },
    {
      accessorKey: 'author',
      header: t('scannerPackages.author'),
    },
    {
      accessorKey: 'version',
      header: t('scannerPackages.version'),
    },
    {
      accessorKey: 'scanner_count',
      header: t('scannerPackages.scannerCount'),
    },
    {
      accessorKey: 'price',
      header: t('scannerPackages.priceDisplay'),
      cell: ({ row }) => formatPriceDisplay(row.original.price, row.original.price_display),
    },
    {
      accessorKey: 'bundle',
      header: 'Bundle',
      cell: ({ row }) => (
        <Badge variant="secondary" className="bg-sky-500/15 text-sky-300 border-sky-500/20 text-xs">
          {row.original.bundle || '-'}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: ({ row }) => (
        <Button size="sm" onClick={() => handleRequestPurchase(row.original)}>
          <ShoppingCart className="h-4 w-4 mr-1" />
          {t('scannerPackages.requestPurchase')}
        </Button>
      ),
    },
  ]

  const getPackageScanners = (packageId: string) => {
    return scannerConfigs
      .filter((s) => s.package_id === packageId)
      .sort((a, b) => {
        // Extract numeric part from scanner tag (e.g., S1 -> 1, S10 -> 10)
        const aNum = parseInt(a.tag.replace('S', ''))
        const bNum = parseInt(b.tag.replace('S', ''))
        return aNum - bNum
      })
  }

  const handleOpenDrawer = (pkg: Package) => {
    setSelectedPackage(pkg)
    setDrawerVisible(true)
  }

  const handleCloseDrawer = () => {
    setDrawerVisible(false)
    setSelectedPackage(null)
  }

  const scannerColumns: ColumnDef<ScannerConfig>[] = [
    {
      accessorKey: 'tag',
      header: t('scannerPackages.scannerTag'),
      cell: ({ row }) => (
        <Badge variant="secondary" className="bg-sky-500/15 text-sky-300 border-sky-500/20">
          {row.original.tag}
        </Badge>
      ),
    },
    {
      accessorKey: 'package_name',
      header: t('scannerPackages.packageName'),
    },
    {
      accessorKey: 'name',
      header: t('scannerPackages.scannerName'),
      cell: ({ row }) => <div className="truncate max-w-xs">{row.original.name}</div>,
    },
    {
      accessorKey: 'scanner_type',
      header: t('scannerPackages.scannerType'),
      cell: ({ row }) => getScannerTypeLabel(row.original.scanner_type),
    },
    {
      accessorKey: 'risk_level',
      header: t('scannerPackages.riskLevel'),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          {canEdit ? (
            <Select
              value={user?.is_super_admin && !wsPrefix ? row.original.default_risk_level : row.original.risk_level}
              onValueChange={(value) => handleChangeRiskLevel(row.original.id, value)}
              disabled={saving}
            >
              <SelectTrigger className="w-[140px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high_risk">
                  <Badge variant="destructive" className="pointer-events-none">
                    {t('risk.level.high_risk')}
                  </Badge>
                </SelectItem>
                <SelectItem value="medium_risk">
                  <Badge variant="secondary" className="bg-orange-500/15 text-orange-300 border-orange-500/20 pointer-events-none">
                    {t('risk.level.medium_risk')}
                  </Badge>
                </SelectItem>
                <SelectItem value="low_risk">
                  <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-300 border-emerald-500/20 pointer-events-none">
                    {t('risk.level.low_risk')}
                  </Badge>
                </SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Badge variant={getRiskLevelColor(row.original.risk_level) as any} className={getRiskLevelClassName(row.original.risk_level)}>
              {t(`risk.level.${row.original.risk_level}`)}
            </Badge>
          )}
          {row.original.has_risk_level_override && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-4 w-4 text-sky-400" />
                </TooltipTrigger>
                <TooltipContent>{t('scannerPackages.hasOverrides')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'is_enabled',
      header: t('scannerPackages.isEnabled'),
      cell: ({ row }) => (
        <Switch checked={row.original.is_enabled} onCheckedChange={(checked) => handleToggleScanner(row.original.id, checked)} disabled={saving} />
      ),
    },
    {
      accessorKey: 'scan_prompt',
      header: t('scannerPackages.scanPrompt'),
      cell: ({ row }) => (
        <div className="flex flex-col items-center gap-1">
          <Switch
            checked={row.original.scan_prompt}
            onCheckedChange={(checked) => handleToggleScanPrompt(row.original.id, checked)}
            disabled={saving}
          />
          {row.original.has_scan_prompt_override && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-3 w-3 text-sky-400" />
                </TooltipTrigger>
                <TooltipContent>{t('scannerPackages.hasOverrides')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'scan_response',
      header: t('scannerPackages.scanResponse'),
      cell: ({ row }) => (
        <div className="flex flex-col items-center gap-1">
          <Switch
            checked={row.original.scan_response}
            onCheckedChange={(checked) => handleToggleScanResponse(row.original.id, checked)}
            disabled={saving}
          />
          {row.original.has_scan_response_override && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-3 w-3 text-sky-400" />
                </TooltipTrigger>
                <TooltipContent>{t('scannerPackages.hasOverrides')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      ),
    },
    ...(canEdit ? [{
      id: 'actions',
      header: t('common.actions'),
      cell: ({ row }: { row: any }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleReset(row.original.id)}
          disabled={
            !row.original.has_risk_level_override && !row.original.has_scan_prompt_override && !row.original.has_scan_response_override
          }
        >
          {t('scannerPackages.resetToDefault')}
        </Button>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-4">
      {loading && (
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-400"></div>
        </div>
      )}

      {!loading && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>{t('scannerPackages.title')}</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={loadData} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                {t('common.refresh')}
              </Button>
              {canEdit && (
                <Button variant="destructive" onClick={handleResetAll} disabled={saving}>
                  {t('scannerPackages.resetAllToDefault')}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Tabs
              value={activeTabKey}
              onValueChange={(key) => {
                setActiveTabKey(key)
                window.location.hash = key
              }}
            >
              <TabsList className="w-full justify-start">
                <TabsTrigger value="builtin">{t('scannerPackages.builtinPackages')}</TabsTrigger>
                {features.showMarketplace() && (
                  <TabsTrigger value="purchased">
                    {t('scannerPackages.purchasedPackages')} ({purchasedPackages.length})
                  </TabsTrigger>
                )}
                {features.showMarketplace() && (
                  <TabsTrigger value="marketplace">
                    {t('scannerPackages.marketplace')} ({marketplacePackages.length})
                  </TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="builtin" className="mt-4">
                <DataTable columns={packageColumns} data={builtinPackages} />
              </TabsContent>

              {features.showMarketplace() && (
                <TabsContent value="purchased" className="mt-4">
                  <DataTable columns={packageColumns} data={purchasedPackages} emptyMessage={t('scannerPackages.noPurchasedPackages')} />
                </TabsContent>
              )}

              {features.showMarketplace() && (
                <TabsContent value="marketplace" className="mt-4">
                  <DataTable columns={marketplaceColumns} data={marketplacePackages} emptyMessage={t('scannerPackages.noMarketplacePackages')} />
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Purchase Modal */}
      <Dialog open={purchaseModalVisible} onOpenChange={setPurchaseModalVisible}>
        <DialogContent className={paymentLoading ? 'max-w-md' : 'max-w-2xl'}>
          {paymentLoading ? (
            <div className="py-10 text-center space-y-6">
              <Loader2 className="h-12 w-12 animate-spin text-sky-400 mx-auto" />
              <div className="space-y-3">
                <p className="text-base font-medium">
                  {paymentConfig?.provider === 'alipay' ? t('payment.redirecting.alipay', '正在跳转到支付宝...') : t('payment.redirecting.stripe', '正在跳转到支付页面...')}
                </p>
                <p className="text-sm text-muted-foreground">{t('payment.processing.pleaseWait', '请稍候，请勿关闭页面或刷新')}</p>
              </div>
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {features.showPayment() && purchasePackage?.price && purchasePackage.price > 0
                    ? t('payment.confirm.packageTitle')
                    : t('scannerPackages.submitPurchaseRequest')}
                </DialogTitle>
              </DialogHeader>
              {purchasePackage && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-2 py-2 border-b">
                    <span className="font-medium text-slate-300">{t('scannerPackages.packageName')}</span>
                    <span className="col-span-2">{purchasePackage.package_name}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 py-2 border-b">
                    <span className="font-medium text-slate-300">{t('scannerPackages.author')}</span>
                    <span className="col-span-2">{purchasePackage.author}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 py-2 border-b">
                    <span className="font-medium text-slate-300">{t('scannerPackages.version')}</span>
                    <span className="col-span-2">{purchasePackage.version}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 py-2 border-b">
                    <span className="font-medium text-slate-300">{t('scannerPackages.scannerCount')}</span>
                    <span className="col-span-2">{purchasePackage.scanner_count}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 py-2 border-b">
                    <span className="font-medium text-slate-300">Bundle</span>
                    <span className="col-span-2">{purchasePackage.bundle || '-'}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 py-2 border-b">
                    <span className="font-medium text-slate-300">{t('scannerPackages.priceDisplay')}</span>
                    <span className="col-span-2">{formatPriceDisplay(purchasePackage.price, purchasePackage.price_display)}</span>
                  </div>
                  {purchasePackage.description && (
                    <div className="grid grid-cols-3 gap-2 py-2">
                      <span className="font-medium text-slate-300">{t('scannerPackages.description')}</span>
                      <span className="col-span-2">{purchasePackage.description}</span>
                    </div>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={handleClosePurchaseModal}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleSubmitPurchase} disabled={paymentLoading || saving}>
                  {features.showPayment() && purchasePackage?.price && purchasePackage.price > 0 ? t('payment.button.payNow') : t('common.submit')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Scanner Details Sheet */}
      <Sheet open={drawerVisible} onOpenChange={setDrawerVisible}>
        <SheetContent className="w-full sm:max-w-4xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {selectedPackage ? `${selectedPackage.package_name} - ${t('scannerPackages.scannersList')}` : ''}
            </SheetTitle>
          </SheetHeader>
          {selectedPackage && (
            <div className="mt-6 space-y-6">
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2 py-2 border-b">
                  <span className="font-medium text-slate-300">{t('scannerPackages.description')}</span>
                  <span className="col-span-2">{selectedPackage.description || '-'}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 py-2 border-b">
                  <span className="font-medium text-slate-300">{t('scannerPackages.author')}</span>
                  <span className="col-span-2">{selectedPackage.author}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 py-2 border-b">
                  <span className="font-medium text-slate-300">{t('scannerPackages.version')}</span>
                  <span className="col-span-2">{selectedPackage.version}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 py-2 border-b">
                  <span className="font-medium text-slate-300">Bundle</span>
                  <span className="col-span-2">{selectedPackage.bundle || '-'}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 py-2">
                  <span className="font-medium text-slate-300">{t('scannerPackages.enabled')}</span>
                  <span className="col-span-2">{getEnabledCount(selectedPackage.id)}</span>
                </div>
              </div>

              <DataTable columns={scannerColumns} data={getPackageScanners(selectedPackage.id)} pagination={false} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default OfficialScannersManagement
