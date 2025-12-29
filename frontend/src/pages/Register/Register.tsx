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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600 p-5">
      <div className="w-full max-w-md">
        <Card className="border-none shadow-2xl relative">
          {/* Language Switcher */}
          <div className="absolute top-4 right-4 z-10">
            <LanguageSwitcher />
          </div>

          <CardHeader className="text-center space-y-2 pb-6">
            <h1 className="text-3xl font-bold text-gray-900">
              {t('register.title')}
            </h1>
            <p className="text-muted-foreground text-base">
              {t('register.subtitle')}
            </p>
          </CardHeader>

          {/* Steps indicator */}
          <div className="px-6 pb-6">
            <div className="flex items-center justify-center space-x-4">
              <div className="flex items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    currentStep === 0
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  1
                </div>
                <span className="ml-2 text-sm font-medium">
                  {t('register.stepFillInfo')}
                </span>
              </div>
              <div className="w-12 h-0.5 bg-border" />
              <div className="flex items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    currentStep === 1
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  2
                </div>
                <span className="ml-2 text-sm font-medium">
                  {t('register.stepVerifyEmail')}
                </span>
              </div>
            </div>
          </div>

          <CardContent>
            {currentStep === 0 ? renderRegisterForm() : renderVerifyForm()}
          </CardContent>

          <CardFooter className="flex-col space-y-4">
            <div className="text-center text-sm text-muted-foreground">
              {t('register.alreadyHaveAccount')}{' '}
              <Link to="/login" className="text-primary hover:underline font-medium">
                {t('register.loginNow')}
              </Link>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {t('register.copyright')}
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

export default Register
