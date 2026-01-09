import { useLocation } from 'react-router-dom'
import BanPolicyPage from './BanPolicyPage'
import FalsePositiveAppeal from './FalsePositiveAppeal'

const AccessControl: React.FC = () => {
  const location = useLocation()

  const renderContent = () => {
    const path = location.pathname

    if (path.includes('/false-positive-appeal') || path.includes('/appeal')) {
      return <FalsePositiveAppeal />
    }
    // Default to ban policy
    return <BanPolicyPage />
  }

  return (
    <div className="space-y-6">
      {renderContent()}
    </div>
  )
}

export default AccessControl
