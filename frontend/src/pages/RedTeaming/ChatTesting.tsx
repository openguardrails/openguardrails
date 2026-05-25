import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import api from '../../services/api'
import { Send, Trash2, Loader2, Globe, FolderOpen, AlertTriangle, ShieldAlert, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { Card, CardContent } from '../../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { toast } from 'sonner'
import { cn } from '../../lib/utils'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  detection?: GuardrailResult
  isDetecting?: boolean
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

interface WorkspaceOption {
  id: string
  name: string
}

interface PresetTestCase {
  id: string
  label: string
  content: string
  category: 'security' | 'data' | 'compliance'
}

const ChatTesting: React.FC = () => {
  const { t } = useTranslation()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const translateRiskLevel = (riskLevel: string) => {
    const riskLevelMap: { [key: string]: string } = {
      high_risk: t('risk.level.high_risk'),
      medium_risk: t('risk.level.medium_risk'),
      low_risk: t('risk.level.low_risk'),
      no_risk: t('risk.level.no_risk'),
    }
    return riskLevelMap[riskLevel] || riskLevel
  }

  // Chat states
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isDetecting, setIsDetecting] = useState(false)

  // Workspace selector states
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('global')

  // Preset test cases
  const presetTestCases: PresetTestCase[] = [
    {
      id: 'prompt-injection',
      label: t('onlineTest.chat.presets.promptInjection'),
      content: t('onlineTest.testCases.promptAttackContent'),
      category: 'security'
    },
    {
      id: 'violent-crime',
      label: t('onlineTest.chat.presets.violentCrime'),
      content: t('onlineTest.testCases.violentCrimeContent'),
      category: 'security'
    },
    {
      id: 'pornographic',
      label: t('onlineTest.chat.presets.pornographic'),
      content: t('onlineTest.testCases.pornographicContent'),
      category: 'compliance'
    },
    {
      id: 'discrimination',
      label: t('onlineTest.chat.presets.discrimination'),
      content: t('onlineTest.testCases.discriminatoryContent'),
      category: 'compliance'
    },
    {
      id: 'safe',
      label: t('onlineTest.chat.presets.safe'),
      content: t('onlineTest.chat.presets.safeContent'),
      category: 'security'
    }
  ]

  const loadWorkspaces = useCallback(async () => {
    try {
      const response = await api.get('/api/v1/workspaces')
      setWorkspaces(response.data.filter((ws: any) => !ws.is_global).map((ws: any) => ({ id: ws.id, name: ws.name })))
    } catch (error) {
      console.error('Failed to load workspaces:', error)
    }
  }, [])

  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  // Auto scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const generateId = () => Math.random().toString(36).substring(2, 15)

  const sendMessage = async () => {
    const content = inputValue.trim()
    if (!content || isDetecting) return

    // Add user message
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: new Date(),
      isDetecting: true
    }

    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInputValue('')
    setIsDetecting(true)

    try {
      // Build messages array for API (all messages in conversation)
      const apiMessages = newMessages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))

      const requestData: any = {
        messages: apiMessages,
        generate_response: true  // Request model to generate response
      }
      if (selectedWorkspaceId !== 'global') {
        requestData.workspace_id = selectedWorkspaceId
      }

      const response = await api.post('/api/v1/test/online', requestData)
      const guardrailResult = response.data.guardrail
      const modelResponse = response.data.model_response

      // Update user message with detection result
      setMessages(prev => prev.map(msg =>
        msg.id === userMessage.id
          ? { ...msg, detection: guardrailResult, isDetecting: false }
          : msg
      ))

      // Add model response as assistant message
      if (modelResponse) {
        if (modelResponse.content) {
          const assistantMessage: ChatMessage = {
            id: generateId(),
            role: 'assistant',
            content: modelResponse.content,
            timestamp: new Date()
          }
          setMessages(prev => [...prev, assistantMessage])
        } else if (modelResponse.error) {
          // Show error as assistant message
          const assistantMessage: ChatMessage = {
            id: generateId(),
            role: 'assistant',
            content: `${modelResponse.error}`,
            timestamp: new Date()
          }
          setMessages(prev => [...prev, assistantMessage])
        }
      }

    } catch (error: any) {
      console.error('Detection failed:', error)
      const errorMessage = error?.response?.data?.detail || error?.message || t('onlineTest.testExecutionFailed')

      // Update user message with error
      setMessages(prev => prev.map(msg =>
        msg.id === userMessage.id
          ? {
              ...msg,
              detection: {
                compliance: { risk_level: 'error', categories: [] },
                security: { risk_level: 'error', categories: [] },
                overall_risk_level: 'error',
                suggest_action: 'error',
                suggest_answer: '',
                error: errorMessage
              },
              isDetecting: false
            }
          : msg
      ))

      toast.error(errorMessage)
    } finally {
      setIsDetecting(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const clearConversation = () => {
    setMessages([])
    toast.success(t('onlineTest.chat.conversationCleared'))
  }

  const usePresetCase = (preset: PresetTestCase) => {
    setInputValue(preset.content)
    inputRef.current?.focus()
  }

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'high_risk':
        return 'text-red-400'
      case 'medium_risk':
        return 'text-orange-400'
      case 'low_risk':
        return 'text-yellow-400'
      case 'no_risk':
      case 'safe':
        return 'text-emerald-400'
      default:
        return 'text-muted-foreground'
    }
  }

  const getRiskBgColor = (level: string) => {
    switch (level) {
      case 'high_risk':
        return 'bg-red-500/10 border-red-500/20'
      case 'medium_risk':
        return 'bg-orange-500/10 border-orange-500/20'
      case 'low_risk':
        return 'bg-yellow-500/10 border-yellow-500/20'
      case 'no_risk':
      case 'safe':
        return 'bg-emerald-500/10 border-emerald-500/20'
      default:
        return 'bg-muted border-border'
    }
  }

  const getRiskIcon = (level: string) => {
    switch (level) {
      case 'high_risk':
      case 'medium_risk':
        return <ShieldAlert className="h-4 w-4" />
      case 'low_risk':
        return <AlertTriangle className="h-4 w-4" />
      case 'no_risk':
      case 'safe':
        return <ShieldCheck className="h-4 w-4" />
      default:
        return <ShieldCheck className="h-4 w-4" />
    }
  }

  // Detection result badge component
  const DetectionBadge: React.FC<{ detection: GuardrailResult }> = ({ detection }) => {
    const [expanded, setExpanded] = useState(false)
    const riskLevel = detection.overall_risk_level

    if (detection.error) {
      return (
        <div className="mt-2 p-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-300">
          {detection.error}
        </div>
      )
    }

    return (
      <div className={cn("mt-2 rounded-md border text-xs", getRiskBgColor(riskLevel))}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 rounded-md transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className={getRiskColor(riskLevel)}>{getRiskIcon(riskLevel)}</span>
            <span className={cn("font-medium", getRiskColor(riskLevel))}>
              {translateRiskLevel(riskLevel)}
            </span>
            {detection.suggest_action !== 'pass' && (
              <span className="text-muted-foreground">• {detection.suggest_action}</span>
            )}
          </div>
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {expanded && (
          <div className="px-3 pb-3 space-y-2 border-t border-white/5 pt-2">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="text-muted-foreground">{t('onlineTest.securityRisk')}:</span>
                <span className={cn("ml-1", getRiskColor(detection.security?.risk_level))}>
                  {translateRiskLevel(detection.security?.risk_level || 'no_risk')}
                </span>
                {detection.security?.categories?.length > 0 && (
                  <div className="text-muted-foreground mt-0.5">
                    {detection.security.categories.join(', ')}
                  </div>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">{t('onlineTest.complianceRisk')}:</span>
                <span className={cn("ml-1", getRiskColor(detection.compliance?.risk_level))}>
                  {translateRiskLevel(detection.compliance?.risk_level || 'no_risk')}
                </span>
                {detection.compliance?.categories?.length > 0 && (
                  <div className="text-muted-foreground mt-0.5">
                    {detection.compliance.categories.join(', ')}
                  </div>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">{t('onlineTest.dataLeak')}:</span>
                <span className={cn("ml-1", getRiskColor(detection.data?.risk_level || 'no_risk'))}>
                  {translateRiskLevel(detection.data?.risk_level || 'no_risk')}
                </span>
                {detection.data?.categories && detection.data.categories.length > 0 && (
                  <div className="text-muted-foreground mt-0.5">
                    {detection.data.categories.join(', ')}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">{t('redTeaming.chatTesting.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('redTeaming.chatTesting.description')}</p>
        </div>
        {workspaces.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('onlineTest.guardrailConfig')}:</span>
            <Select value={selectedWorkspaceId} onValueChange={setSelectedWorkspaceId}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">
                  <div className="flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5" />
                    <span>{t('onlineTest.globalConfig')}</span>
                  </div>
                </SelectItem>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-3.5 w-3.5" />
                      <span>{ws.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Chat messages area */}
      <Card className="flex-1 flex flex-col min-h-0">
        <CardContent className="flex-1 flex flex-col min-h-0 p-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <ShieldCheck className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-lg font-medium mb-2">{t('onlineTest.chat.emptyState')}</p>
                <p className="text-sm text-center max-w-md">{t('onlineTest.chat.emptyStateDesc')}</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex",
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-4 py-2",
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-secondary text-foreground'
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    {msg.role === 'user' && msg.isDetecting && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-blue-200">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t('onlineTest.chat.detecting')}
                      </div>
                    )}
                    {msg.role === 'user' && msg.detection && !msg.isDetecting && (
                      <DetectionBadge detection={msg.detection} />
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Preset test cases */}
          <div className="px-4 py-2 border-t border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">{t('onlineTest.chat.quickTest')}:</span>
              {presetTestCases.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => usePresetCase(preset)}
                  className="px-2 py-1 text-xs rounded-md bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Input area */}
          <div className="p-4 border-t border-border">
            <div className="flex gap-2">
              <Textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('onlineTest.chat.inputPlaceholder')}
                className="flex-1 min-h-[60px] max-h-[120px] resize-none"
                disabled={isDetecting}
              />
              <div className="flex flex-col gap-2">
                <Button
                  onClick={sendMessage}
                  disabled={!inputValue.trim() || isDetecting}
                  className="bg-blue-600 hover:bg-blue-700 h-[60px]"
                >
                  {isDetecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={clearConversation}
                  disabled={messages.length === 0 || isDetecting}
                  title={t('onlineTest.chat.newConversation')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {t('onlineTest.chat.enterToSend')}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default ChatTesting
