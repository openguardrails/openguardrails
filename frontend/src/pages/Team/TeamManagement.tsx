import React, { useEffect, useState } from 'react'
import { UserPlus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { confirmDialog } from '@/utils/confirm-dialog'
import { teamApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { format } from 'date-fns'

interface Member {
  user_id: string
  email: string
  role: string
  joined_at: string | null
}

const TeamManagement: React.FC = () => {
  const { t } = useTranslation()
  const { user, canEdit } = useAuth()
  const [members, setMembers] = useState<Member[]>([])
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createRole, setCreateRole] = useState('member')
  const [loading, setLoading] = useState(false)

  const isOwner = user?.member_role === 'owner' || user?.is_super_admin

  const fetchData = async () => {
    setLoading(true)
    try {
      const membersData = await teamApi.listMembers()
      setMembers(membersData)
    } catch (error) {
      console.error('Failed to load team data:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const handleCreateMember = async () => {
    if (!createEmail.trim() || !createPassword.trim()) return
    try {
      await teamApi.createMember({ email: createEmail.trim(), password: createPassword, role: createRole })
      toast.success(t('team.userCreated') || 'User created successfully')
      setCreateDialogOpen(false)
      setCreateEmail('')
      setCreatePassword('')
      setCreateRole('member')
      fetchData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to create user')
    }
  }

  const handleChangeRole = async (userId: string, newRole: string) => {
    try {
      await teamApi.changeRole(userId, newRole)
      toast.success(t('team.roleUpdated'))
      fetchData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to change role')
    }
  }

  const handleRemoveMember = async (member: Member) => {
    const confirmed = await confirmDialog({
      title: t('team.removeMember'),
      description: t('team.confirmRemove'),
    })
    if (!confirmed) return
    try {
      await teamApi.removeMember(member.user_id)
      toast.success(t('team.memberRemoved'))
      fetchData()
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to remove member')
    }
  }

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'owner':
        return <Badge variant="default">{t('team.roles.owner')}</Badge>
      case 'admin':
        return <Badge variant="secondary">{t('team.roles.admin')}</Badge>
      case 'member':
        return <Badge variant="outline">{t('team.roles.member')}</Badge>
      default:
        return <Badge variant="outline">{role}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold tracking-tight">{t('team.title')}</h2>
        {canEdit && isOwner && (
          <Button onClick={() => setCreateDialogOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            {t('team.addUser') || 'Add User'}
          </Button>
        )}
      </div>

      {!canEdit && (
        <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          {t('team.readOnlyNotice')}
        </div>
      )}

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle>{t('team.members')}</CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('team.noMembers')}</p>
          ) : (
            <div className="space-y-3">
              {members.map((member) => (
                <div
                  key={member.user_id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-sm font-medium">{member.email}</p>
                      {member.joined_at && (
                        <p className="text-xs text-muted-foreground">
                          {t('team.joinedAt')}: {format(new Date(member.joined_at), 'yyyy-MM-dd')}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {member.role === 'owner' ? (
                      getRoleBadge(member.role)
                    ) : isOwner ? (
                      <Select
                        value={member.role}
                        onValueChange={(val) => handleChangeRole(member.user_id, val)}
                      >
                        <SelectTrigger className="w-[140px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">{t('team.roles.admin')}</SelectItem>
                          <SelectItem value="member">{t('team.roles.member')}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      getRoleBadge(member.role)
                    )}
                    {canEdit && member.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMember(member)}
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('team.addUser') || 'Add User'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('team.email')}</Label>
              <Input
                type="email"
                placeholder="user@company.com"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('team.password') || 'Password'}</Label>
              <Input
                type="password"
                placeholder={t('team.passwordPlaceholder') || 'Min 8 chars, upper/lower/number'}
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('team.role')}</Label>
              <Select value={createRole} onValueChange={setCreateRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t('team.roles.admin')}</SelectItem>
                  <SelectItem value="member">{t('team.roles.member')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateMember} disabled={!createEmail.trim() || !createPassword.trim()}>
              {t('team.addUser') || 'Add User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

export default TeamManagement
