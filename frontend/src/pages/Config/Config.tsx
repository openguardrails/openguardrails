import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import BlacklistManagement from './BlacklistManagement'
import WhitelistManagement from './WhitelistManagement'
import ResponseTemplateManagement from './ResponseTemplateManagement'
import KnowledgeBaseManagement from './KnowledgeBaseManagement'
import SensitivityThresholdManagement from './SensitivityThresholdManagement'
import DataSecurity from '../DataSecurity'
import BanPolicy from './BanPolicy'
import OfficialScannersManagement from './OfficialScannersManagement'
import CustomScannersManagement from './CustomScannersManagement'

const Config: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  const getActiveKey = () => {
    const path = location.pathname
    if (path.includes('/blacklist')) return 'blacklist'
    if (path.includes('/whitelist')) return 'whitelist'
    if (path.includes('/responses')) return 'responses'
    if (path.includes('/knowledge-bases')) return 'knowledge-bases'
    if (path.includes('/sensitivity-thresholds')) return 'sensitivity-thresholds'
    if (path.includes('/data-security')) return 'data-security'
    if (path.includes('/ban-policy')) return 'ban-policy'
    if (path.includes('/official-scanners')) return 'official-scanners'
    if (path.includes('/custom-scanners')) return 'custom-scanners'
    return 'official-scanners'
  }

  const handleTabChange = (key: string) => {
    navigate(`/config/${key}`)
  }

  const tabs = [
    {
      key: 'official-scanners',
      label: t('scannerPackages.officialScanners'),
      content: <OfficialScannersManagement />,
    },
    {
      key: 'custom-scanners',
      label: t('customScanners.title'),
      content: <CustomScannersManagement />,
    },
    {
      key: 'sensitivity-thresholds',
      label: t('config.sensitivity'),
      content: <SensitivityThresholdManagement />,
    },
    {
      key: 'data-security',
      label: t('config.dataSecurity'),
      content: <DataSecurity />,
    },
    {
      key: 'ban-policy',
      label: t('config.banPolicy'),
      content: <BanPolicy />,
    },
    {
      key: 'blacklist',
      label: t('config.blacklist'),
      content: <BlacklistManagement />,
    },
    {
      key: 'whitelist',
      label: t('config.whitelist'),
      content: <WhitelistManagement />,
    },
    {
      key: 'responses',
      label: t('config.rejectAnswers'),
      content: <ResponseTemplateManagement />,
    },
    {
      key: 'knowledge-bases',
      label: t('config.knowledge'),
      content: <KnowledgeBaseManagement />,
    },
  ]

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold tracking-tight">{t('config.title')}</h2>

      <Tabs value={getActiveKey()} onValueChange={handleTabChange}>
        <TabsList className="grid w-full grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent key={tab.key} value={tab.key} className="mt-6">
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

export default Config
