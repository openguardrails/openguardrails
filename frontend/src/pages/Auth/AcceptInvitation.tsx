import React, { useEffect, useState } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { teamApi } from '../../services/api'

interface InvitationInfo {
  email: string
  role: string
  org_email: string | null
  has_account: boolean
  is_verified: boolean
}

const AcceptInvitation: React.FC = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''

  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    if (!token) {
      setError(t('team.invitationInvalid'))
      setLoading(false)
      return
    }
    verifyToken()
  }, [token])

  const verifyToken = async () => {
    try {
      const data = await teamApi.verifyInvitation(token)
      setInvitation(data)
    } catch (error: any) {
      if (error.response?.status === 410) {
        setError(t('team.invitationExpired'))
      } else {
        setError(t('team.invitationInvalid'))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleAccept = async () => {
    if (!invitation) return

    // New user needs password
    if (!invitation.has_account) {
      if (!password) {
        toast.error(t('team.setPassword'))
        return
      }
      if (password !== confirmPassword) {
        toast.error('Passwords do not match')
        return
      }
    }

    setAccepting(true)
    try {
      await teamApi.acceptInvitation({
        token,
        password: invitation.has_account ? undefined : password,
      })
      toast.success(t('team.invitationAccepted'))
      navigate('/login')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to accept invitation')
    } finally {
      setAccepting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <p className="text-destructive">{error}</p>
            <Link to="/login">
              <Button variant="outline">Go to Login</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!invitation) return null

  const roleLabel = invitation.role === 'admin' ? t('team.roles.admin') : t('team.roles.member')

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>{t('team.joinTeam')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2 text-center">
            <p className="text-sm text-muted-foreground">
              {invitation.org_email && (
                <>
                  <span className="font-medium text-foreground">{invitation.org_email}</span>
                  {' '}has invited you to join their team
                </>
              )}
            </p>
            <div className="flex justify-center gap-2">
              <Badge variant="outline">{invitation.email}</Badge>
              <Badge variant="secondary">{roleLabel}</Badge>
            </div>
          </div>

          {invitation.has_account ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {t('team.alreadyHaveAccount')}
              </p>
              <Button className="w-full" onClick={handleAccept} disabled={accepting}>
                {accepting ? 'Accepting...' : t('team.acceptInvitation')}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('team.email')}</Label>
                <Input value={invitation.email} disabled />
              </div>
              <div className="space-y-2">
                <Label>{t('team.setPassword')}</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                />
              </div>
              <div className="space-y-2">
                <Label>Confirm Password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                />
              </div>
              <Button
                className="w-full"
                onClick={handleAccept}
                disabled={accepting || !password || password !== confirmPassword}
              >
                {accepting ? 'Creating account...' : t('team.createAccount')}
              </Button>
            </div>
          )}

          <div className="text-center">
            <Link to="/login" className="text-sm text-muted-foreground hover:underline">
              Back to Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default AcceptInvitation
