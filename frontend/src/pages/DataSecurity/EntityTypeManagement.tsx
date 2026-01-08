import React, { useState, useEffect } from 'react'
import { Plus, Edit, Trash2, Globe, User, Info, Loader2, Wand2, Play, FileText, Search, Shield, Settings, ChevronDown, ChevronRight, Code } from 'lucide-react'
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
  // Restore anonymization fields
  restore_enabled?: boolean
  restore_code?: string // AI-generated Python code for anonymization
  restore_code_hash?: string
  restore_natural_desc?: string
  has_restore_code?: boolean
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

  // Anonymization methods for "only anonymize" mode
  const ANONYMIZATION_METHODS = [
    { value: 'regex_replace', label: t('entityType.regexReplace') },
    { value: 'genai', label: t('entityType.genaiAnonymize') },
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
  // States for anonymization
  const [generatingRegex, setGeneratingRegex] = useState(false)
  const [testingAnonymization, setTestingAnonymization] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  // States for recognition regex
  const [generatingRecognitionRegex, setGeneratingRecognitionRegex] = useState(false)
  const [testingRecognitionRegex, setTestingRecognitionRegex] = useState(false)
  const [recognitionTestResult, setRecognitionTestResult] = useState<{
    matched: boolean
    matches: string[]
    error?: string
  } | null>(null)
  // State for entity type code generation
  const [generatingEntityTypeCode, setGeneratingEntityTypeCode] = useState(false)
  // State for GenAI entity definition testing
  const [testingEntityDefinition, setTestingEntityDefinition] = useState(false)
  const [entityDefinitionTestResult, setEntityDefinitionTestResult] = useState<{
    matched: boolean
    matches: string[]
    error?: string
  } | null>(null)
  // State for restore anonymization
  const [generatingRestoreCode, setGeneratingRestoreCode] = useState(false)
  const [testingRestoreAnonymization, setTestingRestoreAnonymization] = useState(false)
  const [restoreTestResult, setRestoreTestResult] = useState<{
    anonymized_text: string
    mapping: Record<string, string>
    error?: string
  } | null>(null)
  const [showRestoreCode, setShowRestoreCode] = useState(false)
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
    // Anonymization mode: 'only_anonymize' or 'anonymize_restore'
    anonymization_mode: z.string().default('only_anonymize'),
    anonymization_method: z.string().default('replace'),
    // Regex masking configuration
    replace_text: z.string().optional(), // replace method replacement content
    mask_keep_prefix: z.string().optional(), // mask method keep prefix
    mask_keep_suffix: z.string().optional(), // mask method keep suffix
    mask_char: z.string().optional(), // mask method mask character
    // Regex replace configuration
    regex_natural_desc: z.string().optional(), // natural language description for regex generation
    regex_pattern: z.string().optional(), // regex pattern for anonymization
    regex_replacement: z.string().optional(), // replacement template (\1, \2 for Python regex)
    // GenAI anonymization configuration
    genai_anonymization_prompt: z.string().optional(), // AI anonymization instruction
    // Recognition regex configuration
    recognition_natural_desc: z.string().optional(), // natural language description for recognition regex generation
    recognition_test_input: z.string().optional(), // test input for recognition regex testing
    // GenAI entity definition test input
    entity_definition_test_input: z.string().optional(), // test input for GenAI entity definition testing
    // Test input for anonymization
    test_input: z.string().optional(), // sample data for testing
    // Restore anonymization configuration (for anonymize_restore mode)
    restore_natural_desc: z.string().optional(), // natural language description for restore code generation
    restore_test_input: z.string().optional(), // test input for restore anonymization testing
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
    // Validate anonymization method is required only for only_anonymize mode
    if (data.anonymization_mode === 'only_anonymize') {
      if (!data.anonymization_method || data.anonymization_method.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('entityType.anonymizationMethodRequired'),
          path: ['anonymization_method'],
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
      anonymization_mode: 'only_anonymize',
      anonymization_method: 'replace',
      is_global: false,
      mask_char: '*',
      mask_keep_prefix: '',
      mask_keep_suffix: '',
      replace_text: '',
      regex_natural_desc: '',
      regex_pattern: '',
      regex_replacement: '',
      genai_anonymization_prompt: '',
      recognition_natural_desc: '',
      recognition_test_input: '',
      entity_definition_test_input: '',
      test_input: '',
      restore_natural_desc: '',
      restore_test_input: '',
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
    setTestResult(null)
    setRecognitionTestResult(null)
    setEntityDefinitionTestResult(null)
    setRestoreTestResult(null)
    form.reset({
      recognition_method: 'regex',
      is_active: true,
      check_input: true,
      check_output: true,
      anonymization_mode: 'only_anonymize',
      anonymization_method: 'replace',
      is_global: false,
      mask_char: '*',
      mask_keep_prefix: '',
      mask_keep_suffix: '',
      replace_text: '',
      regex_natural_desc: '',
      regex_pattern: '',
      regex_replacement: '',
      genai_anonymization_prompt: '',
      recognition_natural_desc: '',
      recognition_test_input: '',
      entity_definition_test_input: '',
      test_input: '',
      restore_natural_desc: '',
      restore_test_input: '',
    })
    setModalVisible(true)
  }

  const handleEdit = (record: EntityType) => {
    setEditingEntity(record)
    setTestResult(null)
    setRecognitionTestResult(null)
    setEntityDefinitionTestResult(null)
    setRestoreTestResult(null)
    const recognitionMethod = record.recognition_method || 'regex'
    const config = record.anonymization_config || {}

    // Parse masking configuration based on anonymization method
    let replace_text = ''
    let mask_keep_prefix = ''
    let mask_keep_suffix = ''
    let mask_char = '*'
    let regex_natural_desc = ''
    let regex_pattern = ''
    let regex_replacement = ''
    let genai_anonymization_prompt = ''

    const anonymizationMethod = record.anonymization_method || 'replace'

    if (anonymizationMethod === 'replace') {
      replace_text = config.replacement || ''
    } else if (anonymizationMethod === 'mask') {
      mask_keep_prefix = config.keep_prefix !== undefined ? String(config.keep_prefix) : ''
      mask_keep_suffix = config.keep_suffix !== undefined ? String(config.keep_suffix) : ''
      mask_char = config.mask_char || '*'
    } else if (anonymizationMethod === 'regex_replace') {
      regex_natural_desc = config.natural_language_desc || ''
      regex_pattern = config.regex_pattern || ''
      regex_replacement = config.replacement_template || ''
    } else if (anonymizationMethod === 'genai') {
      genai_anonymization_prompt = config.anonymization_prompt || ''
    }

    // Determine anonymization mode: if restore_enabled is true, it's 'anonymize_restore'
    const anonymizationMode = record.restore_enabled ? 'anonymize_restore' : 'only_anonymize'

    form.reset({
      entity_type: record.entity_type,
      entity_type_name: record.entity_type_name,
      risk_level: record.category || record.risk_level,
      recognition_method: recognitionMethod,
      pattern: record.pattern,
      entity_definition: record.entity_definition,
      anonymization_mode: anonymizationMode,
      anonymization_method: anonymizationMethod,
      replace_text,
      mask_keep_prefix,
      mask_keep_suffix,
      mask_char,
      regex_natural_desc,
      regex_pattern,
      regex_replacement,
      genai_anonymization_prompt,
      recognition_natural_desc: '',
      recognition_test_input: '',
      entity_definition_test_input: '',
      check_input: record.check_input,
      check_output: record.check_output,
      is_active: record.is_active,
      test_input: '',
      restore_natural_desc: record.restore_natural_desc || '',
      restore_test_input: '',
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
    const anonymizationMode = values.anonymization_mode || 'only_anonymize'
    const anonymizationMethod = values.anonymization_method || 'replace'

    // Build anonymization configuration based on mode and method
    let anonymization_config: any = {}
    let restore_enabled = false

    if (anonymizationMode === 'anonymize_restore') {
      // For restore mode, use replace method with placeholder
      restore_enabled = true
      anonymization_config = {
        replacement: `<${values.entity_type}>`,
      }
    } else {
      // For only_anonymize mode
      switch (anonymizationMethod) {
        case 'replace':
          anonymization_config = {
            replacement: values.replace_text || `<${values.entity_type}>`,
          }
          break
        case 'mask':
          anonymization_config = {
            mask_char: values.mask_char || '*',
            keep_prefix: values.mask_keep_prefix ? parseInt(values.mask_keep_prefix) : 0,
            keep_suffix: values.mask_keep_suffix ? parseInt(values.mask_keep_suffix) : 0,
          }
          break
        case 'regex_replace':
          anonymization_config = {
            regex_pattern: values.regex_pattern || '',
            replacement_template: values.regex_replacement || '***',
            natural_language_desc: values.regex_natural_desc || '',
          }
          break
        case 'genai':
          anonymization_config = {
            anonymization_prompt: values.genai_anonymization_prompt || '',
          }
          break
        // hash, encrypt, shuffle, random - no configuration needed
      }
    }

    const data: any = {
      entity_type: values.entity_type,
      entity_type_name: values.entity_type_name,
      category: values.risk_level,
      recognition_method: recognitionMethod,
      anonymization_method: anonymizationMode === 'anonymize_restore' ? 'replace' : anonymizationMethod,
      anonymization_config,
      check_input: values.check_input !== undefined ? values.check_input : true,
      check_output: values.check_output !== undefined ? values.check_output : true,
      is_active: values.is_active !== undefined ? values.is_active : true,
      restore_enabled,
      restore_natural_desc: values.restore_natural_desc || '',
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

  // Generate anonymization regex using AI
  const handleGenerateRegex = async () => {
    const desc = form.getValues('regex_natural_desc')
    const entityType = form.getValues('entity_type')
    const testInput = form.getValues('test_input')

    if (!desc) {
      toast.error(t('entityType.pleaseEnterDescription'))
      return
    }

    setGeneratingRegex(true)
    try {
      const result = await dataSecurityApi.generateAnonymizationRegex({
        description: desc,
        entity_type: entityType || 'ENTITY',
        sample_data: testInput || undefined,
      })

      if (result.success) {
        form.setValue('regex_pattern', result.regex_pattern)
        form.setValue('regex_replacement', result.replacement_template)
        toast.success(result.explanation || t('entityType.generateRegexSuccess'))
      } else {
        toast.error(result.explanation || t('entityType.generateRegexFailed'))
      }
    } catch (error) {
      console.error('Generate regex error:', error)
      toast.error(t('entityType.generateRegexFailed'))
    } finally {
      setGeneratingRegex(false)
    }
  }

  // Test anonymization effect (for only_anonymize mode)
  const handleTestAnonymization = async () => {
    const method = form.getValues('anonymization_method')
    const testInput = form.getValues('test_input')

    if (!testInput) {
      toast.error(t('entityType.pleaseEnterTestInput'))
      return
    }

    let config: Record<string, any> = {}

    switch (method) {
      case 'mask':
        config = {
          mask_char: form.getValues('mask_char') || '*',
          keep_prefix: form.getValues('mask_keep_prefix') ? parseInt(form.getValues('mask_keep_prefix')) : 0,
          keep_suffix: form.getValues('mask_keep_suffix') ? parseInt(form.getValues('mask_keep_suffix')) : 0,
        }
        break
      case 'replace':
        config = {
          replacement: form.getValues('replace_text') || `<${form.getValues('entity_type')}>`,
        }
        break
      case 'regex_replace':
        config = {
          regex_pattern: form.getValues('regex_pattern'),
          replacement_template: form.getValues('regex_replacement'),
        }
        break
      case 'genai':
        config = {
          anonymization_prompt: form.getValues('genai_anonymization_prompt'),
        }
        break
    }

    setTestingAnonymization(true)
    setTestResult(null)

    try {
      const result = await dataSecurityApi.testAnonymization({
        method,
        config,
        test_input: testInput,
      })

      if (result.success) {
        setTestResult(result.result)
      } else {
        toast.error(result.result || t('entityType.testFailed'))
      }
    } catch (error) {
      console.error('Test anonymization error:', error)
      toast.error(t('entityType.testFailed'))
    } finally {
      setTestingAnonymization(false)
    }
  }

  // Generate recognition regex using AI
  const handleGenerateRecognitionRegex = async () => {
    const desc = form.getValues('recognition_natural_desc')
    const entityType = form.getValues('entity_type')
    const entityTypeName = form.getValues('entity_type_name')
    const testInput = form.getValues('recognition_test_input')

    if (!desc) {
      toast.error(t('entityType.pleaseEnterRecognitionDescription'))
      return
    }

    setGeneratingRecognitionRegex(true)
    try {
      const result = await dataSecurityApi.generateRecognitionRegex({
        description: desc,
        entity_type: entityTypeName || entityType || 'ENTITY',
        sample_data: testInput || undefined,
      })

      if (result.success) {
        form.setValue('pattern', result.regex_pattern)
        toast.success(result.explanation || t('entityType.generateRecognitionRegexSuccess'))
      } else {
        toast.error(result.explanation || t('entityType.generateRecognitionRegexFailed'))
      }
    } catch (error) {
      console.error('Generate recognition regex error:', error)
      toast.error(t('entityType.generateRecognitionRegexFailed'))
    } finally {
      setGeneratingRecognitionRegex(false)
    }
  }

  // Test recognition regex
  const handleTestRecognitionRegex = async () => {
    const pattern = form.getValues('pattern')
    const testInput = form.getValues('recognition_test_input')

    if (!pattern) {
      toast.error(t('entityType.pleaseEnterPattern'))
      return
    }
    if (!testInput) {
      toast.error(t('entityType.pleaseEnterRecognitionTestInput'))
      return
    }

    setTestingRecognitionRegex(true)
    setRecognitionTestResult(null)

    try {
      const result = await dataSecurityApi.testRecognitionRegex({
        pattern,
        test_input: testInput,
      })

      if (result.success) {
        setRecognitionTestResult({
          matched: result.matched,
          matches: result.matches,
        })
      } else {
        setRecognitionTestResult({
          matched: false,
          matches: [],
          error: result.error,
        })
      }
    } catch (error) {
      console.error('Test recognition regex error:', error)
      toast.error(t('entityType.testRecognitionRegexFailed'))
    } finally {
      setTestingRecognitionRegex(false)
    }
  }

  // Test GenAI entity definition
  const handleTestEntityDefinition = async () => {
    const entityDefinition = form.getValues('entity_definition')
    const entityTypeName = form.getValues('entity_type_name')
    const testInput = form.getValues('entity_definition_test_input')

    if (!entityDefinition) {
      toast.error(t('entityType.pleaseEnterEntityDefinition'))
      return
    }
    if (!testInput) {
      toast.error(t('entityType.pleaseEnterEntityDefinitionTestInput'))
      return
    }

    setTestingEntityDefinition(true)
    setEntityDefinitionTestResult(null)

    try {
      const result = await dataSecurityApi.testEntityDefinition({
        entity_definition: entityDefinition,
        entity_type_name: entityTypeName || '',
        test_input: testInput,
      })

      if (result.success) {
        setEntityDefinitionTestResult({
          matched: result.matched,
          matches: result.matches,
        })
      } else {
        setEntityDefinitionTestResult({
          matched: false,
          matches: [],
          error: result.error,
        })
      }
    } catch (error) {
      console.error('Test entity definition error:', error)
      toast.error(t('entityType.testEntityDefinitionFailed'))
    } finally {
      setTestingEntityDefinition(false)
    }
  }

  // Generate restore anonymization code using AI
  const handleGenerateRestoreCode = async () => {
    if (!editingEntity) {
      toast.error(t('entityType.saveFirstForRestoreCode'))
      return
    }

    const naturalDesc = form.getValues('restore_natural_desc')
    const testInput = form.getValues('restore_test_input')

    if (!naturalDesc) {
      toast.error(t('entityType.pleaseEnterRestoreDescription'))
      return
    }

    setGeneratingRestoreCode(true)
    try {
      const result = await dataSecurityApi.generateRestoreCode(editingEntity.id, {
        natural_description: naturalDesc,
        sample_data: testInput || undefined,
      })

      if (result.success && result.code_generated) {
        toast.success(result.message || t('entityType.generateRestoreCodeSuccess'))
        // Update editingEntity with the generated code
        if (result.restore_code) {
          setEditingEntity({
            ...editingEntity,
            restore_code: result.restore_code,
            has_restore_code: true,
          })
        }
        // Refresh entity list
        loadEntityTypes()
      } else {
        toast.error(result.error || result.message || t('entityType.generateRestoreCodeFailed'))
      }
    } catch (error) {
      console.error('Generate restore code error:', error)
      toast.error(t('entityType.generateRestoreCodeFailed'))
    } finally {
      setGeneratingRestoreCode(false)
    }
  }

  // Test restore anonymization
  const handleTestRestoreAnonymization = async () => {
    if (!editingEntity) {
      toast.error(t('entityType.saveFirstForRestoreTest'))
      return
    }

    const testInput = form.getValues('restore_test_input')

    if (!testInput) {
      toast.error(t('entityType.pleaseEnterRestoreTestInput'))
      return
    }

    setTestingRestoreAnonymization(true)
    setRestoreTestResult(null)

    try {
      const result = await dataSecurityApi.testRestoreAnonymization(editingEntity.id, {
        test_input: testInput,
      })

      if (result.success) {
        setRestoreTestResult({
          anonymized_text: result.anonymized_text,
          mapping: result.mapping,
        })
      } else {
        setRestoreTestResult({
          anonymized_text: '',
          mapping: {},
          error: result.error,
        })
      }
    } catch (error) {
      console.error('Test restore anonymization error:', error)
      toast.error(t('entityType.testRestoreAnonymizationFailed'))
    } finally {
      setTestingRestoreAnonymization(false)
    }
  }

  // Generate entity type code using AI
  const handleGenerateEntityTypeCode = async (entityTypeName: string) => {
    if (!entityTypeName || entityTypeName.trim().length === 0) {
      return
    }

    setGeneratingEntityTypeCode(true)
    try {
      const result = await dataSecurityApi.generateEntityTypeCode({
        entity_type_name: entityTypeName.trim(),
      })

      if (result.success && result.entity_type_code) {
        form.setValue('entity_type', result.entity_type_code)
      } else {
        // Fallback: simple conversion for English names
        const fallbackCode = entityTypeName
          .toUpperCase()
          .replace(/[^A-Z\s]/g, '')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
        if (fallbackCode) {
          form.setValue('entity_type', fallbackCode)
        }
      }
    } catch (error) {
      console.error('Generate entity type code error:', error)
      // Fallback on error
      const fallbackCode = entityTypeName
        .toUpperCase()
        .replace(/[^A-Z\s]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
      if (fallbackCode) {
        form.setValue('entity_type', fallbackCode)
      }
    } finally {
      setGeneratingEntityTypeCode(false)
    }
  }

  const columns: ColumnDef<EntityType>[] = [
    {
      accessorKey: 'entity_type',
      header: t('entityType.entityTypeColumn'),
      cell: ({ row }) => (
        <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded whitespace-nowrap">
          {row.getValue('entity_type')}
        </code>
      ),
    },
    {
      accessorKey: 'entity_type_name',
      header: t('entityType.entityTypeNameColumn'),
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{row.getValue('entity_type_name')}</span>
      ),
    },
    {
      id: 'risk_level',
      header: t('entityType.riskLevelColumn'),
      cell: ({ row }) => {
        const risk_level = row.original.category || row.original.risk_level
        const level = RISK_LEVELS.find((l) => l.value === risk_level)
        return <Badge variant={level?.color}>{level?.label || risk_level}</Badge>
      },
    },
    {
      id: 'recognition_method',
      header: t('entityType.recognitionMethodColumn'),
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
      accessorKey: 'anonymization_method',
      header: t('entityType.desensitizationMethodColumn'),
      cell: ({ row }) => {
        const method = row.getValue('anonymization_method') as string
        const recognitionMethod = row.original.recognition_method || 'regex'
        const restoreEnabled = row.original.restore_enabled

        // Restore mode: display "Numbered Placeholder"
        if (restoreEnabled) {
          return <Badge variant="secondary">{t('entityType.numberedPlaceholder')}</Badge>
        }

        // GenAI type display "AI masking"
        if (recognitionMethod === 'genai' || method === 'genai') {
          return <Badge variant="default">{t('entityType.aiDesensitization')}</Badge>
        }

        const m = ANONYMIZATION_METHODS.find((a) => a.value === method)
        return <span className="whitespace-nowrap">{m?.label}</span>
      },
    },
    {
      id: 'check_scope',
      header: t('entityType.detectionScopeColumn'),
      cell: ({ row }) => (
        <div className="flex gap-1 whitespace-nowrap">
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
      cell: ({ row }) => {
        const sourceType =
          row.original.source_type || (row.original.is_global ? 'system_template' : 'custom')

        if (sourceType === 'system_template') {
          return (
            <Badge variant="default" className="gap-1 whitespace-nowrap">
              <Globe className="h-3 w-3" />
              {t('entityType.systemTemplate')}
            </Badge>
          )
        } else if (sourceType === 'system_copy') {
          return (
            <Badge variant="secondary" className="gap-1 whitespace-nowrap">
              <Globe className="h-3 w-3" />
              {t('entityType.systemCopy')}
            </Badge>
          )
        } else {
          return (
            <Badge variant="outline" className="gap-1 whitespace-nowrap">
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
      cell: ({ row }) => {
        const record = row.original
        const sourceType = record.source_type || (record.is_global ? 'system_template' : 'custom')
        const canEdit = sourceType === 'system_template' ? user?.is_super_admin : true
        const canDelete =
          sourceType === 'system_template' ? user?.is_super_admin : sourceType === 'custom'

        return (
          <div className="flex gap-1">
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

          <DataTable columns={columns} data={filteredEntityTypes} loading={loading} stickyLastColumn />
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
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
              {editingEntity && editingEntity.source_type === 'system_copy' && (
                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <Info className="h-4 w-4 text-blue-600 mt-0.5" />
                  <p className="text-sm text-blue-900">{t('entityType.systemCopyEditHint')}</p>
                </div>
              )}

              {/* ========== Section 1: Basic Information ========== */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 pb-2 border-b">
                  <FileText className="h-4 w-4 text-blue-600" />
                  <h3 className="font-medium text-sm">{t('entityType.sectionBasicInfo')}</h3>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="entity_type_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('entityType.entityTypeNameLabel')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder={t('entityType.entityTypeNamePlaceholder')}
                            onBlur={(e) => {
                              field.onBlur()
                              if (!editingEntity && e.target.value) {
                                handleGenerateEntityTypeCode(e.target.value)
                              }
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="entity_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('entityType.entityTypeCode')}</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              {...field}
                              placeholder={editingEntity ? t('entityType.entityTypeCodePlaceholder') : t('entityType.entityTypeCodeAutoGenerate')}
                              disabled={!!editingEntity || generatingEntityTypeCode}
                              readOnly={!editingEntity}
                              className={!editingEntity ? 'bg-gray-50' : ''}
                            />
                            {generatingEntityTypeCode && (
                              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                              </div>
                            )}
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="risk_level"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('entityType.riskLevelLabel')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="w-[200px]">
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
              </div>

              {/* ========== Section 2: Recognition Configuration ========== */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 pb-2 border-b">
                  <Search className="h-4 w-4 text-green-600" />
                  <h3 className="font-medium text-sm">{t('entityType.sectionRecognition')}</h3>
                </div>

                <FormField
                  control={form.control}
                  name="recognition_method"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('entityType.recognitionMethodLabel')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="w-[200px]">
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
                  <div className="space-y-4 p-4 border rounded-lg bg-blue-50/30">
                    <FormField
                      control={form.control}
                      name="recognition_natural_desc"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.recognitionNaturalDesc')}</FormLabel>
                          <div className="flex gap-2">
                            <FormControl>
                              <Input {...field} placeholder={t('entityType.recognitionNaturalDescPlaceholder')} />
                            </FormControl>
                            <Button type="button" variant="outline" onClick={handleGenerateRecognitionRegex} disabled={generatingRecognitionRegex}>
                              {generatingRecognitionRegex ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                              <span className="ml-1">{t('entityType.generateRegex')}</span>
                            </Button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="pattern"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.recognitionRuleLabel')}</FormLabel>
                          <FormControl>
                            <Textarea {...field} rows={2} placeholder={t('entityType.recognitionRulePlaceholder')} className="font-mono" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="recognition_test_input"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.recognitionTestInput')}</FormLabel>
                          <div className="flex gap-2">
                            <FormControl>
                              <Input {...field} placeholder={t('entityType.recognitionTestInputPlaceholder')} />
                            </FormControl>
                            <Button type="button" variant="outline" onClick={handleTestRecognitionRegex} disabled={testingRecognitionRegex}>
                              {testingRecognitionRegex ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              <span className="ml-1">{t('entityType.test')}</span>
                            </Button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {recognitionTestResult && (
                      <div className={`p-3 border rounded-lg ${recognitionTestResult.error ? 'bg-red-50 border-red-200' : recognitionTestResult.matched ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
                        {recognitionTestResult.error ? (
                          <p className="text-sm text-red-700">{recognitionTestResult.error}</p>
                        ) : recognitionTestResult.matched ? (
                          <div>
                            <p className="text-sm font-medium text-green-700 mb-1">{t('entityType.recognitionTestMatched', { count: recognitionTestResult.matches.length })}</p>
                            <div className="flex flex-wrap gap-1">
                              {recognitionTestResult.matches.map((match, idx) => (
                                <code key={idx} className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{match}</code>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-yellow-700">{t('entityType.recognitionTestNotMatched')}</p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4 p-4 border rounded-lg bg-green-50/30">
                    <FormField
                      control={form.control}
                      name="entity_definition"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.entityDefinitionLabel')}</FormLabel>
                          <FormControl>
                            <Textarea {...field} rows={3} placeholder={t('entityType.entityDefinitionPlaceholder')} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="entity_definition_test_input"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.entityDefinitionTestInput')}</FormLabel>
                          <div className="flex gap-2">
                            <FormControl>
                              <Input {...field} placeholder={t('entityType.entityDefinitionTestInputPlaceholder')} />
                            </FormControl>
                            <Button type="button" variant="outline" onClick={handleTestEntityDefinition} disabled={testingEntityDefinition}>
                              {testingEntityDefinition ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              <span className="ml-1">{t('entityType.test')}</span>
                            </Button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {entityDefinitionTestResult && (
                      <div className={`p-3 border rounded-lg ${entityDefinitionTestResult.error ? 'bg-red-50 border-red-200' : entityDefinitionTestResult.matched ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
                        {entityDefinitionTestResult.error ? (
                          <p className="text-sm text-red-700">{entityDefinitionTestResult.error}</p>
                        ) : entityDefinitionTestResult.matched ? (
                          <div>
                            <p className="text-sm font-medium text-green-700 mb-1">{t('entityType.entityDefinitionTestMatched', { count: entityDefinitionTestResult.matches.length })}</p>
                            <div className="flex flex-wrap gap-1">
                              {entityDefinitionTestResult.matches.map((match, idx) => (
                                <code key={idx} className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{match}</code>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-yellow-700">{t('entityType.entityDefinitionTestNotMatched')}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ========== Section 3: Anonymization Configuration ========== */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 pb-2 border-b">
                  <Shield className="h-4 w-4 text-purple-600" />
                  <h3 className="font-medium text-sm">{t('entityType.sectionAnonymization')}</h3>
                </div>

                {/* Anonymization Mode Selection (Select Dropdown) */}
                <FormField
                  control={form.control}
                  name="anonymization_mode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('entityType.anonymizationModeLabel')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="w-[280px]">
                            <SelectValue placeholder={t('entityType.anonymizationModePlaceholder')} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="only_anonymize">
                            {t('entityType.onlyAnonymize')}
                          </SelectItem>
                          <SelectItem value="anonymize_restore">
                            {t('entityType.anonymizeRestore')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {field.value && (
                        <p className="text-xs text-gray-500 mt-1">
                          {field.value === 'only_anonymize'
                            ? t('entityType.onlyAnonymizeDesc')
                            : t('entityType.anonymizeRestoreDesc')}
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Only Anonymize Mode Configuration */}
                {form.watch('anonymization_mode') === 'only_anonymize' && (
                  <div className="space-y-4 p-4 border rounded-lg bg-purple-50/30">
                    <FormField
                      control={form.control}
                      name="anonymization_method"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.anonymizationMethodSelectLabel')}</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="w-[200px]">
                                <SelectValue placeholder={t('entityType.anonymizationMethodSelectPlaceholder')} />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {ANONYMIZATION_METHODS.map((method) => (
                                <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* replace configuration */}
                    {form.watch('anonymization_method') === 'replace' && (
                      <FormField
                        control={form.control}
                        name="replace_text"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('entityType.replaceText')}</FormLabel>
                            <FormControl>
                              <Input {...field} placeholder={t('entityType.replaceTextPlaceholder')} />
                            </FormControl>
                            <p className="text-xs text-gray-500 mt-1">{t('entityType.replaceTextHint')}</p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}

                    {/* mask configuration */}
                    {form.watch('anonymization_method') === 'mask' && (
                      <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-4">
                          <FormField control={form.control} name="mask_keep_prefix" render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.maskKeepPrefix')}</FormLabel>
                              <FormControl><Input {...field} type="number" min="0" placeholder="0" /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="mask_keep_suffix" render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.maskKeepSuffix')}</FormLabel>
                              <FormControl><Input {...field} type="number" min="0" placeholder="0" /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="mask_char" render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.maskChar')}</FormLabel>
                              <FormControl><Input {...field} maxLength={1} placeholder="*" /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                        <p className="text-xs text-gray-500">
                          {t('entityType.maskExampleTitle')} 138****3234
                        </p>
                      </div>
                    )}

                    {/* regex_replace configuration */}
                    {form.watch('anonymization_method') === 'regex_replace' && (
                      <div className="space-y-4">
                        <FormField control={form.control} name="regex_natural_desc" render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('entityType.regexNaturalDesc')}</FormLabel>
                            <div className="flex gap-2">
                              <FormControl>
                                <Input {...field} placeholder={t('entityType.regexNaturalDescPlaceholder')} />
                              </FormControl>
                              <Button type="button" variant="outline" onClick={handleGenerateRegex} disabled={generatingRegex}>
                                {generatingRegex ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                                <span className="ml-1">{t('entityType.generateRegex')}</span>
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <div className="grid grid-cols-2 gap-4">
                          <FormField control={form.control} name="regex_pattern" render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.regexPattern')}</FormLabel>
                              <FormControl><Input {...field} placeholder="(\d{3})\d{4}(\d{4})" className="font-mono" /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="regex_replacement" render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('entityType.regexReplacement')}</FormLabel>
                              <FormControl><Input {...field} placeholder="\1****\2" className="font-mono" /></FormControl>
                              <p className="text-xs text-gray-500 mt-1">{t('entityType.regexReplacementHint')}</p>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                      </div>
                    )}

                    {/* genai anonymization configuration */}
                    {form.watch('anonymization_method') === 'genai' && (
                      <div className="space-y-4">
                        <FormField control={form.control} name="genai_anonymization_prompt" render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('entityType.genaiAnonymizationPrompt')}</FormLabel>
                            <FormControl>
                              <Textarea {...field} rows={3} placeholder={t('entityType.genaiAnonymizationPromptPlaceholder')} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <Card className="bg-green-50 border-green-200">
                          <CardContent className="p-3">
                            <p className="text-xs font-semibold text-green-900 mb-2">{t('entityType.genaiAnonymizationExamplesTitle')}</p>
                            <ul className="text-xs text-green-800 space-y-1 list-none">
                              <li>• {t('entityType.genaiAnonymizationExample1')}</li>
                              <li>• {t('entityType.genaiAnonymizationExample2')}</li>
                              <li>• {t('entityType.genaiAnonymizationExample3')}</li>
                            </ul>
                          </CardContent>
                        </Card>
                      </div>
                    )}

                    {/* hash/encrypt/shuffle/random - no config needed */}
                    {['hash', 'encrypt', 'shuffle', 'random'].includes(form.watch('anonymization_method') || '') && (
                      <p className="text-xs text-gray-500">
                        {t('entityType.anonymizationMethodNoConfig')}
                      </p>
                    )}

                    {/* Test anonymization */}
                    <div className="pt-4 border-t">
                      <FormField
                        control={form.control}
                        name="test_input"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('entityType.testAnonymization')}</FormLabel>
                            <div className="flex gap-2">
                              <FormControl>
                                <Input {...field} placeholder={t('entityType.testInputPlaceholder')} />
                              </FormControl>
                              <Button type="button" variant="outline" onClick={handleTestAnonymization} disabled={testingAnonymization}>
                                {testingAnonymization ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                                <span className="ml-1">{t('entityType.test')}</span>
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {testResult && (
                        <div className="mt-2 p-3 bg-white border rounded-lg">
                          <p className="text-sm font-medium text-gray-700">{t('entityType.testResult')}:</p>
                          <code className="text-sm text-green-700 bg-green-50 px-2 py-1 rounded mt-1 block">{testResult}</code>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Anonymize + Restore Mode Configuration */}
                {form.watch('anonymization_mode') === 'anonymize_restore' && (
                  <div className="space-y-4 p-4 border rounded-lg bg-amber-50/30">
                    {/* Anonymization Method - Fixed to Numbered Placeholder (same visual style as only_anonymize mode) */}
                    <FormItem>
                      <FormLabel>{t('entityType.anonymizationMethodSelectLabel')}</FormLabel>
                      <div className="flex items-center gap-2">
                        <div className="w-[200px] h-9 px-3 py-2 border rounded-md bg-gray-100 text-sm text-gray-700 flex items-center">
                          {t('entityType.numberedPlaceholder')}
                        </div>
                        <span className="text-xs text-gray-500">{t('entityType.numberedPlaceholderDesc')}</span>
                      </div>
                    </FormItem>

                    <FormField
                      control={form.control}
                      name="restore_natural_desc"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.restoreNaturalDesc')}</FormLabel>
                          <FormControl>
                            <Textarea {...field} rows={2} placeholder={t('entityType.restoreNaturalDescPlaceholder')} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleGenerateRestoreCode}
                      disabled={generatingRestoreCode || !editingEntity}
                      className="w-full"
                    >
                      {generatingRestoreCode ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Wand2 className="h-4 w-4 mr-2" />}
                      {t('entityType.generateRestoreCode')}
                    </Button>

                    {!editingEntity && (
                      <p className="text-xs text-amber-600 bg-amber-100 p-2 rounded">{t('entityType.saveFirstForRestoreCodeHint')}</p>
                    )}

                    <FormField
                      control={form.control}
                      name="restore_test_input"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('entityType.restoreTestInput')}</FormLabel>
                          <div className="flex gap-2">
                            <FormControl>
                              <Input {...field} placeholder={t('entityType.restoreTestInputPlaceholder')} />
                            </FormControl>
                            <Button type="button" variant="outline" onClick={handleTestRestoreAnonymization} disabled={testingRestoreAnonymization || !editingEntity}>
                              {testingRestoreAnonymization ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              <span className="ml-1">{t('entityType.test')}</span>
                            </Button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {restoreTestResult && (
                      <div className={`p-3 border rounded-lg ${restoreTestResult.error ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                        {restoreTestResult.error ? (
                          <p className="text-sm text-red-700">{restoreTestResult.error}</p>
                        ) : (
                          <div className="space-y-3">
                            <div>
                              <p className="text-sm font-medium text-green-700 mb-1">{t('entityType.restoreAnonymizedResult')}</p>
                              <code className="text-sm bg-white/50 text-green-800 px-2 py-1 rounded block">{restoreTestResult.anonymized_text}</code>
                            </div>
                            {Object.keys(restoreTestResult.mapping).length > 0 && (
                              <div>
                                <p className="text-sm font-medium text-green-700 mb-1">{t('entityType.restoreMappingResult')}</p>
                                <div className="bg-white/50 rounded p-2 space-y-1">
                                  {Object.entries(restoreTestResult.mapping).map(([placeholder, original]) => (
                                    <div key={placeholder} className="flex items-center text-xs">
                                      <code className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">{placeholder}</code>
                                      <span className="mx-2 text-gray-400">→</span>
                                      <code className="bg-green-100 text-green-800 px-1.5 py-0.5 rounded">{original}</code>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Collapsible code preview */}
                    {editingEntity?.restore_code && (
                      <div className="border rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setShowRestoreCode(!showRestoreCode)}
                          className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                            <Code className="h-4 w-4" />
                            {t('entityType.viewGeneratedCode')}
                          </div>
                          {showRestoreCode ? (
                            <ChevronDown className="h-4 w-4 text-gray-500" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-500" />
                          )}
                        </button>
                        {showRestoreCode && (
                          <div className="p-3 bg-gray-900 overflow-x-auto">
                            <pre className="text-xs text-gray-100 font-mono whitespace-pre-wrap">
                              {editingEntity.restore_code}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}

                    <Card className="bg-amber-50 border-amber-200">
                      <CardContent className="p-3">
                        <p className="text-xs font-semibold text-amber-900 mb-2">{t('entityType.restoreExamplesTitle')}</p>
                        <ul className="text-xs text-amber-800 space-y-1 list-none">
                          <li>• {t('entityType.restoreExampleEmail')}</li>
                          <li>• {t('entityType.restoreExamplePhone')}</li>
                          <li>• {t('entityType.restoreExampleName')}</li>
                        </ul>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>

              {/* ========== Section 4: Other Settings ========== */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 pb-2 border-b">
                  <Settings className="h-4 w-4 text-gray-600" />
                  <h3 className="font-medium text-sm">{t('entityType.sectionOtherSettings')}</h3>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 border rounded-lg">
                    <FormLabel className="mb-2 block">{t('entityType.detectionScopeLabel')}</FormLabel>
                    <div className="flex gap-4">
                      <FormField control={form.control} name="check_input" render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                          <FormLabel className="!mt-0 font-normal">{t('entityType.inputSwitch')}</FormLabel>
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="check_output" render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                          <FormLabel className="!mt-0 font-normal">{t('entityType.outputSwitch')}</FormLabel>
                        </FormItem>
                      )} />
                    </div>
                  </div>

                  <FormField control={form.control} name="is_active" render={({ field }) => (
                    <FormItem className="flex items-center justify-between border rounded-lg p-3">
                      <FormLabel>{t('entityType.enableStatusLabel')}</FormLabel>
                      <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                </div>

                {user?.is_super_admin && (
                  <FormField control={form.control} name="is_global" render={({ field }) => (
                    <FormItem className="flex items-center justify-between border rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <FormLabel>{t('entityType.systemConfigLabel')}</FormLabel>
                        <Info className="h-4 w-4 text-gray-400" title={t('entityType.systemConfigTooltip')} />
                      </div>
                      <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                )}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setModalVisible(false)}>{t('common.cancel')}</Button>
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
