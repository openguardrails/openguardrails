import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import LLMProviders from './LLMProviders'
import ModelRoutes from './ModelRoutes'

const ProvidersAndRoutes: React.FC = () => {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('providers')

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="providers">{t('nav.llmProviders')}</TabsTrigger>
          <TabsTrigger value="routes">{t('nav.modelRoutes')}</TabsTrigger>
        </TabsList>
        <TabsContent value="providers">
          <LLMProviders />
        </TabsContent>
        <TabsContent value="routes">
          <ModelRoutes />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default ProvidersAndRoutes
