import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from './AuthContext'

interface Workspace {
  id: string
  name: string
  is_global: boolean
}

interface WorkspaceContextType {
  workspaces: Workspace[]
  currentWorkspaceId: string | null
  setCurrentWorkspaceId: (id: string | null) => void
  refreshWorkspaces: () => void
  loading: boolean
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined)

export const WorkspaceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(() => {
    return localStorage.getItem('current_workspace_id')
  })
  const [loading, setLoading] = useState(false)

  const fetchWorkspaces = useCallback(async () => {
    if (!isAuthenticated) return
    setLoading(true)
    try {
      const response = await api.get('/api/v1/workspaces')
      const ws: Workspace[] = response.data
      setWorkspaces(ws)

      const storedId = localStorage.getItem('current_workspace_id')
      const exists = ws.some(w => w.id === storedId)

      if (!exists) {
        // Default to global workspace
        const globalWs = ws.find(w => w.is_global)
        const defaultId = globalWs?.id || ws[0]?.id || null
        handleSetWorkspaceId(defaultId)
      }
    } catch (error) {
      console.error('Failed to fetch workspaces:', error)
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (isAuthenticated) {
      fetchWorkspaces()
    } else {
      setWorkspaces([])
    }
  }, [isAuthenticated, fetchWorkspaces])

  const handleSetWorkspaceId = (id: string | null) => {
    setCurrentWorkspaceId(id)
    if (id) {
      localStorage.setItem('current_workspace_id', id)
    } else {
      localStorage.removeItem('current_workspace_id')
    }
  }

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        currentWorkspaceId,
        setCurrentWorkspaceId: handleSetWorkspaceId,
        refreshWorkspaces: fetchWorkspaces,
        loading,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}

export const useWorkspace = () => {
  const context = useContext(WorkspaceContext)
  if (context === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return context
}
