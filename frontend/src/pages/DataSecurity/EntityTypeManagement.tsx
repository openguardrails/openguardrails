import React, { useState, useEffect } from 'react'
import { Plus, Edit, Trash2, Globe, User, Info } from 'lucide-react'
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/lib/confirm-dialog'
import { dataSecurityApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { ColumnDef } from '@tanstack/react-table'

interface EntityType {
  id: string
  entity_type: string
  display_name: string
  risk_level?: string // Frontend field name
  category?: string // Backend field name (alias for risk_level)
  pattern: string
  anonymization_method: string
  anonymization_config: any
  check_input: boolean
  check_output: boolean
  is_active: boolean
  is_global: boolean
  source_type?: string // 'system_template', 'system_copy', 'custom'
  template_id?: string
  created_at: string
  updated_at: string
}

const EntityTypeManagement: React.FC = () => {
  const { t } = useTranslation()

  const RISK_LEVELS = [
    { value: 'low', label: t('entityType.lowRisk'), color: 'outline' as const },
    { value: 'medium', label: t('entityType.mediumRisk'), color: 'default' as const },
    { value: 'high', label: t('entityType.highRisk'), color: 'destructive' as const },
  ]

  const ANONYMIZATION_METHODS = [
    { value: 'replace', label: t('entityType.replace') },
    { value: 'mask', label: t('entityType.mask') },
    { value: 'hash', label: t('entityType.hash') },
    { value: 'encrypt', label: t('entityType.encrypt') },
    { value: 'shuffle', label: t('entityType.shuffle') },
    { value: 'random', label: t('entityType.randomReplace') },
  ]

  const [entityTypes, setEntityTypes] = useState<EntityType[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingEntity, setEditingEntity] = useState<EntityType | null>(null)
  const [searchText, setSearchText] = useState('')
  const [riskLevelFilter, setRiskLevelFilter] = useState<string | undefined>(undefined)
  const { user, onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()

  const formSchema = z.object({
    entity_type: z.string().min(1, t('entityType.entityTypeCodeRequired')),
    display_name: z.string().min(1, t('entityType.displayNameRequired')),
    risk_level: z.string().min(1, t('entityType.riskLevelRequired')),
    pattern: z.string().min(1, t('entityType.recognitionRuleRequired')),
    anonymization_method: z.string().min(1, t('entityType.anonymizationMethodRequired')),
    anonymization_config_text: z.string().optional(),
    check_input: z.boolean().default(true),
    check_output: z.boolean().default(true),
    is_active: z.boolean().default(true),
    is_global: z.boolean().optional(),
  })

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      is_active: true,
      check_input: true,
      check_output: true,
      anonymization_method: 'replace',
      is_global: false,
      anonymization_config_text: '{}',
    },
  })

  useEffect(() => {
    if (currentApplicationId) {
      loadEntityTypes()
    }
  }, [currentApplicationId])

  // Listen to user switch event, automatically refresh data
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadEntityTypes()
    })
    return unsubscribe
  }, [onUserSwitch])

  const loadEntityTypes = async () => {
    setLoading(true)
    try {
      const response = await dataSecurityApi.getEntityTypes()
      setEntityTypes(response.items || [])
    } catch (error) {
      toast.error(t('entityType.loadEntityTypesFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setEditingEntity(null)
    form.reset({
      is_active: true,
      check_input: true,
      check_output: true,
      anonymization_method: 'replace',
      is_global: false,
      anonymization_config_text: '{}',
    })
    setModalVisible(true)
  }

  const handleEdit = (record: EntityType) => {
    setEditingEntity(record)
    form.reset({
      entity_type: record.entity_type,
      display_name: record.display_name,
      risk_level: record.category || record.risk_level,
      pattern: record.pattern,
      anonymization_method: record.anonymization_method,
      anonymization_config_text: JSON.stringify(record.anonymization_config || {}, null, 2),
      check_input: record.check_input,
      check_output: record.check_output,
      is_active: record.is_active,
    })
    setModalVisible(true)
  }

  const handleDelete = async (id: string) => {
    const confirmed = await confirmDialog({
      title: t('common.confirmDelete'),
      description: t('common.deleteConfirmDescription'),
    })

    if (!confirmed) return

    try {
      await dataSecurityApi.deleteEntityType(id)
      toast.success(t('common.deleteSuccess'))
      loadEntityTypes()
    } catch (error) {
      toast.error(t('common.deleteFailed'))
    }
  }

  const handleSubmit = async (values: z.infer<typeof formSchema>) => {
    // Parse JSON config
    let anonymization_config = {}

    try {
      anonymization_config = JSON.parse(values.anonymization_config_text || '{}')
    } catch (e) {
      toast.error(t('entityType.invalidJsonConfig'))
      return
    }

    const data = {
      entity_type: values.entity_type,
      display_name: values.display_name,
      risk_level: values.risk_level,
      pattern: values.pattern,
      anonymization_method: values.anonymization_method,
      anonymization_config,
      check_input: values.check_input !== undefined ? values.check_input : true,
      check_output: values.check_output !== undefined ? values.check_output : true,
      is_active: values.is_active !== undefined ? values.is_active : true,
    }

    try {
      if (editingEntity) {
        await dataSecurityApi.updateEntityType(editingEntity.id, data)
        toast.success(t('common.updateSuccess'))
      } else {
        // Determine which API to call based on is_global field
        if (values.is_global && user?.is_super_admin) {
          await dataSecurityApi.createGlobalEntityType(data)
          toast.success(t('entityType.createGlobalSuccess'))
        } else {
          await dataSecurityApi.createEntityType(data)
          toast.success(t('common.createSuccess'))
        }
      }

      setModalVisible(false)
      loadEntityTypes()
    } catch (error) {
      console.error('Submit error:', error)
    }
  }

  const columns: ColumnDef<EntityType>[] = [
    {
      accessorKey: 'entity_type',
      header: t('entityType.entityTypeColumn'),
      size: 150,
    },
    {
      accessorKey: 'display_name',
      header: t('entityType.displayNameColumn'),
      size: 120,
    },
    {
      id: 'risk_level',
      header: t('entityType.riskLevelColumn'),
      size: 100,
      cell: ({ row }) => {
        const risk_level = row.original.category || row.original.risk_level
        const level = RISK_LEVELS.find((l) => l.value === risk_level)
        return <Badge variant={level?.color}>{level?.label || risk_level}</Badge>
      },
    },
    {
      accessorKey: 'pattern',
      header: t('entityType.recognitionRulesColumn'),
      size: 200,
      cell: ({ row }) => {
        const pattern = row.getValue('pattern') as string
        return (
          <div className="max-w-[200px] truncate" title={pattern}>
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{pattern}</code>
          </div>
        )
      },
    },
    {
      accessorKey: 'anonymization_method',
      header: t('entityType.desensitizationMethodColumn'),
      size: 100,
      cell: ({ row }) => {
        const method = row.getValue('anonymization_method') as string
        const m = ANONYMIZATION_METHODS.find((a) => a.value === method)
        return m?.label
      },
    },
    {
      id: 'check_scope',
      header: t('entityType.detectionScopeColumn'),
      size: 100,
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.check_input && (
            <Badge variant="default" className="text-xs">
              {t('entityType.input')}
            </Badge>
          )}
          {row.original.check_output && (
            <Badge variant="outline" className="text-xs">
              {t('entityType.output')}
            </Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'is_active',
      header: t('entityType.statusColumn'),
      size: 80,
      cell: ({ row }) => {
        const is_active = row.getValue('is_active') as boolean
        return (
          <Badge variant={is_active ? 'default' : 'outline'}>
            {is_active ? t('common.enabled') : t('common.disabled')}
          </Badge>
        )
      },
    },
    {
      id: 'source_type',
      header: t('entityType.sourceColumn'),
      size: 100,
      cell: ({ row }) => {
        const sourceType =
          row.original.source_type || (row.original.is_global ? 'system_template' : 'custom')

        if (sourceType === 'system_template') {
          return (
            <Badge variant="default" className="gap-1">
              <Globe className="h-3 w-3" />
              {t('entityType.systemTemplate')}
            </Badge>
          )
        } else if (sourceType === 'system_copy') {
          return (
            <Badge variant="secondary" className="gap-1">
              <Globe className="h-3 w-3" />
              {t('entityType.systemCopy')}
            </Badge>
          )
        } else {
          return (
            <Badge variant="outline" className="gap-1">
              <User className="h-3 w-3" />
              {t('entityType.custom')}
            </Badge>
          )
        }
      },
    },
    {
      id: 'action',
      header: t('entityType.operationColumn'),
      size: 120,
      cell: ({ row }) => {
        const record = row.original
        const sourceType = record.source_type || (record.is_global ? 'system_template' : 'custom')
        const canEdit = sourceType === 'system_template' ? user?.is_super_admin : true
        const canDelete =
          sourceType === 'system_template' ? user?.is_super_admin : sourceType === 'custom'

        return (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleEdit(record)}
              disabled={!canEdit}
              title={canEdit ? t('common.edit') : t('entityType.noEditPermission')}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(record.id)}
              disabled={!canDelete}
              title={
                canDelete
                  ? t('common.delete')
                  : sourceType === 'system_copy'
                    ? t('entityType.cannotDeleteSystemCopy')
                    : t('entityType.noDeletePermission')
              }
            >
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          </div>
        )
      },
    },
  ]

  // Filter data
  const filteredEntityTypes = entityTypes.filter((item) => {
    const matchesSearch =
      !searchText ||
      item.entity_type.toLowerCase().includes(searchText.toLowerCase()) ||
      item.display_name.toLowerCase().includes(searchText.toLowerCase()) ||
      item.pattern.toLowerCase().includes(searchText.toLowerCase())

    const risk_level = item.category || item.risk_level
    const matchesRiskLevel = !riskLevelFilter || risk_level === riskLevelFilter

    return matchesSearch && matchesRiskLevel
  })

  return (
    <div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('entityType.entityTypeConfig')}</CardTitle>
          <Button onClick={handleCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('entityType.addEntityTypeConfig')}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 mb-4">
            <div className="flex gap-4">
              <Input
                placeholder={t('entityType.searchPlaceholder')}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="max-w-xs"
              />
              <Select value={riskLevelFilter} onValueChange={setRiskLevelFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder={t('entityType.filterRiskLevel')} />
                </SelectTrigger>
                <SelectContent>
                  {RISK_LEVELS.map((level) => (
                    <SelectItem key={level.value} value={level.value}>
                      {level.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(searchText || riskLevelFilter) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchText('')
                    setRiskLevelFilter(undefined)
                  }}
                >
                  {t('common.reset')}
                </Button>
              )}
            </div>
          </div>

          <DataTable columns={columns} data={filteredEntityTypes} loading={loading} />
        </CardContent>
      </Card>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="max-w-[800px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingEntity ? t('entityType.editEntityType') : t('entityType.addEntityType')}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="entity_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('entityType.entityTypeCode')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t('entityType.entityTypeCodePlaceholder')}
                        disabled={!!editingEntity}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {editingEntity && editingEntity.source_type === 'system_copy' && (
                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <Info className="h-4 w-4 text-blue-600 mt-0.5" />
                  <p className="text-sm text-blue-900">{t('entityType.systemCopyEditHint')}</p>
                </div>
              )}

              <FormField
                control={form.control}
                name="display_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('entityType.displayNameLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={t('entityType.displayNamePlaceholder')} />
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
                    <FormLabel>{t('entityType.riskLevelLabel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('entityType.riskLevelPlaceholder')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {RISK_LEVELS.map((level) => (
                          <SelectItem key={level.value} value={level.value}>
                            {level.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="pattern"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t('entityType.recognitionRuleLabel')}
                      <span className="ml-2 text-xs text-gray-500">
                        {t('entityType.recognitionRuleTooltip')}
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        rows={3}
                        placeholder={t('entityType.recognitionRulePlaceholder')}
                        className="font-mono"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="anonymization_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('entityType.anonymizationMethodLabel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={t('entityType.anonymizationMethodPlaceholder')}
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ANONYMIZATION_METHODS.map((method) => (
                          <SelectItem key={method.value} value={method.value}>
                            {method.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="anonymization_config_text"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('entityType.anonymizationConfigLabel')}</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        rows={4}
                        placeholder={t('entityType.anonymizationConfigPlaceholder')}
                        className="font-mono"
                      />
                    </FormControl>
                    <Card className="mt-2 bg-gray-50">
                      <CardContent className="p-3">
                        <p className="text-xs font-semibold mb-2">
                          {t('entityType.anonymizationMethodConfigDesc')}
                        </p>
                        <ul className="space-y-2 text-xs text-gray-700 list-disc pl-4">
                          <li>
                            <code className="bg-gray-200 px-1 rounded">replace</code> -{' '}
                            {t('entityType.replaceDesc')}
                            <br />
                            <span className="text-gray-600">{t('entityType.replaceExample')}</span>
                          </li>
                          <li>
                            <code className="bg-gray-200 px-1 rounded">mask</code> -{' '}
                            {t('entityType.maskDesc')}
                            <br />
                            <span className="text-gray-600">{t('entityType.maskExample')}</span>
                            <br />
                            <span className="text-gray-600">{t('entityType.maskExample2')}</span>
                          </li>
                          <li>
                            <code className="bg-gray-200 px-1 rounded">hash</code> -{' '}
                            {t('entityType.hashDesc')}
                            <br />
                            <span className="text-gray-600">{t('entityType.hashExample')}</span>
                          </li>
                          <li>
                            <code className="bg-gray-200 px-1 rounded">encrypt</code> -{' '}
                            {t('entityType.encryptDesc')}
                            <br />
                            <span className="text-gray-600">{t('entityType.encryptExample')}</span>
                          </li>
                          <li>
                            <code className="bg-gray-200 px-1 rounded">shuffle</code> -{' '}
                            {t('entityType.shuffleDesc')}
                            <br />
                            <span className="text-gray-600">{t('entityType.shuffleExample')}</span>
                          </li>
                          <li>
                            <code className="bg-gray-200 px-1 rounded">random</code> -{' '}
                            {t('entityType.randomDesc')}
                            <br />
                            <span className="text-gray-600">{t('entityType.randomExample')}</span>
                          </li>
                        </ul>
                      </CardContent>
                    </Card>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div>
                <FormLabel>{t('entityType.detectionScopeLabel')}</FormLabel>
                <div className="flex gap-4 mt-2">
                  <FormField
                    control={form.control}
                    name="check_input"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0">
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <FormLabel className="!mt-0 font-normal">
                          {t('entityType.inputSwitch')}
                        </FormLabel>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="check_output"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0">
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <FormLabel className="!mt-0 font-normal">
                          {t('entityType.outputSwitch')}
                        </FormLabel>
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <FormField
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between border rounded-lg p-3">
                    <div>
                      <FormLabel>{t('entityType.enableStatusLabel')}</FormLabel>
                    </div>
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
                    <FormItem className="flex items-center justify-between border rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <FormLabel>{t('entityType.systemConfigLabel')}</FormLabel>
                        <Info
                          className="h-4 w-4 text-gray-400"
                          title={t('entityType.systemConfigTooltip')}
                        />
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setModalVisible(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">{t('common.confirm')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default EntityTypeManagement
