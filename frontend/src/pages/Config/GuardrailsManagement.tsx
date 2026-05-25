import React from 'react'
import OfficialScannersManagement from './OfficialScannersManagement'
import CustomScannersManagement from './CustomScannersManagement'

interface GuardrailsManagementProps {
  workspaceId?: string
}

const GuardrailsManagement: React.FC<GuardrailsManagementProps> = ({ workspaceId }) => {
  return (
    <div className="space-y-8">
      {/* OG Guardrails */}
      <OfficialScannersManagement workspaceId={workspaceId} />

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Custom Guardrails */}
      <CustomScannersManagement workspaceId={workspaceId} />
    </div>
  )
}

export default GuardrailsManagement
