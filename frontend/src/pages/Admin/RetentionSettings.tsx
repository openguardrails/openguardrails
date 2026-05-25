import React, { useEffect, useState } from 'react'
import { Database, RefreshCw, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { InputNumber } from '@/components/ui/input-number'
import { retentionApi, type RetentionConfig } from '../../services/api'

const RetentionSettings: React.FC = () => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [defaults, setDefaults] = useState<RetentionConfig | null>(null)

  const formSchema = z
    .object({
      payload_retention_days: z
        .number()
        .int()
        .min(0)
        .max(3650),
      metadata_retention_days: z
        .number()
        .int()
        .min(0)
        .max(36500),
    })
    .refine(
      (v) =>
        v.metadata_retention_days === 0 ||
        v.metadata_retention_days >= v.payload_retention_days,
      {
        message: t('retention.errors.metadataLessThanPayload'),
        path: ['metadata_retention_days'],
      },
    )

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { payload_retention_days: 30, metadata_retention_days: 0 },
  })

  const load = async () => {
    setLoading(true)
    try {
      const [current, defaultCfg] = await Promise.all([
        retentionApi.getConfig(),
        retentionApi.getDefaults(),
      ])
      form.reset(current)
      setDefaults(defaultCfg)
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || t('retention.errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setSaving(true)
    try {
      const updated = await retentionApi.updateConfig(values)
      form.reset(updated)
      toast.success(t('retention.saved'))
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || t('retention.errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const resetToDefaults = () => {
    if (defaults) form.reset(defaults)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            {t('retention.title')}
          </CardTitle>
          <CardDescription>{t('retention.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 max-w-2xl">
              <FormField
                control={form.control}
                name="payload_retention_days"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('retention.payloadRetention.label')}</FormLabel>
                    <FormControl>
                      <InputNumber
                        {...field}
                        min={0}
                        max={3650}
                        disabled={loading}
                        placeholder="30"
                      />
                    </FormControl>
                    <FormDescription>
                      {t('retention.payloadRetention.description')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="metadata_retention_days"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('retention.metadataRetention.label')}</FormLabel>
                    <FormControl>
                      <InputNumber
                        {...field}
                        min={0}
                        max={36500}
                        disabled={loading}
                        placeholder="0"
                      />
                    </FormControl>
                    <FormDescription>
                      {t('retention.metadataRetention.description')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-2 pt-2">
                <Button type="submit" disabled={loading || saving}>
                  <Save className="h-4 w-4 mr-1" />
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetToDefaults}
                  disabled={loading || saving || !defaults}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  {t('retention.resetDefaults')}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

export default RetentionSettings
