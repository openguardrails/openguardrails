import React, { useState, useEffect } from 'react'
import { Upload, RefreshCw, Edit } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { confirmDialog } from '@/lib/confirm-dialog'
import { useAuth } from '../../contexts/AuthContext'
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
  price?: number
  price_display?: string
  bundle?: string
  created_at?: string
  archived?: boolean
  archived_at?: string
  archive_reason?: string
}

const PackageMarketplace: React.FC = () => {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()

  // Dynamic price display function based on current language
  const formatPriceDisplay = (price: number | undefined, priceDisplay: string | undefined): string => {
    if (price === undefined || price === null) {
      return priceDisplay || 'Free'
    }

    const currentLang = i18n.language
    if (currentLang === 'zh') {
      return `￥${price}元`
    } else {
      return `$${price}`
    }
  }

  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<Package[]>([])
  const [uploadModalVisible, setUploadModalVisible] = useState(false)
  const [archiveModalVisible, setArchiveModalVisible] = useState(false)
  const [selectedPackageForArchive, setSelectedPackageForArchive] = useState<Package | null>(null)
  const [archiveReason, setArchiveReason] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [selectedPackageForEdit, setSelectedPackageForEdit] = useState<Package | null>(null)
  const [uploadPrice, setUploadPrice] = useState<number | null>(null)
  const [uploadBundle, setUploadBundle] = useState<string | null>(null)

  const isSuperAdmin = user?.is_super_admin || false

  const editFormSchema = z.object({
    package_code: z.string().min(1, t('validation.required')),
    package_name: z.string().min(1, t('validation.required')),
    description: z.string().optional(),
    version: z.string().min(1, t('validation.required')),
    price: z.number().optional(),
    price_display: z.string().optional(),
    bundle: z.string().optional(),
  })

  const editForm = useForm<z.infer<typeof editFormSchema>>({
    resolver: zodResolver(editFormSchema),
  })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const packagesData = isSuperAdmin
        ? await scannerPackagesApi.getAllAdmin('purchasable', true)
        : await scannerPackagesApi.getAll('purchasable')
      setPackages(packagesData)
    } catch (error) {
      toast.error(t('packageMarketplace.loadFailed'))
      console.error('Failed to load marketplace data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type !== 'application/json') {
      toast.error('Only JSON files are allowed')
      return
    }

    setSelectedFile(file)

    // Read JSON to pre-fill bundle field
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const jsonContent = JSON.parse(e.target?.result as string)
        if (jsonContent.bundle && !uploadBundle) {
          setUploadBundle(jsonContent.bundle)
        }
      } catch (error) {
        console.error('Invalid JSON file:', error)
      }
    }
    reader.readAsText(file)
  }

  const handleUpload = async () => {
    if (!selectedFile) {
      toast.error('Please select a JSON file')
      return
    }

    const reader = new FileReader()

    reader.onload = async (e) => {
      try {
        const jsonContent = JSON.parse(e.target?.result as string)
        const defaultBundle = jsonContent.bundle || uploadBundle
        const currentLanguage = localStorage.getItem('language') || 'en'

        await scannerPackagesApi.uploadPackage({
          package_data: jsonContent,
          price: uploadPrice,
          bundle: defaultBundle,
          language: currentLanguage,
        })

        toast.success(t('packageMarketplace.uploadSuccess'))
        setUploadModalVisible(false)
        setSelectedFile(null)
        setUploadPrice(null)
        setUploadBundle(null)
        await loadData()
      } catch (error) {
        toast.error(t('packageMarketplace.uploadFailed'))
        console.error('Failed to upload package:', error)
      }
    }

    reader.readAsText(selectedFile)
  }

  const handleArchivePackage = (pkg: Package) => {
    setSelectedPackageForArchive(pkg)
    setArchiveReason('')
    setArchiveModalVisible(true)
  }

  const handleConfirmArchive = async () => {
    if (!selectedPackageForArchive) return

    try {
      await scannerPackagesApi.archivePackage(selectedPackageForArchive.id, archiveReason)
      toast.success(t('packageMarketplace.archiveSuccess'))
      setArchiveModalVisible(false)
      setSelectedPackageForArchive(null)
      setArchiveReason('')
      await loadData()
    } catch (error) {
      toast.error(t('packageMarketplace.archiveFailed'))
    }
  }

  const handleUnarchivePackage = async (pkg: Package) => {
    const confirmed = await confirmDialog({
      title: t('packageMarketplace.unarchivePackage'),
      description: (
        <div>
          <p>{t('packageMarketplace.confirmUnarchive')}</p>
          <p className="text-yellow-600 text-xs mt-2">{t('packageMarketplace.unarchiveWarning')}</p>
        </div>
      ) as any,
    })

    if (!confirmed) return

    try {
      await scannerPackagesApi.unarchivePackage(pkg.id)
      toast.success(t('packageMarketplace.unarchiveSuccess'))
      await loadData()
    } catch (error) {
      toast.error(t('packageMarketplace.unarchiveFailed'))
    }
  }

  const handleEditPackage = (pkg: Package) => {
    setSelectedPackageForEdit(pkg)
    editForm.reset({
      package_code: pkg.package_code,
      package_name: pkg.package_name,
      description: pkg.description,
      version: pkg.version,
      price: pkg.price,
      price_display: pkg.price_display || '',
      bundle: pkg.bundle || '',
    })
    setEditModalVisible(true)
  }

  const handleUpdatePackage = async (values: z.infer<typeof editFormSchema>) => {
    if (!selectedPackageForEdit) return

    try {
      await scannerPackagesApi.updatePackage(selectedPackageForEdit.id, values)
      toast.success(t('packageMarketplace.updateSuccess'))
      setEditModalVisible(false)
      setSelectedPackageForEdit(null)
      editForm.reset()
      await loadData()
    } catch (error) {
      toast.error(t('packageMarketplace.updateFailed'))
      console.error('Failed to update package:', error)
    }
  }

  const packageColumns: ColumnDef<Package>[] = [
    {
      accessorKey: 'package_name',
      header: t('packageMarketplace.packageName'),
    },
    {
      accessorKey: 'author',
      header: t('scannerPackages.author'),
      size: 150,
    },
    {
      accessorKey: 'version',
      header: t('scannerPackages.version'),
      size: 100,
    },
    {
      accessorKey: 'archived',
      header: t('packageMarketplace.status'),
      size: 100,
      cell: ({ row }) => {
        const archived = row.getValue('archived') as boolean
        return (
          <Badge variant={archived ? 'outline' : 'default'}>
            {archived ? t('packageMarketplace.archived') : t('packageMarketplace.active')}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'scanner_count',
      header: t('scannerPackages.scannerCount'),
      size: 120,
    },
    {
      id: 'price_display',
      header: t('scannerPackages.priceDisplay'),
      size: 120,
      cell: ({ row }) => {
        const record = row.original
        return formatPriceDisplay(record.price, record.price_display)
      },
    },
    {
      accessorKey: 'bundle',
      header: 'Bundle',
      size: 150,
      cell: ({ row }) => {
        const bundle = row.getValue('bundle') as string
        return bundle ? (
          <Badge variant="secondary" className="text-xs">
            {bundle}
          </Badge>
        ) : (
          '-'
        )
      },
    },
    {
      id: 'actions',
      header: t('common.actions'),
      size: isSuperAdmin ? 240 : 0,
      cell: ({ row }) => {
        const record = row.original
        if (!isSuperAdmin) return null

        return (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleEditPackage(record)}>
              <Edit className="mr-2 h-4 w-4" />
              {t('common.edit')}
            </Button>
            {record.archived ? (
              <Button variant="outline" size="sm" onClick={() => handleUnarchivePackage(record)}>
                {t('packageMarketplace.unarchivePackage')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => handleArchivePackage(record)}>
                {t('packageMarketplace.archivePackage')}
              </Button>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>{t('packageMarketplace.title')}</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" onClick={loadData} disabled={loading}>
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('common.refresh')}
              </Button>
              {isSuperAdmin && (
                <Button onClick={() => setUploadModalVisible(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  {t('packageMarketplace.uploadPackage')}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable columns={packageColumns} data={packages} loading={loading} />
        </CardContent>
      </Card>

      {/* Upload Modal */}
      <Dialog open={uploadModalVisible} onOpenChange={setUploadModalVisible}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{t('packageMarketplace.uploadPackage')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <p className="font-semibold">{t('packageMarketplace.packageJsonFormat')}</p>
              <p className="text-xs text-gray-600">{t('packageMarketplace.jsonFormatHelp')}</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('scannerPackages.price')}</label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  placeholder={t('packageMarketplace.pricePlaceholder')}
                  value={uploadPrice || ''}
                  onChange={(e) => setUploadPrice(e.target.value ? parseFloat(e.target.value) : null)}
                  min={0}
                  step="0.01"
                  className="flex-1"
                />
                <span className="text-sm text-gray-600">{i18n.language === 'zh' ? '元' : '$'}</span>
              </div>
              <p className="text-xs text-gray-500">{t('packageMarketplace.priceHelp')}</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Bundle</label>
              <Input
                placeholder="e.g., Enterprise, Security, Compliance"
                value={uploadBundle || ''}
                onChange={(e) => setUploadBundle(e.target.value || null)}
              />
              <p className="text-xs text-gray-500">Bundle name for grouping related packages</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('packageMarketplace.uploadJson')}</label>
              <Input type="file" accept=".json" onChange={handleFileSelect} />
              {selectedFile && (
                <p className="text-sm text-gray-600">
                  Selected: {selectedFile.name}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setUploadModalVisible(false)
                setSelectedFile(null)
                setUploadPrice(null)
                setUploadBundle(null)
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUpload}>{t('common.upload')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Modal */}
      <Dialog open={editModalVisible} onOpenChange={setEditModalVisible}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('packageMarketplace.editPackage')}</DialogTitle>
          </DialogHeader>

          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleUpdatePackage)} className="space-y-4">
              <FormField
                control={editForm.control}
                name="package_code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('scannerPackages.packageCode')}</FormLabel>
                    <FormControl>
                      <Input {...field} disabled />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="package_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('scannerPackages.packageName')}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('scannerPackages.description')}</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="version"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('scannerPackages.version')}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('scannerPackages.price')}</FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(e.target.value ? parseFloat(e.target.value) : undefined)}
                          min={0}
                          step="0.01"
                          className="flex-1"
                        />
                        <span className="text-sm text-gray-600">{i18n.language === 'zh' ? '元' : '$'}</span>
                      </div>
                    </FormControl>
                    <FormDescription>{t('packageMarketplace.priceTooltip')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="price_display"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('scannerPackages.priceDisplay')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={t('packageMarketplace.priceDisplayPlaceholder')} />
                    </FormControl>
                    <FormDescription>{t('packageMarketplace.priceDisplayTooltip')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="bundle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bundle</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g., Enterprise, Security, Compliance" />
                    </FormControl>
                    <FormDescription>Bundle name for grouping related packages</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditModalVisible(false)
                    setSelectedPackageForEdit(null)
                    editForm.reset()
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

      {/* Archive Modal */}
      <Dialog open={archiveModalVisible} onOpenChange={setArchiveModalVisible}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('packageMarketplace.archivePackage')}</DialogTitle>
          </DialogHeader>

          {selectedPackageForArchive && (
            <div className="space-y-4">
              <div>
                <p>{t('packageMarketplace.confirmArchive')}</p>
                <p className="text-yellow-600 text-xs mt-2">
                  {t('packageMarketplace.archiveWarning')}
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('packageMarketplace.archiveReason')}</label>
                <Textarea
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  placeholder={t('packageMarketplace.archiveReasonPlaceholder')}
                  rows={4}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setArchiveModalVisible(false)
                setSelectedPackageForArchive(null)
                setArchiveReason('')
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleConfirmArchive}>{t('packageMarketplace.archivePackage')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default PackageMarketplace
