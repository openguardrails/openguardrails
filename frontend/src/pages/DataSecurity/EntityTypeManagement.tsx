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
import { confirmDialog } from '@/utils/confirm-dialog'
import { dataSecurityApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { ColumnDef } from '@tanstack/react-table'

interface EntityType {
  id: string
  entity_type: string
  entity_type_name: string
  risk_level?: string // Frontend field name
  category?: string // Backend field name (alias for risk_level)
  recognition_method?: string // 'regex' or 'genai'
  pattern: string
  entity_definition?: string // For genai method
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
    { value: 'high', label: t('entityType.highRisk'), color: 'destructive' as const },
    { value: 'medium', label: t('entityType.mediumRisk'), color: 'default' as const },
    { value: 'low', label: t('entityType.lowRisk'), color: 'outline' as const },
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
    entity_type: z.string().min(1, t('entityType.entityTypeCodeRequired')).refine(
      (val) => !/\s/.test(val),
      { message: t('entityType.entityTypeCodeNoSpaces') }
    ),
    entity_type_name: z.string().min(1, t('entityType.entityTypeNameRequired')),
    risk_level: z.string().min(1, t('entityType.riskLevelRequired')),
    recognition_method: z.string().default('regex'),
    pattern: z.string().optional(),
    entity_definition: z.string().optional(),
    anonymization_method: z.string().min(1, t('entityType.anonymizationMethodRequired')),
    // Regex masking configuration
    replace_text: z.string().optional(), // replace method replacement content
    mask_keep_prefix: z.string().optional(), // mask method keep prefix
    mask_keep_suffix: z.string().optional(), // mask method keep suffix
    mask_char: z.string().optional(), // mask method mask character
    // GenAI masking configuration
    masking_rule: z.string().optional(), // GenAI masking rule
    check_input: z.boolean().default(true),
    check_output: z.boolean().default(true),
    is_active: z.boolean().default(true),
    is_global: z.boolean().optional(),
  }).superRefine((data, ctx) => {
    if (data.recognition_method === 'regex') {
      if (!data.pattern || data.pattern.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('entityType.recognitionRuleRequired'),
          path: ['pattern'],
        })
      }
    } else if (data.recognition_method === 'genai') {
      if (!data.entity_definition || data.entity_definition.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('entityType.recognitionRuleRequired'),
          path: ['entity_definition'],
        })
      }
    }
  })

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      recognition_method: 'regex',
      is_active: true,
      check_input: true,
      check_output: true,
      anonymization_method: 'replace',
      is_global: false,
      mask_char: '*',
      mask_keep_prefix: '',
      mask_keep_suffix: '',
      replace_text: '',
      masking_rule: '',
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
      recognition_method: 'regex',
      is_active: true,
      check_input: true,
      check_output: true,
      anonymization_method: 'replace',
      is_global: false,
      mask_char: '*',
      mask_keep_prefix: '',
      mask_keep_suffix: '',
      replace_text: '',
      masking_rule: '',
    })
    setModalVisible(true)
  }

  const handleEdit = (record: EntityType) => {
    setEditingEntity(record)
    const recognitionMethod = record.recognition_method || 'regex'
    const config = record.anonymization_config || {}

    // Parse masking configuration
    let replace_text = ''
    let mask_keep_prefix = ''
    let mask_keep_suffix = ''
    let mask_char = '*'
    let masking_rule = ''

    if (recognitionMethod === 'regex') {
      if (record.anonymization_method === 'replace') {
        replace_text = config.replacement || ''
      } else if (record.anonymization_method === 'mask') {
        mask_keep_prefix = config.keep_prefix !== undefined ? String(config.keep_prefix) : ''
        mask_keep_suffix = config.keep_suffix !== undefined ? String(config.keep_suffix) : ''
        mask_char = config.mask_char || '*'
      }
    } else {
      masking_rule = config.masking_rule || ''
    }

    form.reset({
      entity_type: record.entity_type,
      entity_type_name: record.entity_type_name,
      risk_level: record.category || record.risk_level,
      recognition_method: recognitionMethod,
      pattern: record.pattern,
      entity_definition: record.entity_definition,
      anonymization_method: recognitionMethod === 'genai' ? 'genai' : record.anonymization_method,
      replace_text,
      mask_keep_prefix,
      mask_keep_suffix,
      mask_char,
      masking_rule,
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
    const recognitionMethod = values.recognition_method || 'regex'

    // Build masking configuration
    let anonymization_config: any = {}

    if (recognitionMethod === 'genai') {
      // GenAI configuration
      if (values.masking_rule) {
        anonymization_config.masking_rule = values.masking_rule
      }
    } else {
      // Regex configuration
      const method = values.anonymization_method

      if (method === 'replace') {
        anonymization_config.replacement = values.replace_text || `<${values.entity_type}>`
      } else if (method === 'mask') {
        anonymization_config.mask_char = values.mask_char || '*'
        const keepPrefix = values.mask_keep_prefix ? parseInt(values.mask_keep_prefix) : 0
        const keepSuffix = values.mask_keep_suffix ? parseInt(values.mask_keep_suffix) : 0
        anonymization_config.keep_prefix = keepPrefix
        anonymization_config.keep_suffix = keepSuffix
      }
      // hash, encrypt, shuffle, random no configuration needed
    }

    const data: any = {
      entity_type: values.entity_type,
      entity_type_name: values.entity_type_name,
      category: values.risk_level,
      recognition_method: recognitionMethod,
      // GenAI type fixed using genai masking method, Regex type using user selected method
      anonymization_method: recognitionMethod === 'genai' ? 'genai' : values.anonymization_method,
      anonymization_config,
      check_input: values.check_input !== undefined ? values.check_input : true,
      check_output: values.check_output !== undefined ? values.check_output : true,
      is_active: values.is_active !== undefined ? values.is_active : true,
    }

    // Add pattern or entity_definition based on recognition method
    if (recognitionMethod === 'genai') {
      data.entity_definition = values.entity_definition
    } else {
      data.pattern = values.pattern
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
      accessorKey: 'entity_type_name',
      header: t('entityType.entityTypeNameColumn'),
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
      id: 'recognition_method',
      header: t('entityType.recognitionMethodColumn'),
      size: 100,
      cell: ({ row }) => {
        const method = row.original.recognition_method || 'regex'
        return (
          <Badge variant="outline">
            {method === 'genai' ? t('entityType.aiRecognition') : t('entityType.regexRecognition')}
          </Badge>
        )
      },
    },
    {
      id: 'recognition_rule',
      header: t('entityType.recognitionRulesColumn'),
      size: 200,
      cell: ({ row }) => {
        const method = row.original.recognition_method || 'regex'
        const content = method === 'genai' ? row.original.entity_definition : row.original.pattern
        return (
          <div className="max-w-[200px] truncate" title={content}>
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">{content}</code>
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
        const recognitionMethod = row.original.recognition_method || 'regex'

        // GenAI type display "AI masking"
        if (recognitionMethod === 'genai' || method === 'genai') {
          return <Badge variant="default">{t('entityType.aiDesensitization')}</Badge>
        }

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
      item.entity_type_name.toLowerCase().includes(searchText.toLowerCase()) ||
      (item.pattern && item.pattern.toLowerCase().includes(searchText.toLowerCase())) ||
      (item.entity_definition && item.entity_definition.toLowerCase().includes(searchText.toLowerCase()))

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
                name="entity_type_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('entityType.entityTypeNameLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={t('entityType.entityTypeNamePlaceholder')} />
                    </FormControl>
                    <p className="text-xs text-gray-500 mt-1">
                      {t('entityType.entityTypeNameDescription')}
                    </p>
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
                name="recognition_method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('entityType.recognitionMethodLabel')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('entityType.recognitionMethodPlaceholder')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="regex">{t('entityType.recognitionMethodRegex')}</SelectItem>
                        <SelectItem value="genai">{t('entityType.recognitionMethodGenai')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {form.watch('recognition_method') === 'regex' ? (
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
              ) : (
                <FormField
                  control={form.control}
                  name="entity_definition"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t('entityType.entityDefinitionLabel')}
                        <span className="ml-2 text-xs text-gray-500">
                          {t('entityType.entityDefinitionTooltip')}
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={3}
                          placeholder={t('entityType.entityDefinitionPlaceholder')}
                        />
                      </FormControl>
                      <Card className="mt-2 bg-green-50 border-green-200">
                        <CardContent className="p-3">
                          <p className="text-xs font-semibold text-green-900 mb-2">
                            {t('entityType.entityDefinitionExamplesTitle')}
                          </p>
                          <ul className="text-xs text-green-800 space-y-1.5 list-none">
                            <li className="bg-white/50 p-1.5 rounded">
                              • {t('entityType.entityDefinitionExamplePhone')}
                            </li>
                            <li className="bg-white/50 p-1.5 rounded">
                              • {t('entityType.entityDefinitionExampleIdCard')}
                            </li>
                            <li className="bg-white/50 p-1.5 rounded">
                              • {t('entityType.entityDefinitionExampleAddress')}
                            </li>
                            <li className="bg-white/50 p-1.5 rounded">
                              • {t('entityType.entityDefinitionExampleBankCard')}
                            </li>
                            <li className="bg-white/50 p-1.5 rounded">
                              • {t('entityType.entityDefinitionExampleName')}
                            </li>
                          </ul>
                          <p className="text-xs text-green-700 mt-2 pt-2 border-t border-green-300">
                            {t('entityType.entityDefinitionExamplesHint')}
                          </p>
                        </CardContent>
                      </Card>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {form.watch('recognition_method') === 'regex' && (
                <>
                  <FormField
                    control={form.control}
                    name="anonymization_method"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('entityType.anonymizationMethodSelectLabel')}</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={t('entityType.anonymizationMethodSelectPlaceholder')} />
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

                  {form.watch('anonymization_method') === 'replace' && (
                    <FormField
                      control={form.control}
                      name="replace_text"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.replaceText')}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder={t('entityType.replaceTextPlaceholder')}
                            />
                          </FormControl>
                          <p className="text-xs text-gray-500 mt-1">
                            {t('entityType.replaceTextHint')}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {form.watch('anonymization_method') === 'mask' && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-3 gap-4">
                        <FormField
                          control={form.control}
                          name="mask_keep_prefix"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.maskKeepPrefix')}</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  min="0"
                                  placeholder="0"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="mask_keep_suffix"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.maskKeepSuffix')}</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  min="0"
                                  placeholder="0"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="mask_char"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.maskChar')}</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  maxLength={1}
                                  placeholder="*"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <Card className="bg-blue-50 border-blue-200">
                        <CardContent className="p-3">
                          <p className="text-xs text-blue-900">
                            <strong>{t('entityType.maskExampleTitle')}</strong>{t('entityType.maskExamplePhone')}
                          </p>
                          <ul className="text-xs text-blue-800 mt-2 space-y-1">
                            <li>• {t('entityType.maskExample1')}</li>
                            <li>• {t('entityType.maskExample2Str')}</li>
                            <li>• {t('entityType.maskExample3')}</li>
                          </ul>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {['hash', 'encrypt', 'shuffle', 'random'].includes(
                    form.watch('anonymization_method') || ''
                  ) && (
                    <Card className="bg-gray-50">
                      <CardContent className="p-3">
                        <p className="text-xs text-gray-700">
                          <strong>{form.watch('anonymization_method')}</strong> {t('entityType.anonymizationMethodNoConfig')}
                        </p>
                        {form.watch('anonymization_method') === 'hash' && (
                          <p className="text-xs text-gray-600 mt-2">
                            {t('entityType.example')}: 13822323234 → a3f5e8d2c1b4
                          </p>
                        )}
                        {form.watch('anonymization_method') === 'encrypt' && (
                          <p className="text-xs text-gray-600 mt-2">
                            {t('entityType.example')}: 13822323234 → &lt;ENCRYPTED_a3f5e8d2&gt;
                          </p>
                        )}
                        {form.watch('anonymization_method') === 'shuffle' && (
                          <p className="text-xs text-gray-600 mt-2">
                            {t('entityType.example')}: 13822323234 → 32438223134
                          </p>
                        )}
                        {form.watch('anonymization_method') === 'random' && (
                          <p className="text-xs text-gray-600 mt-2">
                            {t('entityType.example')}: 13822323234 → 97354861029
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </>
              )}

              {form.watch('recognition_method') === 'genai' && (
                <>
                  <Card className="bg-yellow-50 border-yellow-300">
                    <CardContent className="p-3">
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-yellow-900 mb-1">
                            {t('entityType.genaiDefaultBehaviorTitle')}
                          </p>
                          <p className="text-xs text-yellow-800">
                            {t('entityType.genaiDefaultBehaviorFormat')} <code className="bg-yellow-200 px-1 py-0.5 rounded">[REDACTED_{(form.watch('entity_type_name') || 'ENTITY_NAME').toUpperCase().replace(/\s+/g, '_')}]</code>
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <FormField
                    control={form.control}
                    name="masking_rule"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('entityType.maskingRule')}</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            rows={3}
                            placeholder={t('entityType.maskingRulePlaceholder')}
                          />
                        </FormControl>
                        <p className="text-xs text-gray-500 mt-1">
                          {t('entityType.maskingRuleHint')} [REDACTED_{(form.watch('entity_type_name') || 'ENTITY_NAME').toUpperCase().replace(/\s+/g, '_')}]
                        </p>
                      <Card className="mt-2 bg-blue-50 border-blue-200">
                        <CardContent className="p-3">
                          <p className="text-xs font-semibold text-blue-900 mb-2">
                            {t('entityType.genaiMaskingTitle')}
                          </p>
                          <p className="text-xs text-blue-800 mb-3">
                            {t('entityType.genaiMaskingDescription')}
                          </p>
                          <div className="space-y-3">
                            <div>
                              <p className="text-xs font-semibold text-blue-900">{t('entityType.genaiRuleExamplesTitle')}</p>
                              <ul className="text-xs text-blue-800 mt-1 space-y-2 list-none">
                                <li className="bg-white/50 p-2 rounded">
                                  <span className="font-semibold">{t('entityType.genaiExample1Rule')}</span>{t('entityType.genaiExample1RuleText')}
                                  <br />
                                  <span className="text-blue-600">{t('entityType.genaiExample1Effect')}</span>{t('entityType.genaiExample1EffectText')}
                                </li>
                                <li className="bg-white/50 p-2 rounded">
                                  <span className="font-semibold">{t('entityType.genaiExample1Rule')}</span>{t('entityType.genaiExample2RuleText')}
                                  <br />
                                  <span className="text-blue-600">{t('entityType.genaiExample1Effect')}</span>{t('entityType.genaiExample2EffectText')}
                                </li>
                                <li className="bg-white/50 p-2 rounded">
                                  <span className="font-semibold">{t('entityType.genaiExample1Rule')}</span>{t('entityType.genaiExample3RuleText')}
                                  <br />
                                  <span className="text-blue-600">{t('entityType.genaiExample1Effect')}</span>{t('entityType.genaiExample3EffectText')}
                                </li>
                                <li className="bg-white/50 p-2 rounded">
                                  <span className="font-semibold">{t('entityType.genaiExample1Rule')}</span>{t('entityType.genaiExample4RuleText')}
                                  <br />
                                  <span className="text-blue-600">{t('entityType.genaiExample1Effect')}</span>{t('entityType.genaiExample4EffectText')}
                                </li>
                              </ul>
                            </div>
                            <div className="border-t border-blue-300 pt-2">
                              <p className="text-xs text-blue-700">
                                {t('entityType.genaiMaskingHint')}
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                      <FormMessage />
                    </FormItem>
                  )}
                  />
                </>
              )}

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
