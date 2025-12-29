import React, { useEffect, useState } from 'react'
import { Plus, Edit, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/lib/confirm-dialog'
import { configApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { Whitelist } from '../../types'
import { eventBus, EVENTS } from '../../utils/eventBus'
import type { ColumnDef } from '@tanstack/react-table'
import { format } from 'date-fns'

const whitelistSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  keywords: z.string().min(1, 'Keywords are required'),
  description: z.string().optional(),
  is_active: z.boolean().default(true),
})

type WhitelistFormData = z.infer<typeof whitelistSchema>

const WhitelistManagement: React.FC = () => {
  const { t } = useTranslation()
  const [data, setData] = useState<Whitelist[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Whitelist | null>(null)
  const { onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()

  const form = useForm<WhitelistFormData>({
    resolver: zodResolver(whitelistSchema),
    defaultValues: {
      name: '',
      keywords: '',
      description: '',
      is_active: true,
    },
  })

  useEffect(() => {
    if (currentApplicationId) {
      fetchData()
    }
  }, [currentApplicationId])

  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchData()
    })
    return unsubscribe
  }, [onUserSwitch])

  const fetchData = async () => {
    try {
      setLoading(true)
      const result = await configApi.whitelist.list()
      setData(result)
    } catch (error) {
      console.error('Error fetching whitelist:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = () => {
    setEditingItem(null)
    form.reset({
      name: '',
      keywords: '',
      description: '',
      is_active: true,
    })
    setModalVisible(true)
  }

  const handleEdit = (record: Whitelist) => {
    setEditingItem(record)
    form.reset({
      name: record.name,
      keywords: record.keywords.join('\n'),
      description: record.description || '',
      is_active: record.is_active,
    })
    setModalVisible(true)
  }

  const handleDelete = (record: Whitelist) => {
    confirmDialog({
      title: t('whitelist.confirmDelete'),
      description: t('whitelist.confirmDeleteContent', { name: record.name }),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await configApi.whitelist.delete(record.id)
          toast.success(t('common.deleteSuccess'))
          fetchData()
          eventBus.emit(EVENTS.WHITELIST_DELETED, {
            whitelistId: record.id,
            whitelistName: record.name,
          })
        } catch (error) {
          console.error('Error deleting whitelist:', error)
          toast.error(t('common.deleteFailed'))
        }
      },
    })
  }

  const handleSubmit = async (values: WhitelistFormData) => {
    try {
      const submitData = {
        ...values,
        keywords: values.keywords
          .split('\n')
          .filter((k: string) => k.trim())
          .map((k) => k.trim()),
      }

      if (editingItem) {
        await configApi.whitelist.update(editingItem.id, submitData)
        toast.success(t('common.updateSuccess'))
      } else {
        await configApi.whitelist.create(submitData)
        toast.success(t('common.createSuccess'))
        eventBus.emit(EVENTS.WHITELIST_CREATED)
      }

      setModalVisible(false)
      fetchData()
    } catch (error) {
      console.error('Error saving whitelist:', error)
      toast.error(t('common.saveFailed'))
    }
  }

  const handleToggleStatus = async (record: Whitelist) => {
    try {
      await configApi.whitelist.update(record.id, {
        name: record.name,
        keywords: record.keywords,
        description: record.description,
        is_active: !record.is_active,
      })
      toast.success(
        t(!record.is_active ? 'common.enableSuccess' : 'common.disableSuccess')
      )
      fetchData()
    } catch (error) {
      console.error('Error toggling whitelist status:', error)
      toast.error(t('common.operationFailed'))
    }
  }

  const columns: ColumnDef<Whitelist>[] = [
    {
      accessorKey: 'name',
      header: t('whitelist.name'),
    },
    {
      accessorKey: 'keywords',
      header: t('whitelist.keywordCount'),
      cell: ({ row }) => {
        const keywords = row.getValue('keywords') as string[]
        return keywords?.length || 0
      },
    },
    {
      accessorKey: 'description',
      header: t('whitelist.description'),
      cell: ({ row }) => {
        const desc = row.getValue('description') as string
        return (
          <span className="truncate max-w-[300px] block" title={desc}>
            {desc}
          </span>
        )
      },
    },
    {
      accessorKey: 'is_active',
      header: t('common.status'),
      cell: ({ row }) => {
        const record = row.original
        const active = row.getValue('is_active') as boolean
        return (
          <div className="flex items-center gap-2">
            <Badge variant={active ? 'outline' : 'secondary'}>
              {active ? t('common.enabled') : t('common.disabled')}
            </Badge>
            <Button
              variant="link"
              size="sm"
              onClick={() => handleToggleStatus(record)}
              className="h-auto p-0"
            >
              {active ? t('common.disable') : t('common.enable')}
            </Button>
          </div>
        )
      },
    },
    {
      accessorKey: 'created_at',
      header: t('common.createdAt'),
      cell: ({ row }) => {
        const time = row.getValue('created_at') as string
        return format(new Date(time), 'yyyy-MM-dd HH:mm:ss')
      },
    },
    {
      id: 'actions',
      header: t('common.action'),
      cell: ({ row }) => {
        const record = row.original
        return (
          <div className="flex items-center gap-2">
            <Button
              variant="link"
              size="sm"
              onClick={() => handleEdit(record)}
              className="h-auto p-0"
            >
              <Edit className="mr-1 h-4 w-4" />
              {t('common.edit')}
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => handleDelete(record)}
              className="h-auto p-0 text-red-600 hover:text-red-700"
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {t('common.delete')}
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold tracking-tight">{t('whitelist.title')}</h2>
        <Button onClick={handleAdd}>
          <Plus className="mr-2 h-4 w-4" />
          {t('whitelist.addWhitelist')}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            data={data}
            loading={loading}
            pagination={false}
          />
        </CardContent>
      </Card>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? t('whitelist.editWhitelist') : t('whitelist.addWhitelist')}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('whitelist.name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('whitelist.namePlaceholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="keywords"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('whitelist.keywords')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={6}
                        placeholder={t('whitelist.keywordsPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>{t('whitelist.keywordsExtra')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('whitelist.description')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={t('whitelist.descriptionPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">{t('common.enableStatus')}</FormLabel>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setModalVisible(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">{t('common.save')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default WhitelistManagement
