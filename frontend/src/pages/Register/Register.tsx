import React, { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Mail, Lock, ShieldCheck } from 'lucide-react'
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
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher'

import {
  registerSchema,
  verificationCodeSchema,
  type RegisterFormData,
  type VerificationCodeFormData,
} from '@/lib/validators'

const Register: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [resendLoading, setResendLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [userEmail, setUserEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()

  // Countdown timer
  useEffect(() => {
    let timer: NodeJS.Timeout
    if (countdown > 0) {
      timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
    }
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [countdown])

  // Register form
  const registerForm = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      email: '',
      password: '',
      confirmPassword: '',
    },
  })

  // Verification form
  const verifyForm = useForm<VerificationCodeFormData>({
    resolver: zodResolver(verificationCodeSchema),
    defaultValues: {
      verificationCode: '',
    },
  })

  const handleResendCode = async () => {
    try {
      setResendLoading(true)

      const response = await fetch('/api/v1/users/resend-verification-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: userEmail,
          language: i18n.language,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || t('register.registerFailed'))
      }

      setCountdown(60)
      toast.success(t('register.resendCodeSuccess'))
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setResendLoading(false)
    }
  }

  const handleRegister = async (values: RegisterFormData) => {
    try {
      setLoading(true)

      const response = await fetch('/api/v1/users/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: values.email,
          password: values.password,
          language: i18n.language,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || t('register.registerFailed'))
      }

      setUserEmail(values.email)
      setCurrentStep(1)
      setCountdown(60)
      toast.success(t('register.registerSuccess'))
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleVerify = async (values: VerificationCodeFormData) => {
    try {
      setLoading(true)

      const response = await fetch('/api/v1/users/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: userEmail,
          verification_code: values.verificationCode,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || t('register.verifyFailed'))
      }

      toast.success(t('register.verifySuccess'))
      setTimeout(() => {
        navigate('/login')
      }, 1500)
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  const renderRegisterForm = () => (
    <Form {...registerForm}>
      <form onSubmit={registerForm.handleSubmit(handleRegister)} className="space-y-5">
        <FormField
          control={registerForm.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('register.emailPlaceholder')}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <Input
                    type="email"
                    placeholder={t('register.emailPlaceholder')}
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
          control={registerForm.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('register.passwordPlaceholder')}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <Input
                    type="password"
                    placeholder={t('register.passwordPlaceholder')}
                    className="pl-10 h-12"
                    autoComplete="new-password"
                    {...field}
                  />
                </div>
              </FormControl>
              <FormMessage />
              <p className="text-xs text-muted-foreground mt-1">
                {t('register.passwordRequirements') || 'At least 8 characters with uppercase, lowercase, and number'}
              </p>
            </FormItem>
          )}
        />

        <FormField
          control={registerForm.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('register.confirmPasswordPlaceholder')}</FormLabel>
              <FormControl>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <Input
                    type="password"
                    placeholder={t('register.confirmPasswordPlaceholder')}
                    className="pl-10 h-12"
                    autoComplete="new-password"
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
          {loading ? t('register.registering') || 'Registering...' : t('register.registerButton')}
        </Button>
      </form>
    </Form>
  )

  const renderVerifyForm = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <p className="text-muted-foreground">
          {t('register.verificationCodeSentTo')}{' '}
          <strong className="text-foreground">{userEmail}</strong>
        </p>
        <p className="text-xs text-muted-foreground">
          {t('register.verifyLaterNote')}{' '}
          <Link
            to={`/verify?email=${encodeURIComponent(userEmail)}`}
            className="text-primary hover:underline"
          >
            {t('register.verifyLaterLink')}
          </Link>
        </p>
      </div>

      <Form {...verifyForm}>
        <form onSubmit={verifyForm.handleSubmit(handleVerify)} className="space-y-5">
          <FormField
            control={verifyForm.control}
            name="verificationCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('register.verificationCodePlaceholder')}</FormLabel>
                <FormControl>
                  <div className="relative">
                    <ShieldCheck className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                    <Input
                      placeholder={t('register.verificationCodePlaceholder')}
                      className="pl-10 h-12 text-center text-lg tracking-widest"
                      maxLength={6}
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
            className="w-full h-12 text-base font-medium"
            disabled={loading}
          >
            {loading ? t('register.verifying') || 'Verifying...' : t('register.verifyButton')}
          </Button>

          <div className="space-y-3">
            <div className="text-center text-sm">
              <span className="text-muted-foreground">{t('register.resendCodeQuestion')}</span>{' '}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-primary"
                onClick={handleResendCode}
                disabled={countdown > 0 || resendLoading}
              >
                {countdown > 0
                  ? t('register.resendCodeCountdown', { count: countdown })
                  : t('register.resendCode')}
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setCurrentStep(0)}
            >
              {t('register.backToRegister')}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )

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
            {t('register.brandingTitle') || 'AI Safety Platform'}
          </h2>
          <p className="text-blue-100 text-lg">
            {t('register.brandingSubtitle') || 'The only production-ready open-source AI guardrails platform for enterprise AI applications.'}
          </p>
        </div>
        <div className="text-sm text-blue-200">
          {t('register.copyright')}
        </div>
      </div>

      {/* Right side - Register Form */}
      <div className="flex-1 flex items-center justify-center p-8 relative">
        <div className="w-full max-w-md">
          <Card className="border shadow-sm">
            <CardHeader className="space-y-1 pb-4">
              <h1 className="text-2xl font-bold text-slate-900">
                {t('register.title')}
              </h1>
              <p className="text-slate-600 text-sm">
                {t('register.subtitle')}
              </p>
            </CardHeader>

            {/* Steps indicator */}
            <div className="px-6 pb-4">
              <div className="flex items-center justify-center gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                      currentStep === 0
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    1
                  </div>
                  <span className={`text-xs font-medium ${currentStep === 0 ? 'text-slate-900' : 'text-slate-500'}`}>
                    {t('register.stepFillInfo')}
                  </span>
                </div>
                <div className="w-8 h-0.5 bg-slate-300" />
                <div className="flex items-center gap-2">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                      currentStep === 1
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    2
                  </div>
                  <span className={`text-xs font-medium ${currentStep === 1 ? 'text-slate-900' : 'text-slate-500'}`}>
                    {t('register.stepVerifyEmail')}
                  </span>
                </div>
              </div>
            </div>

          <CardContent>
            {currentStep === 0 ? renderRegisterForm() : renderVerifyForm()}
          </CardContent>

            <CardFooter className="flex-col pt-6">
              <div className="text-center text-sm">
                <span className="text-slate-600">{t('register.alreadyHaveAccount')} </span>
                <Link to="/login" className="text-blue-600 hover:text-blue-700 font-medium hover:underline">
                  {t('register.loginNow')}
                </Link>
              </div>
            </CardFooter>
          </Card>

          {/* Mobile Copyright */}
          <p className="text-xs text-slate-500 text-center mt-6 lg:hidden">
            {t('register.copyright')}
          </p>
        </div>

        {/* Language Switcher - Bottom right corner */}
        <div className="absolute bottom-8 right-8">
          <div className="scale-75 opacity-60 hover:opacity-100 transition-opacity">
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </div>
  )
}

export default Register
