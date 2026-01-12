import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { FileText, BookOpen, Info, X, Edit2 } from 'lucide-react'
import { toast } from 'sonner'
import KnowledgeBaseManagement from './KnowledgeBaseManagement'
import { fixedAnswerTemplatesApi } from '../../services/api'

/**
 * Answer Management Page
 *
 * Combines two tabs:
 * 1. Fixed Answer (据答): Simple explanation - uses generic template with {scanner_name}
 * 2. Proxy Answer (代答): Knowledge base for generating AI-assisted responses
 */
const FIXED_ANSWER_INFO_DISMISSED_KEY = 'answerManagement.fixedAnswerInfoDismissed'

interface TemplateData {
  security_risk_template: { en: string; zh: string }
  data_leakage_template: { en: string; zh: string }
}

const defaultTemplates: TemplateData = {
  security_risk_template: {
    en: 'Request blocked by OpenGuardrails due to possible violation of policy related to {scanner_name}.',
    zh: '请求已被OpenGuardrails拦截，原因：可能违反了与{scanner_name}有关的策略要求。'
  },
  data_leakage_template: {
    en: 'Request blocked by OpenGuardrails due to possible sensitive data ({entity_type_names}).',
    zh: '请求已被OpenGuardrails拦截，原因：可能包含敏感数据（{entity_type_names}）。'
  }
}

const AnswerManagement: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [activeTab, setActiveTab] = useState('fixed-answer')
  const [infoDismissed, setInfoDismissed] = useState(() => {
    return localStorage.getItem(FIXED_ANSWER_INFO_DISMISSED_KEY) === 'true'
  })

  // Template editing state
  const [templates, setTemplates] = useState<TemplateData>(defaultTemplates)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<'security_risk' | 'data_leakage' | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const isZh = i18n.language === 'zh'
  const currentLang = isZh ? 'zh' : 'en'

  // Load templates from backend
  useEffect(() => {
    loadTemplates()
  }, [])

  const loadTemplates = async () => {
    try {
      setLoading(true)
      const data = await fixedAnswerTemplatesApi.get()
      if (data) {
        setTemplates({
          security_risk_template: data.security_risk_template || defaultTemplates.security_risk_template,
          data_leakage_template: data.data_leakage_template || defaultTemplates.data_leakage_template
        })
      }
    } catch (error) {
      console.error('Failed to load templates:', error)
      // Use defaults on error
    } finally {
      setLoading(false)
    }
  }

  const handleDismissInfo = () => {
    localStorage.setItem(FIXED_ANSWER_INFO_DISMISSED_KEY, 'true')
    setInfoDismissed(true)
  }

  const handleEditTemplate = (type: 'security_risk' | 'data_leakage') => {
    setEditingTemplate(type)
    const template = type === 'security_risk' ? templates.security_risk_template : templates.data_leakage_template
    setEditValue(template[currentLang])
    setEditModalOpen(true)
  }

  const handleSaveTemplate = async () => {
    if (!editingTemplate) return

    try {
      setSaving(true)
      const templateKey = editingTemplate === 'security_risk' ? 'security_risk_template' : 'data_leakage_template'
      const updatedTemplate = {
        ...templates[templateKey],
        [currentLang]: editValue
      }

      await fixedAnswerTemplatesApi.update({
        [templateKey]: updatedTemplate
      })

      setTemplates(prev => ({
        ...prev,
        [templateKey]: updatedTemplate
      }))

      toast.success(t('common.updateSuccess'))
      setEditModalOpen(false)
    } catch (error) {
      console.error('Failed to save template:', error)
      toast.error(t('common.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  // Current template values for display
  const securityRiskTemplate = templates.security_risk_template[currentLang]
  const dataLeakageTemplate = templates.data_leakage_template[currentLang]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t('answer.title')}</CardTitle>
          <CardDescription className="text-sm">{t('answer.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="fixed-answer" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                {t('answer.fixedAnswer')}
              </TabsTrigger>
              <TabsTrigger value="proxy-answer" className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                {t('answer.proxyAnswer')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="fixed-answer" className="mt-0">
              <div className="space-y-4">
                {/* Explanation */}
                {!infoDismissed && (
                  <div className="rounded-lg border bg-card p-4 relative">
                    <button
                      onClick={handleDismissInfo}
                      className="absolute top-2 right-2 p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded"
                      title={t('common.close')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                    <div className="flex items-start gap-3 pr-6">
                      <Info className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <h4 className="font-medium text-sm mb-2">{t('answer.fixedAnswerTitle')}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t('answer.fixedAnswerDesc')}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Security Risk Template */}
                <div className="rounded-lg border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="text-sm font-medium">{t('answer.securityRiskTemplate')}</h5>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditTemplate('security_risk')}
                      disabled={loading}
                    >
                      <Edit2 className="h-4 w-4 mr-1" />
                      {t('common.edit')}
                    </Button>
                  </div>
                  <div className="bg-muted rounded p-3 font-mono text-sm">
                    {securityRiskTemplate}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {t('answer.securityRiskTemplateDesc')}
                  </p>
                </div>

                {/* Data Leakage Template */}
                <div className="rounded-lg border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="text-sm font-medium">{t('answer.dataLeakageTemplate')}</h5>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditTemplate('data_leakage')}
                      disabled={loading}
                    >
                      <Edit2 className="h-4 w-4 mr-1" />
                      {t('common.edit')}
                    </Button>
                  </div>
                  <div className="bg-muted rounded p-3 font-mono text-sm">
                    {dataLeakageTemplate}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {t('answer.dataLeakageTemplateDesc')}
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="proxy-answer" className="mt-0">
              <div className="rounded-lg border bg-card p-4 mb-4">
                <div className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-medium text-sm mb-2">{t('answer.proxyAnswerTitle')}</h4>
                    <p className="text-sm text-muted-foreground">
                      {t('answer.proxyAnswerDesc')}
                    </p>
                    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-md">
                      <p className="text-sm text-blue-700 dark:text-blue-300">
                        <strong>{t('answer.proxyAnswerNote')}:</strong> {t('answer.proxyAnswerNoteDesc')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <KnowledgeBaseManagement />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Edit Template Modal */}
      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate === 'security_risk'
                ? t('answer.editSecurityRiskTemplate')
                : t('answer.editDataLeakageTemplate')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>{t('answer.templateContent')}</Label>
              <Textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={4}
                className="mt-2 font-mono"
                placeholder={editingTemplate === 'security_risk'
                  ? t('answer.securityRiskPlaceholder')
                  : t('answer.dataLeakagePlaceholder')}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {editingTemplate === 'security_risk'
                ? t('answer.securityRiskTemplateDesc')
                : t('answer.dataLeakageTemplateDesc')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('answer.editLanguageHint', { language: isZh ? '中文' : 'English' })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveTemplate} disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default AnswerManagement
