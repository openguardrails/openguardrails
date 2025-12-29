import React, { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Mail, ShieldCheck } from 'lucide-react'
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
  emailVerificationSchema,
  type EmailVerificationFormData,
} from '@/lib/validators'

const Verify: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [resendLoading, setResendLoading] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const initialEmail = searchParams.get('email') || ''

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

  const form = useForm<EmailVerificationFormData>({
    resolver: zodResolver(emailVerificationSchema),
    defaultValues: {
      email: initialEmail,
      verificationCode: '',
    },
  })

  const handleVerify = async (values: EmailVerificationFormData) => {
    try {
      setLoading(true)

      const response = await fetch('/api/v1/users/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: values.email,
          verification_code: values.verificationCode,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || t('verify.verifyFailed'))
      }

      toast.success(t('verify.verifySuccess'))
      setTimeout(() => {
        navigate('/login')
      }, 1500)
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleResendCode = async () => {
    const email = form.getValues('email')
    if (!email) {
      toast.error(t('verify.emailRequired'))
      return
    }

    try {
      setResendLoading(true)

      const response = await fetch('/api/v1/users/resend-verification-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          language: i18n.language,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || t('verify.resendFailed'))
      }

      setCountdown(60)
      toast.success(t('verify.resendSuccess'))
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setResendLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600 p-5">
      <div className="w-full max-w-md">
        <Card className="border-none shadow-2xl relative">
          {/* Language Switcher */}
          <div className="absolute top-4 right-4 z-10">
            <LanguageSwitcher />
          </div>

          <CardHeader className="text-center space-y-2 pb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {t('login.title')}
            </h1>
            <p className="text-muted-foreground text-base">
              {t('verify.title')}
            </p>
          </CardHeader>

          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleVerify)} className="space-y-5">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('register.email')}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                          <Input
                            type="email"
                            placeholder={t('verify.emailPlaceholder')}
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
                  name="verificationCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('register.verificationCode')}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <ShieldCheck className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                          <Input
                            placeholder={t('verify.verificationCodePlaceholder')}
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
                  className="w-full h-12 text-base font-medium mt-6"
                  disabled={loading}
                >
                  {loading ? t('verify.verifying') || 'Verifying...' : t('verify.verifyButton')}
                </Button>

                <div className="space-y-4 pt-2">
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
                        ? t('verify.resendCodeCountdown', { count: countdown })
                        : t('verify.resendCode')}
                    </Button>
                  </div>

                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Link to="/register" className="text-primary hover:underline font-medium">
                      {t('register.backToRegister')}
                    </Link>
                    <span>|</span>
                    <Link to="/login" className="text-primary hover:underline font-medium">
                      {t('register.alreadyHaveAccount')} {t('register.loginNow')}
                    </Link>
                  </div>
                </div>
              </form>
            </Form>
          </CardContent>

          <CardFooter className="flex-col">
            <p className="text-xs text-muted-foreground text-center">
              {t('login.copyright')}
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

export default Verify
