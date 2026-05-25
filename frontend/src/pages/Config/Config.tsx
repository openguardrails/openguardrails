import { useLocation } from 'react-router-dom'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import WorkspaceSelector from '../../components/WorkspaceSelector'
import GuardrailsManagement from './GuardrailsManagement'
import SensitivityThresholdManagement from './SensitivityThresholdManagement'
import DataSecurity from '../DataSecurity'
import KeywordListManagement from './KeywordListManagement'
import AnswerManagement from './AnswerManagement'

const Config: React.FC = () => {
  const location = useLocation()
  const { currentWorkspaceId } = useWorkspace()

  const renderContent = () => {
    const path = location.pathname

    if (path === '/config' || path === '/config/' || path.includes('/guardrails')) {
      return <GuardrailsManagement workspaceId={currentWorkspaceId || undefined} />
    }
    if (path.includes('/sensitivity-thresholds')) {
      return <SensitivityThresholdManagement />
    }
    if (path.includes('/data-masking') || path.includes('/data-security')) {
      return <DataSecurity workspaceId={currentWorkspaceId || undefined} />
    }
    if (path.includes('/keyword-list') || path.includes('/blacklist') || path.includes('/whitelist')) {
      return <KeywordListManagement workspaceId={currentWorkspaceId || undefined} />
    }
    // Unified answer management page (combines response templates and knowledge bases)
    if (path.includes('/answers') || path.includes('/responses') || path.includes('/response-templates') || path.includes('/knowledge-bases')) {
      return <AnswerManagement workspaceId={currentWorkspaceId || undefined} />
    }

    return <GuardrailsManagement workspaceId={currentWorkspaceId || undefined} />
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <WorkspaceSelector />
      </div>
      {renderContent()}
    </div>
  )
}

export default Config
