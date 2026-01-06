import React from 'react'
import { Shield, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import EntityTypeManagement from './EntityTypeManagement'
import DataLeakagePolicyTab from './DataLeakagePolicyTab'

const DataSecurity: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <span>{t('dataSecurity.dataLeakPrevention')}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-2">
            <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-blue-900">{t('dataSecurity.dataLeakPreventionDesc')}</p>
          </div>

          <Collapsible className="bg-gray-50 rounded-lg p-4">
            <CollapsibleTrigger className="flex items-center gap-2 font-semibold text-sm hover:text-blue-600 transition-colors">
              💡 {t('dataSecurity.functionalityGuide')}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4 space-y-4">
              <div>
                <p className="font-semibold text-sm mb-2">
                  📥 {t('dataSecurity.inputDataPrevention')}
                </p>
                <p className="text-sm text-gray-700 mb-2">
                  {t('dataSecurity.inputDataPreventionDesc')}
                </p>
                <ul className="list-disc pl-5 text-xs text-gray-600 space-y-1">
                  <li>{t('dataSecurity.enterpriseDeployment')}</li>
                  <li>{t('dataSecurity.publicService')}</li>
                </ul>
              </div>

              <div>
                <p className="font-semibold text-sm mb-2">
                  📤 {t('dataSecurity.outputDataPrevention')}
                </p>
                <p className="text-sm text-gray-700 mb-2">
                  {t('dataSecurity.outputDataPreventionDesc')}
                </p>
                <ul className="list-disc pl-5 text-xs text-gray-600 space-y-1">
                  <li>{t('dataSecurity.enterpriseInternal')}</li>
                  <li>{t('dataSecurity.publicServiceOutput')}</li>
                </ul>
              </div>

              <div>
                <p className="font-semibold text-sm mb-2">📋 {t('sensitivity.usageSteps')}</p>
                <ol className="list-decimal pl-5 text-xs text-gray-600 space-y-1">
                  <li>{t('sensitivity.configEntityTypes')}</li>
                  <li>{t('sensitivity.setRecognitionRules')}</li>
                  <li>{t('sensitivity.selectDesensitizationMethod')}</li>
                  <li>{t('sensitivity.configDetectionScope')}</li>
                </ol>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Tabs defaultValue="entity-types" className="w-full">
            <TabsList>
              <TabsTrigger value="entity-types">
                {t('dataSecurity.entityTypeTab')}
              </TabsTrigger>
              <TabsTrigger value="policy">
                {t('dataSecurity.policyTab')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="entity-types" className="mt-6">
              <EntityTypeManagement />
            </TabsContent>
            <TabsContent value="policy" className="mt-6">
              <DataLeakagePolicyTab />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

export default DataSecurity