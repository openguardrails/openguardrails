import React, { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Mail, CheckCircle2 } from 'lucide-react'
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
import { Alert, AlertDescription } from '@/components/ui/alert'
import LanguageSwitcher from '../../components/LanguageSwitcher/LanguageSwitcher'
import api from '../../services/api'

import {
  forgotPasswordSchema,
  type ForgotPasswordFormData,
} from '@/lib/validators'

const ForgotPassword: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState('')
  const { t, i18n } = useTranslation()

  const form = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: {
      email: '',
    },
  })

  const handleSubmit = async (values: ForgotPasswordFormData) => {
    try {
      setLoading(true)
      const currentLanguage = i18n.language || localStorage.getItem('i18nextLng') || 'en'

      await api.post('/api/v1/auth/forgot-password', {
        email: values.email,
        language: currentLanguage,
      })

      setSubmittedEmail(values.email)
      setEmailSent(true)
    } catch (error: any) {
      console.error('Forgot password error:', error)
      toast.error(error.response?.data?.detail || t('forgotPassword.sendFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (emailSent) {
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
                {t('forgotPassword.title')}
              </h1>
              <p className="text-muted-foreground text-base">
                {t('forgotPassword.emailSent')}
              </p>
            </CardHeader>

            <CardContent className="space-y-6">
              <Alert className="border-green-200 bg-green-50">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <AlertDescription className="ml-2 text-green-900">
                  <p className="font-medium mb-2">{t('forgotPassword.emailSent')}</p>
                  <p className="text-sm">
                    {t('forgotPassword.emailSentDesc', { email: submittedEmail })}
                  </p>
                  <p className="text-sm mt-3">
                    {t('forgotPassword.checkSpam')}
                  </p>
                </AlertDescription>
              </Alert>

              <Link to="/login">
                <Button className="w-full h-12 text-base font-medium">
                  {t('forgotPassword.backToLogin')}
                </Button>
              </Link>
            </CardContent>

            <CardFooter className="flex-col">
              <p className="text-xs text-muted-foreground text-center">
                {t('forgotPassword.copyright')}
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>
    )
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
              {t('forgotPassword.title')}
            </h1>
            <p className="text-muted-foreground text-base">
              {t('forgotPassword.subtitle')}
            </p>
          </CardHeader>

          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('forgotPassword.emailPlaceholder')}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                          <Input
                            type="email"
                            placeholder={t('forgotPassword.emailPlaceholder')}
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

                <Button
                  type="submit"
                  className="w-full h-12 text-base font-medium mt-6"
                  disabled={loading}
                >
                  {loading
                    ? t('forgotPassword.sending') || 'Sending...'
                    : t('forgotPassword.sendResetLink')}
                </Button>
              </form>
            </Form>
          </CardContent>

          <CardFooter className="flex-col space-y-4">
            <div className="text-center text-sm text-muted-foreground">
              <Link to="/login" className="text-primary hover:underline font-medium">
                {t('forgotPassword.backToLogin')}
              </Link>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {t('forgotPassword.copyright')}
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

export default ForgotPassword
