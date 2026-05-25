import React, { useState, useEffect } from 'react'
import { Upload, RefreshCw, Trash2, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/utils/confirm-dialog'
import { scannerPackagesApi } from '../../services/api'
import type { ColumnDef } from '@tanstack/react-table'

interface Package {
  id: string
  package_code: string
  package_name: string
  author: string
  description?: string
  version: string
  scanner_count: number
  bundle?: string
  created_at?: string
  archived?: boolean
  archived_at?: string
  archive_reason?: string
}

interface ScannerInfo {
  id: string
  tag: string
  name: string
  scanner_type: string
  default_risk_level: string
  default_scan_prompt: boolean
  default_scan_response: boolean
}

const GuardrailUpload: React.FC = () => {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<Package[]>([])
  const [uploadModalVisible, setUploadModalVisible] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadBundle, setUploadBundle] = useState<string>('')
  const [uploading, setUploading] = useState(false)

  // Expanded package scanners
  const [expandedPackageId, setExpandedPackageId] = useState<string | null>(null)
  const [packageScanners, setPackageScanners] = useState<ScannerInfo[]>([])
  const [scannersLoading, setScannersLoading] = useState(false)
  const [savingScannerId, setSavingScannerId] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const data = await scannerPackagesApi.getAllAdmin('basic', true)
      setPackages(data)
    } catch (error) {
      toast.error(t('guardrailUpload.loadFailed'))
      console.error('Failed to load packages:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleToggleExpand = async (pkg: Package) => {
    if (expandedPackageId === pkg.id) {
      setExpandedPackageId(null)
      setPackageScanners([])
      return
    }

    setExpandedPackageId(pkg.id)
    setScannersLoading(true)
    try {
      const detail = await scannerPackagesApi.getDetail(pkg.id)
      const scanners = (detail.scanners || []).map((s: any) => ({
        id: s.id,
        tag: s.tag || s.scanner_tag,
        name: s.name || s.guardrail_name,
        scanner_type: s.scanner_type,
        default_risk_level: s.default_risk_level,
        default_scan_prompt: s.default_scan_prompt,
        default_scan_response: s.default_scan_response,
      }))
      // Sort by tag number
      scanners.sort((a: ScannerInfo, b: ScannerInfo) => {
        const aNum = parseInt(a.tag.replace('S', ''))
        const bNum = parseInt(b.tag.replace('S', ''))
        return aNum - bNum
      })
      setPackageScanners(scanners)
    } catch (error) {
      toast.error(t('guardrailUpload.loadDetailsFailed'))
      console.error('Failed to load package scanners:', error)
      setExpandedPackageId(null)
    } finally {
      setScannersLoading(false)
    }
  }

  const handleChangeDefaultRiskLevel = async (scannerId: string, riskLevel: string) => {
    setSavingScannerId(scannerId)
    try {
      await scannerPackagesApi.updateScannerDefaultRiskLevel(scannerId, riskLevel)
      toast.success(t('scannerPackages.defaultRiskLevelUpdated'))
      setPackageScanners((prev) =>
        prev.map((s) => (s.id === scannerId ? { ...s, default_risk_level: riskLevel } : s))
      )
    } catch (error) {
      toast.error(t('scannerPackages.updateFailed'))
      console.error('Failed to update default risk level:', error)
    } finally {
      setSavingScannerId(null)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type !== 'application/json') {
      toast.error(t('guardrailUpload.jsonOnly'))
      return
    }

    setSelectedFile(file)

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const jsonContent = JSON.parse(e.target?.result as string)
        if (jsonContent.bundle && !uploadBundle) {
          setUploadBundle(jsonContent.bundle)
        }
      } catch {
        console.error('Invalid JSON file')
      }
    }
    reader.readAsText(file)
  }

  const handleUpload = async () => {
    if (!selectedFile) {
      toast.error(t('guardrailUpload.selectFile'))
      return
    }

    setUploading(true)
    const reader = new FileReader()

    reader.onload = async (e) => {
      try {
        const jsonContent = JSON.parse(e.target?.result as string)
        const defaultBundle = jsonContent.bundle || uploadBundle || undefined

        await scannerPackagesApi.uploadBasicPackage({
          package_data: jsonContent,
          bundle: defaultBundle,
        })

        toast.success(t('guardrailUpload.uploadSuccess'))
        setUploadModalVisible(false)
        setSelectedFile(null)
        setUploadBundle('')
        await loadData()
      } catch (error: any) {
        const detail = error?.response?.data?.detail || t('guardrailUpload.uploadFailed')
        toast.error(detail)
        console.error('Failed to upload package:', error)
      } finally {
        setUploading(false)
      }
    }

    reader.readAsText(selectedFile)
  }

  const handleArchive = async (pkg: Package) => {
    const confirmed = await confirmDialog({
      title: t('guardrailUpload.archivePackage'),
      description: t('guardrailUpload.confirmArchive', { name: pkg.package_name }),
    })
    if (!confirmed) return

    try {
      await scannerPackagesApi.archivePackage(pkg.id)
      toast.success(t('guardrailUpload.archiveSuccess'))
      if (expandedPackageId === pkg.id) {
        setExpandedPackageId(null)
        setPackageScanners([])
      }
      await loadData()
    } catch {
      toast.error(t('guardrailUpload.archiveFailed'))
    }
  }

  const handleUnarchive = async (pkg: Package) => {
    try {
      await scannerPackagesApi.unarchivePackage(pkg.id)
      toast.success(t('guardrailUpload.unarchiveSuccess'))
      await loadData()
    } catch {
      toast.error(t('guardrailUpload.unarchiveFailed'))
    }
  }

  const getRiskLevelBadge = (level: string) => {
    if (level === 'high_risk') {
      return <Badge variant="destructive">{t('risk.level.high_risk')}</Badge>
    }
    if (level === 'medium_risk') {
      return <Badge variant="secondary" className="bg-orange-500/15 text-orange-300 border-orange-500/20">{t('risk.level.medium_risk')}</Badge>
    }
    return <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-300 border-emerald-500/20">{t('risk.level.low_risk')}</Badge>
  }

  const columns: ColumnDef<Package>[] = [
    {
      id: 'expand',
      header: '',
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => handleToggleExpand(row.original)}
        >
          {expandedPackageId === row.original.id ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      ),
    },
    {
      accessorKey: 'package_name',
      header: t('guardrailUpload.packageName'),
      cell: ({ row }) => (
        <div>
          <span className="font-medium">{row.original.package_name}</span>
          {row.original.archived && (
            <Badge variant="secondary" className="ml-2">{t('guardrailUpload.archived')}</Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'package_code',
      header: t('guardrailUpload.packageCode'),
    },
    {
      accessorKey: 'version',
      header: t('guardrailUpload.version'),
    },
    {
      accessorKey: 'scanner_count',
      header: t('guardrailUpload.scannerCount'),
    },
    {
      accessorKey: 'author',
      header: t('guardrailUpload.author'),
    },
    {
      accessorKey: 'bundle',
      header: t('guardrailUpload.bundle'),
      cell: ({ row }) => row.original.bundle || '-',
    },
    {
      id: 'actions',
      header: t('common.actions'),
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.archived ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleUnarchive(row.original)}
              title={t('guardrailUpload.unarchive')}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleArchive(row.original)}
              title={t('guardrailUpload.archive')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('guardrailUpload.title')}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t('guardrailUpload.description')}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadData}>
                <RefreshCw className="h-4 w-4 mr-1" />
                {t('common.refresh')}
              </Button>
              <Button size="sm" onClick={() => setUploadModalVisible(true)}>
                <Upload className="h-4 w-4 mr-1" />
                {t('guardrailUpload.upload')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={packages}
            loading={loading}
          />
        </CardContent>
      </Card>

      {/* Expanded Scanner Risk Level Configuration */}
      {expandedPackageId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {packages.find(p => p.id === expandedPackageId)?.package_name} - {t('scannerPackages.allScannersRiskConfig')}
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t('scannerPackages.allScannersRiskConfigDesc')}</p>
          </CardHeader>
          <CardContent>
            {scannersLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-sky-400"></div>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('scannerPackages.scannerTag')}</TableHead>
                    <TableHead>{t('scannerPackages.scannerName')}</TableHead>
                    <TableHead>{t('scannerPackages.scannerType')}</TableHead>
                    <TableHead>{t('scannerPackages.riskLevel')}</TableHead>
                    <TableHead>{t('scannerPackages.scanPrompt')}</TableHead>
                    <TableHead>{t('scannerPackages.scanResponse')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packageScanners.map((scanner) => (
                    <TableRow key={scanner.id}>
                      <TableCell>
                        <Badge variant="secondary" className="bg-sky-500/15 text-sky-300 border-sky-500/20">
                          {scanner.tag}
                        </Badge>
                      </TableCell>
                      <TableCell>{scanner.name}</TableCell>
                      <TableCell>{scanner.scanner_type}</TableCell>
                      <TableCell>
                        <Select
                          value={scanner.default_risk_level}
                          onValueChange={(value) => handleChangeDefaultRiskLevel(scanner.id, value)}
                          disabled={savingScannerId === scanner.id}
                        >
                          <SelectTrigger className="w-[140px] h-8">
                            <SelectValue>
                              {getRiskLevelBadge(scanner.default_risk_level)}
                            </SelectValue>
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
                      </TableCell>
                      <TableCell>{scanner.default_scan_prompt ? '✓' : '-'}</TableCell>
                      <TableCell>{scanner.default_scan_response ? '✓' : '-'}</TableCell>
                    </TableRow>
                  ))}
                  {packageScanners.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        {t('scannerPackages.noScannersFound')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Upload Modal */}
      <Dialog open={uploadModalVisible} onOpenChange={setUploadModalVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('guardrailUpload.uploadTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('guardrailUpload.jsonFile')}</label>
              <Input
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t('guardrailUpload.jsonFileHint')}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">{t('guardrailUpload.bundle')}</label>
              <Input
                value={uploadBundle}
                onChange={(e) => setUploadBundle(e.target.value)}
                placeholder={t('guardrailUpload.bundlePlaceholder')}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadModalVisible(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUpload} disabled={!selectedFile || uploading}>
              {uploading ? t('common.uploading') : t('guardrailUpload.upload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default GuardrailUpload
