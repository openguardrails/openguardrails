import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

const WorkspaceSelector: React.FC = () => {
  const { t } = useTranslation()
  const { workspaces, currentWorkspaceId, setCurrentWorkspaceId, loading } = useWorkspace()

  // Sort: global first, then alphabetical
  const sortedWorkspaces = useMemo(() =>
    [...workspaces].sort((a, b) => {
      if (a.is_global !== b.is_global) return a.is_global ? -1 : 1
      return a.name.localeCompare(b.name)
    }), [workspaces])

  if (loading || workspaces.length === 0) return null

  return (
    <div className="flex items-center gap-2">
      <Layers className="h-4 w-4 text-muted-foreground" />
      <Select value={currentWorkspaceId || ''} onValueChange={setCurrentWorkspaceId}>
        <SelectTrigger className="w-[200px] h-8 text-sm">
          <SelectValue placeholder={t('workspaces.selectWorkspace', 'Select workspace')} />
        </SelectTrigger>
        <SelectContent>
          {sortedWorkspaces.map(ws => (
            <SelectItem key={ws.id} value={ws.id}>
              <span className="flex items-center gap-2">
                {ws.is_global ? t('workspaces.globalDefault', 'Default Workspace') : ws.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export default WorkspaceSelector
