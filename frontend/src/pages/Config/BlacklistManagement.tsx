import React, { useEffect, useState } from 'react'
import { Plus, Edit, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCanEdit } from '../../hooks/useCanEdit'
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
import { confirmDialog } from '@/utils/confirm-dialog'
import api, { configApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'

import type { Blacklist } from '../../types'
import { eventBus, EVENTS } from '../../utils/eventBus'
import type { ColumnDef } from '@tanstack/react-table'
import { format } from 'date-fns'

const blacklistSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  keywords: z.string().min(1, 'Keywords are required'),
  description: z.string().optional(),
  is_active: z.boolean().default(true),
})

type BlacklistFormData = z.infer<typeof blacklistSchema>

interface BlacklistManagementProps {
  workspaceId?: string
}

const BlacklistManagement: React.FC<BlacklistManagementProps> = ({ workspaceId }) => {
  const { t } = useTranslation()
  const canEdit = useCanEdit()
  const [data, setData] = useState<Blacklist[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Blacklist | null>(null)
  const { onUserSwitch } = useAuth()

  // Use workspace API when workspaceId is provided
  const blacklistApi = React.useMemo(() => {
    if (!workspaceId) return configApi.blacklist
    const prefix = `/api/v1/workspaces/${workspaceId}/config`
    return {
      list: (): Promise<Blacklist[]> => api.get(`${prefix}/blacklist`).then(res => res.data),
      create: (data: any) => api.post(`${prefix}/blacklist`, data).then(res => res.data),
      update: (id: number, data: any) => api.put(`${prefix}/blacklist/${id}`, data).then(res => res.data),
      delete: (id: number) => api.delete(`${prefix}/blacklist/${id}`).then(res => res.data),
    }
  }, [workspaceId])

  const form = useForm<BlacklistFormData>({
    resolver: zodResolver(blacklistSchema),
    defaultValues: {
      name: '',
      keywords: '',
      description: '',
      is_active: true,
    },
  })

  useEffect(() => {
    fetchData()
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      const unsubscribe = onUserSwitch(() => {
        fetchData()
      })
      return unsubscribe
    }
  }, [onUserSwitch, workspaceId])

  const fetchData = async () => {
    try {
      setLoading(true)
      const result = await blacklistApi.list()
      setData(result)
    } catch (error) {
      console.error('Error fetching blacklist:', error)
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

  const handleEdit = (record: Blacklist) => {
    setEditingItem(record)
    form.reset({
      name: record.name,
      keywords: record.keywords.join('\n'),
      description: record.description || '',
      is_active: record.is_active,
    })
    setModalVisible(true)
  }

  const handleDelete = async (record: Blacklist) => {
    const confirmed = await confirmDialog({
      title: t('blacklist.confirmDelete'),
      description: t('blacklist.confirmDeleteContent', { name: record.name }),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      variant: 'destructive',
    })

    if (confirmed) {
      try {
        await blacklistApi.delete(record.id)
        toast.success(t('common.deleteSuccess'))
        fetchData()
        eventBus.emit(EVENTS.BLACKLIST_DELETED, {
          blacklistId: record.id,
          blacklistName: record.name,
        })
      } catch (error) {
        console.error('Error deleting blacklist:', error)
        toast.error(t('common.deleteFailed'))
      }
    }
  }

  const handleSubmit = async (values: BlacklistFormData) => {
    try {
      const submitData = {
        ...values,
        keywords: values.keywords
          .split('\n')
          .filter((k: string) => k.trim())
          .map((k) => k.trim()),
      }

      if (editingItem) {
        await blacklistApi.update(editingItem.id, submitData)
        toast.success(t('common.updateSuccess'))
      } else {
        await blacklistApi.create(submitData)
        toast.success(t('common.createSuccess'))
        eventBus.emit(EVENTS.BLACKLIST_CREATED)
      }

      setModalVisible(false)
      fetchData()
    } catch (error) {
      console.error('Error saving blacklist:', error)
      toast.error(t('common.saveFailed'))
    }
  }

  const handleToggleStatus = async (record: Blacklist) => {
    try {
      await blacklistApi.update(record.id, {
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
      console.error('Error toggling blacklist status:', error)
      toast.error(t('common.operationFailed'))
    }
  }

  const columns: ColumnDef<Blacklist>[] = [
    {
      accessorKey: 'name',
      header: t('blacklist.name'),
    },
    {
      accessorKey: 'keywords',
      header: t('blacklist.keywordCount'),
      cell: ({ row }) => {
        const keywords = row.getValue('keywords') as string[]
        return keywords?.length || 0
      },
    },
    {
      accessorKey: 'description',
      header: t('blacklist.description'),
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
    ...(canEdit ? [{
      id: 'actions',
      header: t('common.action'),
      cell: ({ row }: { row: any }) => {
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
              className="h-auto p-0 text-red-400 hover:text-red-300"
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {t('common.delete')}
            </Button>
          </div>
        )
      },
    }] : []),
  ]

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        {!workspaceId && <h2 className="text-3xl font-bold tracking-tight">{t('blacklist.title')}</h2>}
        {workspaceId && <div />}
        {canEdit && (
          <Button onClick={handleAdd}>
            <Plus className="mr-2 h-4 w-4" />
            {t('blacklist.addBlacklist')}
          </Button>
        )}
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
              {editingItem ? t('blacklist.editBlacklist') : t('blacklist.addBlacklist')}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('blacklist.name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('blacklist.namePlaceholder')} {...field} />
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
                    <FormLabel>{t('blacklist.keywords')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={6}
                        placeholder={t('blacklist.keywordsPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>{t('blacklist.keywordsExtra')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('blacklist.description')}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={t('blacklist.descriptionPlaceholder')}
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

export default BlacklistManagement
