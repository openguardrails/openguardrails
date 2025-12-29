import React, { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useAuth } from '../../contexts/AuthContext'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Mail, Lock } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher'

import { loginSchema, type LoginFormData } from '@/lib/validators'

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [showVerificationAlert, setShowVerificationAlert] = useState(false)
  const [unverifiedEmail, setUnverifiedEmail] = useState('')
  const [showPasswordChangeModal, setShowPasswordChangeModal] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState('')

  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()

  const from = (location.state as any)?.from?.pathname || '/dashboard'

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  })

  const onSubmit = async (values: LoginFormData) => {
    try {
      setLoading(true)
      setShowVerificationAlert(false)

      // Get current language from localStorage
      const currentLanguage = localStorage.getItem('i18nextLng') || 'en'
      const loginResult = await login(values.email, values.password, currentLanguage)

      if (loginResult.requiresPasswordChange) {
        setPasswordMessage(
          loginResult.passwordMessage ||
            'Your password does not meet current security requirements. Please update it.'
        )
        setShowPasswordChangeModal(true)
      } else {
        toast.success(t('login.loginSuccess'))
        navigate(from, { replace: true })
      }
    } catch (error: any) {
      console.error('Login error:', error)
      console.error('Error details:', {
        status: error.response?.status,
        data: error.response?.data,
        config: error.config,
      })

      const errorMessage = error.response?.data?.detail || t('login.loginFailed')

      // Check if account is not activated
      if (error.response?.status === 403 && errorMessage.includes('not activated')) {
        setUnverifiedEmail(values.email)
        setShowVerificationAlert(true)
      } else {
        toast.error(errorMessage)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Left side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 p-12 flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-8">
            <img src="/platform/logo-dark.png" alt="Logo" className="h-12 w-12 bg-white rounded-lg p-2" />
            <h1 className="text-2xl font-bold text-white">OpenGuardrails</h1>
          </div>
          <h2 className="text-4xl font-bold text-white mb-4">
            {t('login.brandingTitle') || 'AI Safety Platform'}
          </h2>
          <p className="text-blue-100 text-lg">
            {t('login.brandingSubtitle') || 'The only production-ready open-source AI guardrails platform for enterprise AI applications.'}
          </p>
        </div>
        <div className="text-sm text-blue-200">
          {t('login.copyright')}
        </div>
      </div>

      {/* Right side - Login Form */}
      <div className="flex-1 flex items-center justify-center p-8 relative">
        <div className="w-full max-w-md">
          <Card className="border shadow-sm">
            <CardHeader className="space-y-1 pb-6">
              <h1 className="text-2xl font-bold text-slate-900">
                {t('login.title')}
              </h1>
              <p className="text-slate-600 text-sm">
                {t('login.subtitle')}
              </p>
            </CardHeader>

            <CardContent>
              {/* Verification Alert */}
              {showVerificationAlert && (
                <Alert variant="destructive" className="mb-6">
                  <AlertDescription className="space-y-3">
                    <div>
                      <p className="font-medium mb-1">{t('login.accountNotActivated')}</p>
                      <p className="text-sm">
                        {t('login.accountNotActivatedDesc', { email: unverifiedEmail })}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-destructive-foreground underline"
                        onClick={() =>
                          navigate(`/verify?email=${encodeURIComponent(unverifiedEmail)}`)
                        }
                      >
                        {t('login.goToVerifyPage')}
                      </Button>
                      <span className="text-destructive-foreground/60">|</span>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-destructive-foreground underline"
                        onClick={() => setShowVerificationAlert(false)}
                      >
                        {t('login.closeReminder')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {/* Login Form */}
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('login.emailPlaceholder')}</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                            <Input
                              type="email"
                              placeholder={t('login.emailPlaceholder')}
                              className="pl-10 h-12"
                              autoComplete="email"
                              {...field}
                            />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('login.passwordPlaceholder')}</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                            <Input
                              type="password"
                              placeholder={t('login.passwordPlaceholder')}
                              className="pl-10 h-12"
                              autoComplete="current-password"
                              {...field}
                            />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button
                    type="submit"
                    className="w-full h-12 text-base font-medium mt-6"
                    disabled={loading}
                  >
                    {loading ? t('login.loggingIn') || 'Logging in...' : t('login.loginButton')}
                  </Button>
                </form>
              </Form>
            </CardContent>

            <CardFooter className="flex-col space-y-3 pt-6">
              <div className="flex flex-col gap-2 text-sm text-center">
                <div>
                  <span className="text-slate-600">{t('login.noAccount')} </span>
                  <Link to="/register" className="text-blue-600 hover:text-blue-700 font-medium hover:underline">
                    {t('login.registerNow')}
                  </Link>
                </div>
                <div>
                  <Link to="/verify" className="text-slate-600 hover:text-slate-900 hover:underline">
                    {t('login.verifyPage')}
                  </Link>
                  <span className="text-slate-400 mx-2">•</span>
                  <Link to="/forgot-password" className="text-slate-600 hover:text-slate-900 hover:underline">
                    {t('login.forgotPassword')}
                  </Link>
                </div>
              </div>
            </CardFooter>
          </Card>

          {/* Mobile Copyright */}
          <p className="text-xs text-slate-500 text-center mt-6 lg:hidden">
            {t('login.copyright')}
          </p>
        </div>

        {/* Language Switcher - Bottom right corner */}
        <div className="absolute bottom-8 right-8">
          <div className="scale-75 opacity-60 hover:opacity-100 transition-opacity">
            <LanguageSwitcher />
          </div>
        </div>
      </div>

      {/* Password Change Modal */}
      <Dialog open={showPasswordChangeModal} onOpenChange={setShowPasswordChangeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('login.passwordChangeRequired')}</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <p>{passwordMessage}</p>
              <p>{t('login.passwordChangeDescription')}</p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowPasswordChangeModal(false)}
            >
              {t('login.changeLater')}
            </Button>
            <Button
              onClick={() => {
                setShowPasswordChangeModal(false)
                navigate('/account?tab=password')
              }}
            >
              {t('login.changeNow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Login
