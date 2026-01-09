import { useLocation } from 'react-router-dom'
import OfficialScannersManagement from './OfficialScannersManagement'
import CustomScannersManagement from './CustomScannersManagement'
import SensitivityThresholdManagement from './SensitivityThresholdManagement'
import DataSecurity from '../DataSecurity'
import BlacklistManagement from './BlacklistManagement'
import WhitelistManagement from './WhitelistManagement'
import ResponseTemplateManagement from './ResponseTemplateManagement'
import KnowledgeBaseManagement from './KnowledgeBaseManagement'

const Config: React.FC = () => {
  const location = useLocation()

  const renderContent = () => {
    const path = location.pathname

    if (path === '/config' || path === '/config/' || path.includes('/official-scanners')) {
      return <OfficialScannersManagement />
    }
    if (path.includes('/custom-scanners')) {
      return <CustomScannersManagement />
    }
    if (path.includes('/sensitivity-thresholds')) {
      return <SensitivityThresholdManagement />
    }
    if (path.includes('/data-security')) {
      return <DataSecurity />
    }
    if (path.includes('/blacklist')) {
      return <BlacklistManagement />
    }
    if (path.includes('/whitelist')) {
      return <WhitelistManagement />
    }
    if (path.includes('/responses') || path.includes('/response-templates')) {
      return <ResponseTemplateManagement />
    }
    if (path.includes('/knowledge-bases')) {
      return <KnowledgeBaseManagement />
    }

    return <OfficialScannersManagement />
  }

  return (
    <div className="space-y-6">
      {renderContent()}
    </div>
  )
}

export default Config
