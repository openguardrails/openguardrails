import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FileText, BookOpen, Info } from 'lucide-react'
import KnowledgeBaseManagement from './KnowledgeBaseManagement'

/**
 * Answer Management Page
 *
 * Combines two tabs:
 * 1. Fixed Answer (据答): Simple explanation - uses generic template with {scanner_name}
 * 2. Proxy Answer (代答): Knowledge base for generating AI-assisted responses
 */
const AnswerManagement: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [activeTab, setActiveTab] = useState('fixed-answer')

  const isZh = i18n.language === 'zh'

  // Example templates to show users
  const securityRiskExample = isZh
    ? '请求已被OpenGuardrails拦截，原因：可能违反了与{scanner_name}有关的策略要求。'
    : 'Request blocked by OpenGuardrails due to possible violation of policy related to {scanner_name}.'

  const dataLeakageExample = isZh
    ? '请求已被OpenGuardrails拦截，原因：可能包含敏感数据（{entity_type_names}）。'
    : 'Request blocked by OpenGuardrails due to possible sensitive data ({entity_type_names}).'

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
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="font-medium text-sm mb-2">{t('answer.fixedAnswerTitle')}</h4>
                      <p className="text-sm text-muted-foreground">
                        {t('answer.fixedAnswerDesc')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Security Risk Template */}
                <div className="rounded-lg border p-4">
                  <h5 className="text-sm font-medium mb-2">{t('answer.securityRiskTemplate')}</h5>
                  <div className="bg-muted rounded p-3 font-mono text-sm">
                    {securityRiskExample}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {t('answer.securityRiskTemplateDesc')}
                  </p>
                </div>

                {/* Data Leakage Template */}
                <div className="rounded-lg border p-4">
                  <h5 className="text-sm font-medium mb-2">{t('answer.dataLeakageTemplate')}</h5>
                  <div className="bg-muted rounded p-3 font-mono text-sm">
                    {dataLeakageExample}
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
    </div>
  )
}

export default AnswerManagement
