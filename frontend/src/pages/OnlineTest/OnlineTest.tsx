import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api, { testModelsApi } from '../../services/api'
import { PlayCircle, X, Settings, Upload, Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Switch } from '../../components/ui/switch'
import { Input } from '../../components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { toast } from 'sonner'
import { Separator } from '../../components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import * as XLSX from 'xlsx'

interface TestModel {
  id: string
  config_name: string
  api_base_url: string
  model_name: string
  enabled: boolean
  selected: boolean
  user_model_name?: string
}

interface TestCase {
  id: string
  name: string
  type: 'question' | 'qa_pair'
  content: string
  expectedRisk?: string
  description?: string
  category?: string
}

interface GuardrailResult {
  compliance: {
    risk_level: string
    categories: string[]
  }
  security: {
    risk_level: string
    categories: string[]
  }
  data?: {
    risk_level: string
    categories: string[]
  }
  overall_risk_level: string
  suggest_action: string
  suggest_answer: string
  error?: string
}

interface ModelResponse {
  content: string
  error?: string
}

interface TestResult {
  guardrail: GuardrailResult
  models: Record<string, ModelResponse>
  original_responses: Record<string, ModelResponse>
}

// Batch test interfaces
interface ExcelRow {
  prompt: string
  response: string
}

interface BatchTestResult {
  prompt: string
  response: string
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

const OnlineTest: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const translateRiskLevel = (riskLevel: string) => {
    const riskLevelMap: { [key: string]: string } = {
      high_risk: t('risk.level.high_risk'),
      medium_risk: t('risk.level.medium_risk'),
      low_risk: t('risk.level.low_risk'),
      no_risk: t('risk.level.no_risk'),
    }
    return riskLevelMap[riskLevel] || riskLevel
  }

  const [loading, setLoading] = useState(false)
  const [testInput, setTestInput] = useState('')
  const [inputType, setInputType] = useState<'question' | 'qa_pair'>('question')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [models, setModels] = useState<TestModel[]>([])
  const [selectedCategory, setSelectedCategory] = useState('security')

  // Batch test states
  const [batchStatus, setBatchStatus] = useState<BatchTestStatus>('idle')
  const [batchFile, setBatchFile] = useState<File | null>(null)
  const [batchData, setBatchData] = useState<ExcelRow[]>([])
  const [batchResults, setBatchResults] = useState<BatchTestResult[]>([])
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 })
  const [batchError, setBatchError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadModels = async () => {
    try {
      const modelsData = await testModelsApi.getModels()
      const mappedModels = modelsData.map((model: any) => ({
        ...model,
        user_model_name: model.model_name || '',
      }))
      setModels(mappedModels)
    } catch (error) {
      console.error('Failed to load models:', error)
      toast.error(t('onlineTest.loadModelsFailed'))
    }
  }

  const updateModelSelection = async (modelId: string, selected: boolean) => {
    try {
      const newModels = models.map((model) => (model.id === modelId ? { ...model, selected } : model))
      setModels(newModels)

      const selections = newModels.map((model) => ({
        id: model.id,
        selected: model.selected,
        model_name: model.user_model_name || null,
      }))

      await testModelsApi.updateSelection(selections)
      toast.success(t('onlineTest.modelSelectionUpdated'))
    } catch (error) {
      console.error('Failed to update model selection:', error)
      toast.error(t('onlineTest.loadModelsFailed'))
      loadModels()
    }
  }

  const updateModelName = async (modelId: string, modelName: string) => {
    try {
      const newModels = models.map((model) => (model.id === modelId ? { ...model, user_model_name: modelName } : model))
      setModels(newModels)

      const selections = newModels.map((model) => ({
        id: model.id,
        selected: model.selected,
        model_name: model.user_model_name || null,
      }))

      await testModelsApi.updateSelection(selections)
    } catch (error) {
      console.error('Failed to update model name:', error)
      toast.error(t('onlineTest.updateModelNameFailed'))
      loadModels()
    }
  }

  useEffect(() => {
    loadModels()
  }, [])

  const testCasesByCategory = {
    security: [
      {
        id: 's9-1',
        name: t('onlineTest.promptAttackExample'),
        type: 'question' as const,
        content: t('onlineTest.testCases.promptAttackContent'),
        expectedRisk: t('risk.level.high_risk'),
        description: t('onlineTest.promptAttackExampleDesc'),
        category: 'S9',
      },
      {
        id: 's5-1',
        name: t('onlineTest.violentCrimeContent'),
        type: 'question' as const,
        content: t('onlineTest.testCases.violentCrimeContent'),
        expectedRisk: t('risk.level.high_risk'),
        description: t('onlineTest.violentCrimeContentDesc'),
        category: 'S5',
      },
      {
        id: 's7-1',
        name: t('onlineTest.pornographicContent'),
        type: 'question' as const,
        content: t('onlineTest.testCases.pornographicContent'),
        expectedRisk: t('risk.level.medium_risk'),
        description: t('onlineTest.pornographicContentDesc'),
        category: 'S7',
      },
      {
        id: 's8-1',
        name: t('onlineTest.discriminatoryContent'),
        type: 'question' as const,
        content: t('onlineTest.testCases.discriminatoryContent'),
        expectedRisk: t('risk.level.low_risk'),
        description: t('onlineTest.discriminatoryContentDesc'),
        category: 'S8',
      },
    ],
    dataLeak: [
      {
        id: 'd-1',
        name: t('onlineTest.dataLeakIdentity'),
        type: 'qa_pair' as const,
        content: t('onlineTest.testCases.dataLeakIdentityContent'),
        expectedRisk: t('risk.level.high_risk'),
        description: t('onlineTest.dataLeakIdentityDesc'),
        category: 'Data',
      },
      {
        id: 'd-2',
        name: t('onlineTest.dataLeakBanking'),
        type: 'qa_pair' as const,
        content: t('onlineTest.testCases.dataLeakBankingContent'),
        expectedRisk: t('risk.level.high_risk'),
        description: t('onlineTest.dataLeakBankingDesc'),
        category: 'Data',
      },
      {
        id: 'd-3',
        name: t('onlineTest.dataLeakEmail'),
        type: 'qa_pair' as const,
        content: t('onlineTest.testCases.dataLeakEmailContent'),
        expectedRisk: t('risk.level.low_risk'),
        description: t('onlineTest.dataLeakEmailDesc'),
        category: 'Data',
      },
    ],
    professional: [
      {
        id: 's19-1',
        name: t('onlineTest.financialAdvice'),
        type: 'question' as const,
        content: t('onlineTest.testCases.financialAdviceContent'),
        expectedRisk: t('risk.level.low_risk'),
        description: t('onlineTest.financialAdviceDesc'),
        category: 'S19',
      },
      {
        id: 's20-1',
        name: t('onlineTest.medicalAdvice'),
        type: 'question' as const,
        content: t('onlineTest.testCases.medicalAdviceContent'),
        expectedRisk: t('risk.level.low_risk'),
        description: t('onlineTest.medicalAdviceDesc'),
        category: 'S20',
      },
      {
        id: 's21-1',
        name: t('onlineTest.legalAdvice'),
        type: 'question' as const,
        content: t('onlineTest.testCases.legalAdviceContent'),
        expectedRisk: t('risk.level.low_risk'),
        description: t('onlineTest.legalAdviceDesc'),
        category: 'S21',
      },
    ],
    safe: [
      {
        id: 'safe-1',
        name: t('onlineTest.safeQaPair'),
        type: 'qa_pair' as const,
        content: t('onlineTest.testCases.safeQaPairContent'),
        expectedRisk: t('risk.level.no_risk'),
        description: t('onlineTest.safeQaPairDesc'),
        category: 'Safe',
      },
    ],
  }

  const testCases: TestCase[] = [...testCasesByCategory.security, ...testCasesByCategory.dataLeak, ...testCasesByCategory.professional, ...testCasesByCategory.safe]

  const runTest = async () => {
    if (!testInput.trim()) {
      toast.warning(t('onlineTest.pleaseEnterTestContent'))
      return
    }

    setLoading(true)
    try {
      if (inputType === 'qa_pair') {
        const lines = testInput.split('\n')
        const question = lines.find((line) => line.startsWith('Q:'))?.substring(2).trim()
        const answer = lines.find((line) => line.startsWith('A:'))?.substring(2).trim()

        if (!question || !answer) {
          toast.error(t('onlineTest.qaPairFormatError'))
          return
        }
      }

      const selectedModels = models.filter((m) => m.selected)
      if (inputType === 'question' && selectedModels.length === 0) {
        toast.info(t('onlineTest.proxyModelHint'))
      }

      const requestData = {
        content: testInput,
        input_type: inputType,
      }

      const response = await api.post('/api/v1/test/online', requestData)

      setTestResult({
        guardrail: response.data.guardrail,
        models: response.data.models || {},
        original_responses: response.data.original_responses || {},
      })
    } catch (error: any) {
      console.error('Test failed:', error)
      const errorMessage = error?.response?.data?.detail || error?.message || t('onlineTest.testExecutionFailed')
      const status = error?.response?.status

      if (status === 408 || status === 429 || status === 401 || status === 500) {
        let displayMessage = errorMessage

        if (status === 401) {
          displayMessage = t('onlineTest.apiAuthFailed')
        } else if (status === 408) {
          displayMessage = errorMessage
        } else if (status === 429) {
          displayMessage = errorMessage
        } else if (status === 500) {
          displayMessage = t('onlineTest.serverError')
        }

        setTestResult({
          guardrail: {
            compliance: { risk_level: t('onlineTest.testFailed'), categories: [] },
            security: { risk_level: t('onlineTest.testFailed'), categories: [] },
            overall_risk_level: t('onlineTest.testFailed'),
            suggest_action: t('onlineTest.testFailed'),
            suggest_answer: '',
            error: displayMessage,
          },
          models: {},
          original_responses: {},
        })
      } else {
        if (error.code === 'ECONNABORTED' || errorMessage.includes('timeout')) {
          toast.error(t('onlineTest.requestTimeout'))
        } else {
          toast.error(`${t('onlineTest.testExecutionFailed')}: ${errorMessage}`)
        }
      }
    } finally {
      setLoading(false)
    }
  }

  const clearInput = () => {
    setTestInput('')
    setTestResult(null)
  }

  const useTestCase = (testCase: TestCase) => {
    setTestInput(testCase.content)
    setInputType(testCase.type)
    toast.success(t('onlineTest.testCaseLoaded', { name: testCase.name }))
  }

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'high_risk':
        return 'bg-red-100 text-red-800 border-red-200'
      case 'medium_risk':
        return 'bg-orange-100 text-orange-800 border-orange-200'
      case 'low_risk':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200'
      case 'no_risk':
      case 'safe':
        return 'bg-green-100 text-green-800 border-green-200'
      case 'test_failed':
      case 'detection_failed':
      case 'error':
        return 'bg-red-100 text-red-800 border-red-200'
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200'
    }
  }

  const getActionColor = (action: string) => {
    switch (action) {
      case 'reject':
        return 'bg-red-100 text-red-800 border-red-200'
      case 'replace':
        return 'bg-orange-100 text-orange-800 border-orange-200'
      case 'pass':
        return 'bg-green-100 text-green-800 border-green-200'
      case 'test_failed':
      case 'error':
      case 'system_error':
        return 'bg-red-100 text-red-800 border-red-200'
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200'
    }
  }

  // Batch test functions
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setBatchFile(file)
    setBatchStatus('idle')
    setBatchError(null)
    setBatchResults([])

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = e.target?.result
        const workbook = XLSX.read(data, { type: 'binary' })
        const sheetName = workbook.SheetNames[0]
        const sheet = workbook.Sheets[sheetName]
        // Use defval to preserve empty cells, otherwise columns with empty values in first row are skipped
        const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' })

        if (jsonData.length === 0) {
          toast.error(t('onlineTest.batchTest.emptyFile'))
          setBatchFile(null)
          return
        }

        // Check for required columns (case-insensitive)
        const firstRow = jsonData[0]
        const keys = Object.keys(firstRow)
        const promptKey = keys.find(k => k.toLowerCase() === 'prompt')
        const responseKey = keys.find(k => k.toLowerCase() === 'response')

        if (!promptKey || !responseKey) {
          toast.error(t('onlineTest.batchTest.missingColumns'))
          setBatchFile(null)
          return
        }

        // Map data - filter out rows with empty prompt
        const mappedData: ExcelRow[] = jsonData.map((row: any) => ({
          prompt: String(row[promptKey] || '').trim(),
          response: String(row[responseKey] || '').trim(),
        })).filter(row => row.prompt !== '')

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
    setBatchError(null)

    const results: BatchTestResult[] = []

    for (let i = 0; i < batchData.length; i++) {
      const row = batchData[i]
      try {
        // Determine input type: if response is not empty, use qa_pair format
        let content = row.prompt
        let inputTypeForRequest: 'question' | 'qa_pair' = 'question'

        if (row.response) {
          content = `Q: ${row.prompt}\nA: ${row.response}`
          inputTypeForRequest = 'qa_pair'
        }

        const response = await api.post('/api/v1/test/online', {
          content: content,
          input_type: inputTypeForRequest,
        })

        const guardrail = response.data.guardrail
        results.push({
          prompt: row.prompt,
          response: row.response,
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
          prompt: row.prompt,
          response: row.response,
          compliance_risk_level: 'error',
          compliance_categories: '',
          security_risk_level: 'error',
          security_categories: '',
          data_risk_level: 'error',
          data_categories: '',
          overall_risk_level: 'error',
          suggest_action: 'error',
          suggest_answer: error?.message || 'Detection failed',
        })
      }

      setBatchProgress({ current: i + 1, total: batchData.length })
    }

    setBatchResults(results)
    setBatchStatus('completed')
    toast.success(t('onlineTest.batchTest.status.completed'))
  }

  const downloadResults = () => {
    if (batchResults.length === 0) return

    // Prepare data for Excel - results already have the correct structure
    const excelData = batchResults.map(result => ({
      prompt: result.prompt,
      response: result.response,
      compliance_risk_level: result.compliance_risk_level,
      compliance_categories: result.compliance_categories,
      security_risk_level: result.security_risk_level,
      security_categories: result.security_categories,
      data_risk_level: result.data_risk_level,
      data_categories: result.data_categories,
      overall_risk_level: result.overall_risk_level,
      suggest_action: result.suggest_action,
      suggest_answer: result.suggest_answer,
    }))

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(excelData)

    // Set column widths
    ws['!cols'] = [
      { wch: 50 }, // prompt
      { wch: 50 }, // response
      { wch: 18 }, // compliance_risk_level
      { wch: 25 }, // compliance_categories
      { wch: 18 }, // security_risk_level
      { wch: 25 }, // security_categories
      { wch: 15 }, // data_risk_level
      { wch: 25 }, // data_categories
      { wch: 18 }, // overall_risk_level
      { wch: 15 }, // suggest_action
      { wch: 50 }, // suggest_answer
    ]

    XLSX.utils.book_append_sheet(wb, ws, 'Detection Results')

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `detection_results_${timestamp}.xlsx`

    // Download
    XLSX.writeFile(wb, filename)
  }

  const resetBatchTest = () => {
    setBatchStatus('idle')
    setBatchFile(null)
    setBatchData([])
    setBatchResults([])
    setBatchProgress({ current: 0, total: 0 })
    setBatchError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const getStatusColor = (status: BatchTestStatus) => {
    switch (status) {
      case 'idle':
        return 'bg-gray-100 text-gray-800'
      case 'uploaded':
        return 'bg-blue-100 text-blue-800'
      case 'detecting':
        return 'bg-yellow-100 text-yellow-800'
      case 'completed':
        return 'bg-green-100 text-green-800'
      case 'error':
        return 'bg-red-100 text-red-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">{t('onlineTest.title')}</h1>
      <p className="text-slate-600 mb-6">{t('onlineTest.description')}</p>

      <Tabs defaultValue="single" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="single">{t('onlineTest.batchTest.tabSingle')}</TabsTrigger>
          <TabsTrigger value="batch">{t('onlineTest.batchTest.tabBatch')}</TabsTrigger>
        </TabsList>

        <TabsContent value="single">
      <div className="space-y-6">
        {/* Test input area */}
        <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{t('onlineTest.testInput')}</CardTitle>
                <div className="flex items-center gap-2">
                  <Select value={inputType} onValueChange={(value: 'question' | 'qa_pair') => setInputType(value)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="question">{t('onlineTest.singleQuestion')}</SelectItem>
                      <SelectItem value="qa_pair">{t('onlineTest.qaPair')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={() => navigate('/security-gateway')}>
                    <Settings className="h-4 w-4 mr-2" />
                    {t('onlineTest.manageProxyModels')}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder={inputType === 'question' ? t('onlineTest.questionPlaceholder') : t('onlineTest.qaPairPlaceholder')}
                rows={6}
                className="font-mono text-sm"
              />

              {/* Preset test cases */}
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between">
                    <span>{t('onlineTest.presetTestCases')}</span>
                    <span className="text-xs text-slate-500">{t('onlineTest.clickToExpand')}</span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 space-y-3">
                  <Select defaultValue="security" onValueChange={(value) => setSelectedCategory(value)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="security">{t('onlineTest.categories.security')}</SelectItem>
                      <SelectItem value="dataLeak">{t('onlineTest.categories.dataLeak')}</SelectItem>
                      <SelectItem value="professional">{t('onlineTest.categories.professional')}</SelectItem>
                      <SelectItem value="safe">{t('onlineTest.categories.safe')}</SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {testCasesByCategory[selectedCategory as keyof typeof testCasesByCategory].map((testCase) => (
                      <Card key={testCase.id} className="cursor-pointer hover:bg-slate-50 transition-colors" onClick={() => useTestCase(testCase)}>
                        <CardContent className="p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold">{testCase.name}</p>
                            <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-800 border border-blue-200">{testCase.category}</span>
                          </div>
                          <p className="text-xs text-slate-600">{testCase.description}</p>
                          <span className={`inline-block px-2 py-0.5 text-xs rounded border ${getRiskColor(testCase.expectedRisk || '')}`}>
                            {t('onlineTest.expected')} {testCase.expectedRisk}
                          </span>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Proxy model selection */}
              {inputType === 'question' && (
                <div>
                  <h4 className="text-sm font-medium mb-3">{t('onlineTest.selectTestModels')}</h4>
                  {models.length === 0 ? (
                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-md">
                      <div className="flex items-start gap-2">
                        <div className="flex-shrink-0 mt-0.5">
                          <div className="h-5 w-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs">i</div>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-blue-900">{t('onlineTest.noProxyModels')}</p>
                          <p className="text-sm text-blue-700 mt-1">
                            {t('onlineTest.noProxyModelsDesc').split(t('onlineTest.securityGateway'))[0]}
                            <Button variant="link" size="sm" className="h-auto p-0 text-blue-600" onClick={() => navigate('/security-gateway')}>
                              {t('onlineTest.securityGateway')}
                            </Button>
                            {t('onlineTest.noProxyModelsDesc').split(t('onlineTest.securityGateway'))[1]}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {models.map((model) => (
                        <Collapsible key={model.id} defaultOpen={model.selected}>
                          <Card className="bg-slate-50">
                            <CollapsibleTrigger className="w-full">
                              <CardHeader className="py-3">
                                <div className="flex items-center justify-between w-full">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm">{model.config_name}</span>
                                    {model.selected && <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-800 border border-blue-200">{t('onlineTest.selected')}</span>}
                                  </div>
                                  <Switch
                                    checked={model.selected}
                                    onCheckedChange={(checked) => {
                                      updateModelSelection(model.id, checked)
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                </div>
                              </CardHeader>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <CardContent className="pt-0 pb-3 space-y-3">
                                <div>
                                  <p className="text-xs text-slate-500 mb-1">{t('onlineTest.apiBaseUrl')}</p>
                                  <p className="text-xs text-slate-700">{model.api_base_url}</p>
                                </div>

                                {model.selected && (
                                  <div>
                                    <p className="text-xs text-slate-500 mb-1">{t('onlineTest.modelNameLabel')}</p>
                                    <Input
                                      size={1}
                                      placeholder={t('onlineTest.modelNamePlaceholder')}
                                      value={model.user_model_name}
                                      onChange={(e) => updateModelName(model.id, e.target.value)}
                                      onBlur={(e) => updateModelName(model.id, e.target.value)}
                                      className="h-8 text-xs"
                                    />
                                  </div>
                                )}
                              </CardContent>
                            </CollapsibleContent>
                          </Card>
                        </Collapsible>
                      ))}
                    </div>
                  )}
                  {models.filter((m) => m.selected).length > 0 && (
                    <p className="text-xs text-blue-600 mt-2">{t('onlineTest.selectedModels', { count: models.filter((m) => m.selected).length })}</p>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Button onClick={runTest} disabled={loading} size="lg" className="bg-blue-600 hover:bg-blue-700">
                  {loading ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                      {t('onlineTest.runTest')}
                    </>
                  ) : (
                    <>
                      <PlayCircle className="h-4 w-4 mr-2" />
                      {t('onlineTest.runTest')}
                    </>
                  )}
                </Button>
                <Button variant="outline" onClick={clearInput} size="lg">
                  <X className="h-4 w-4 mr-2" />
                  {t('onlineTest.clear')}
                </Button>
              </div>
            </CardContent>
        </Card>

        {/* Test Result */}
        {testResult && (
          <Card>
            <CardHeader>
              <CardTitle>{t('onlineTest.testResult')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Guardrail detection result */}
                <div>
                  <h4 className="text-base font-semibold mb-4">{t('onlineTest.guardrailResult')}</h4>

                  {testResult.guardrail.error ? (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-md">
                      <div className="flex items-start gap-2">
                        <div className="flex-shrink-0 mt-0.5">
                          <div className="h-5 w-5 rounded-full bg-red-500 flex items-center justify-center text-white text-xs">!</div>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-red-900">{t('onlineTest.detectionFailed')}</p>
                          <div className="text-sm text-red-700 mt-2">
                            <p className="font-semibold">{t('onlineTest.failureReason')}</p>
                            <p>{testResult.guardrail.error}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                        <Card>
                          <CardHeader>
                            <CardTitle className="text-sm">{t('onlineTest.securityRisk')}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <div>
                              <span className="text-xs text-slate-600">{t('onlineTest.riskLevel')} </span>
                              <span className={`inline-block px-2 py-0.5 text-xs rounded border ${getRiskColor(testResult.guardrail.security?.risk_level)}`}>
                                {translateRiskLevel(testResult.guardrail.security?.risk_level || 'no_risk')}
                              </span>
                            </div>
                            {testResult.guardrail.security?.categories?.length > 0 && (
                              <div>
                                <span className="text-xs text-slate-600">{t('onlineTest.riskCategory')} </span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {testResult.guardrail.security.categories.map((cat, idx) => (
                                    <span key={idx} className="px-2 py-0.5 text-xs rounded bg-red-100 text-red-800 border border-red-200">
                                      {cat}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader>
                            <CardTitle className="text-sm">{t('onlineTest.complianceRisk')}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <div>
                              <span className="text-xs text-slate-600">{t('onlineTest.riskLevel')} </span>
                              <span className={`inline-block px-2 py-0.5 text-xs rounded border ${getRiskColor(testResult.guardrail.compliance?.risk_level)}`}>
                                {translateRiskLevel(testResult.guardrail.compliance?.risk_level || 'no_risk')}
                              </span>
                            </div>
                            {testResult.guardrail.compliance?.categories?.length > 0 && (
                              <div>
                                <span className="text-xs text-slate-600">{t('onlineTest.riskCategory')} </span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {testResult.guardrail.compliance.categories.map((cat, idx) => (
                                    <span key={idx} className="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800 border border-orange-200">
                                      {cat}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader>
                            <CardTitle className="text-sm">{t('onlineTest.dataLeak')}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <div>
                              <span className="text-xs text-slate-600">{t('onlineTest.riskLevel')} </span>
                              <span className={`inline-block px-2 py-0.5 text-xs rounded border ${getRiskColor(testResult.guardrail.data?.risk_level || 'no_risk')}`}>
                                {translateRiskLevel(testResult.guardrail.data?.risk_level || 'no_risk')}
                              </span>
                            </div>
                            {testResult.guardrail.data?.categories && testResult.guardrail.data.categories.length > 0 && (
                              <div>
                                <span className="text-xs text-slate-600">{t('onlineTest.riskCategory')} </span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {testResult.guardrail.data.categories.map((cat, idx) => (
                                    <span key={idx} className="px-2 py-0.5 text-xs rounded bg-purple-100 text-purple-800 border border-purple-200">
                                      {cat}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </div>

                      <Separator />

                      <Card className="border-slate-200 bg-slate-50">
                        <CardContent className="pt-4">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                              <p className="text-sm font-medium text-slate-700 mb-1">{t('onlineTest.overallRiskLevel')}</p>
                              <span className={`inline-block px-3 py-1.5 text-sm font-semibold rounded border ${getRiskColor(testResult.guardrail.overall_risk_level)}`}>
                                {translateRiskLevel(testResult.guardrail.overall_risk_level)}
                              </span>
                            </div>
                            <div>
                              <p className="text-sm font-medium text-slate-700 mb-1">{t('onlineTest.suggestedAction')}</p>
                              <span className={`inline-block px-3 py-1.5 text-sm font-semibold rounded border ${getActionColor(testResult.guardrail.suggest_action)}`}>{testResult.guardrail.suggest_action}</span>
                            </div>
                            <div>
                              {testResult.guardrail.suggest_answer && (
                                <>
                                  <p className="text-sm font-medium text-slate-700 mb-1">{t('onlineTest.suggestedAnswer')}</p>
                                  <code className="text-xs bg-white px-3 py-1.5 rounded border border-slate-200 block whitespace-pre-wrap break-all">{testResult.guardrail.suggest_answer}</code>
                                </>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </>
                  )}
                </div>

                {/* Proxy model original responses */}
                {inputType === 'question' && Object.keys(testResult.original_responses).length > 0 && (
                  <div>
                    <h4 className="text-base font-semibold mb-3">{t('onlineTest.proxyModelOriginalResponse')}</h4>
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-md mb-4 text-sm text-blue-800">{t('onlineTest.proxyModelOriginalResponseDesc')}</div>
                    <div className="space-y-3">
                      {Object.entries(testResult.original_responses).map(([modelId, response]) => {
                        const model = models.find((m) => m.id === modelId)
                        return (
                          <Card key={modelId}>
                            <CardHeader>
                              <CardTitle className="text-sm">{model?.config_name || `Model ${modelId}`}</CardTitle>
                            </CardHeader>
                            <CardContent>
                              {response.error ? (
                                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">{response.error}</div>
                              ) : response.content ? (
                                <div>
                                  <p className="text-xs font-semibold text-slate-700 mb-2">{t('onlineTest.originalResponse')}</p>
                                  <div className="bg-slate-50 p-3 rounded-md border border-slate-200">
                                    <p className="text-sm whitespace-pre-wrap">{response.content}</p>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-sm text-slate-500">{t('onlineTest.emptyResponse')}</p>
                              )}
                            </CardContent>
                          </Card>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Model protected responses */}
                {Object.keys(testResult.models).length > 0 && (
                  <div>
                    <h4 className="text-base font-semibold mb-3">{t('onlineTest.proxyModelProtectedResponse')}</h4>
                    <div className="space-y-3">
                      {Object.entries(testResult.models).map(([modelId, response]) => {
                        const model = models.find((m) => m.id === modelId)
                        return (
                          <Card key={modelId}>
                            <CardHeader>
                              <CardTitle className="text-sm">{model?.config_name || `Model ${modelId}`}</CardTitle>
                            </CardHeader>
                            <CardContent>
                              {response.error ? (
                                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">{response.error}</div>
                              ) : response.content ? (
                                <div>
                                  <p className="text-xs font-semibold text-slate-700 mb-2">{t('onlineTest.modelResponse')}</p>
                                  <div className="bg-slate-50 p-3 rounded-md border border-slate-200">
                                    <p className="text-sm whitespace-pre-wrap">{response.content}</p>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-sm text-slate-500">{t('onlineTest.emptyResponse')}</p>
                              )}
                            </CardContent>
                          </Card>
                        )
                      })}
                    </div>
                  </div>
                )}
            </CardContent>
          </Card>
        )}
      </div>
        </TabsContent>

        <TabsContent value="batch">
          <div className="space-y-6">
            {/* Batch test description */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileSpreadsheet className="h-5 w-5" />
                  {t('onlineTest.batchTest.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-600">{t('onlineTest.batchTest.description')}</p>
                <p className="text-xs text-slate-500">{t('onlineTest.batchTest.formatRequirement')}</p>

                {/* File upload area */}
                <div className="space-y-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={handleFileUpload}
                    className="hidden"
                    id="excel-upload"
                  />

                  {batchStatus === 'idle' && !batchFile ? (
                    <label
                      htmlFor="excel-upload"
                      className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors"
                    >
                      <Upload className="h-8 w-8 text-slate-400 mb-2" />
                      <span className="text-sm text-slate-600">{t('onlineTest.batchTest.uploadArea')}</span>
                      <span className="text-xs text-slate-400 mt-1">{t('onlineTest.batchTest.uploadHint')}</span>
                    </label>
                  ) : (
                    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <FileSpreadsheet className="h-8 w-8 text-green-600" />
                          <div>
                            <p className="text-sm font-medium text-slate-700">{batchFile?.name}</p>
                            <p className="text-xs text-slate-500">
                              {batchData.length} {t('onlineTest.batchTest.resultColumns.prompt').toLowerCase()}
                            </p>
                          </div>
                        </div>
                        <span className={`px-3 py-1 text-xs font-medium rounded-full ${getStatusColor(batchStatus)}`}>
                          {t(`onlineTest.batchTest.status.${batchStatus}`)}
                        </span>
                      </div>

                      {/* Progress display */}
                      {batchStatus === 'detecting' && (
                        <div className="mt-4">
                          <div className="flex items-center justify-between text-sm text-slate-600 mb-2">
                            <span>{t('onlineTest.batchTest.progress', { current: batchProgress.current, total: batchProgress.total })}</span>
                            <span>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</span>
                          </div>
                          <div className="w-full bg-slate-200 rounded-full h-2">
                            <div
                              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                              style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    {batchStatus === 'uploaded' && (
                      <Button onClick={runBatchDetection} className="bg-blue-600 hover:bg-blue-700">
                        <PlayCircle className="h-4 w-4 mr-2" />
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
                      <Button onClick={downloadResults} className="bg-green-600 hover:bg-green-700">
                        <Download className="h-4 w-4 mr-2" />
                        {t('onlineTest.batchTest.downloadResult')}
                      </Button>
                    )}

                    {(batchStatus === 'uploaded' || batchStatus === 'completed' || batchStatus === 'error') && (
                      <Button variant="outline" onClick={resetBatchTest}>
                        <X className="h-4 w-4 mr-2" />
                        {t('onlineTest.batchTest.reupload')}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Results preview */}
            {batchResults.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('onlineTest.testResult')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th className="text-left py-2 px-3 font-medium text-slate-700">#</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.prompt')}</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.response')}</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.overallRiskLevel')}</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.securityRiskLevel')}</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.complianceRiskLevel')}</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.dataRiskLevel')}</th>
                          <th className="text-left py-2 px-3 font-medium text-slate-700">{t('onlineTest.batchTest.resultColumns.action')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchResults.slice(0, 50).map((result, index) => (
                          <tr key={index} className="border-b border-slate-100 hover:bg-slate-50">
                            <td className="py-2 px-3 text-slate-500">{index + 1}</td>
                            <td className="py-2 px-3 max-w-[200px] truncate" title={result.prompt}>{result.prompt}</td>
                            <td className="py-2 px-3 max-w-[200px] truncate" title={result.response || '-'}>{result.response || '-'}</td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 text-xs rounded border ${getRiskColor(result.overall_risk_level)}`}>
                                {translateRiskLevel(result.overall_risk_level)}
                              </span>
                            </td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 text-xs rounded border ${getRiskColor(result.security_risk_level)}`}>
                                {translateRiskLevel(result.security_risk_level)}
                              </span>
                            </td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 text-xs rounded border ${getRiskColor(result.compliance_risk_level)}`}>
                                {translateRiskLevel(result.compliance_risk_level)}
                              </span>
                            </td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 text-xs rounded border ${getRiskColor(result.data_risk_level)}`}>
                                {translateRiskLevel(result.data_risk_level)}
                              </span>
                            </td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 text-xs rounded border ${getActionColor(result.suggest_action)}`}>
                                {result.suggest_action}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {batchResults.length > 50 && (
                      <p className="text-sm text-slate-500 mt-2 text-center">
                        ... {t('onlineTest.batchTest.progress', { current: 50, total: batchResults.length })} ...
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default OnlineTest
