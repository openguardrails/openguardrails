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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/data-table/DataTable'
import { confirmDialog } from '@/utils/confirm-dialog'
import { configApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { Blacklist, Whitelist } from '../../types'
import { eventBus, EVENTS } from '../../utils/eventBus'
import type { ColumnDef } from '@tanstack/react-table'
import { format } from 'date-fns'

const keywordListSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  keywords: z.string().min(1, 'Keywords are required'),
  description: z.string().optional(),
  is_active: z.boolean().default(true),
})

type KeywordListFormData = z.infer<typeof keywordListSchema>

type ListType = 'blacklist' | 'whitelist'

const KeywordListManagement: React.FC = () => {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ListType>('whitelist')
  const [blacklistData, setBlacklistData] = useState<Blacklist[]>([])
  const [whitelistData, setWhitelistData] = useState<Whitelist[]>([])
  const [blacklistLoading, setBlacklistLoading] = useState(false)
  const [whitelistLoading, setWhitelistLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Blacklist | Whitelist | null>(null)
  const [modalType, setModalType] = useState<ListType>('blacklist')
  const { onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()

  const form = useForm<KeywordListFormData>({
    resolver: zodResolver(keywordListSchema),
    defaultValues: {
      name: '',
      keywords: '',
      description: '',
      is_active: true,
    },
  })

  useEffect(() => {
    if (currentApplicationId) {
      fetchBlacklistData()
      fetchWhitelistData()
    }
  }, [currentApplicationId])

  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      fetchBlacklistData()
      fetchWhitelistData()
    })
    return unsubscribe
  }, [onUserSwitch])

  const fetchBlacklistData = async () => {
    try {
      setBlacklistLoading(true)
      const result = await configApi.blacklist.list()
      setBlacklistData(result)
    } catch (error) {
      console.error('Error fetching blacklist:', error)
    } finally {
      setBlacklistLoading(false)
    }
  }

  const fetchWhitelistData = async () => {
    try {
      setWhitelistLoading(true)
      const result = await configApi.whitelist.list()
      setWhitelistData(result)
    } catch (error) {
      console.error('Error fetching whitelist:', error)
    } finally {
      setWhitelistLoading(false)
    }
  }

  const handleAdd = (type: ListType) => {
    setEditingItem(null)
    setModalType(type)
    form.reset({
      name: '',
      keywords: '',
      description: '',
      is_active: true,
    })
    setModalVisible(true)
  }

  const handleEdit = (record: Blacklist | Whitelist, type: ListType) => {
    setEditingItem(record)
    setModalType(type)
    form.reset({
      name: record.name,
      keywords: record.keywords.join('\n'),
      description: record.description || '',
      is_active: record.is_active,
    })
    setModalVisible(true)
  }

  const handleDelete = async (record: Blacklist | Whitelist, type: ListType) => {
    const confirmed = await confirmDialog({
      title: t(`${type}.confirmDelete`),
      description: t(`${type}.confirmDeleteContent`, { name: record.name }),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      variant: 'destructive',
    })

    if (confirmed) {
      try {
        if (type === 'blacklist') {
          await configApi.blacklist.delete(record.id)
          eventBus.emit(EVENTS.BLACKLIST_DELETED, {
            blacklistId: record.id,
            blacklistName: record.name,
          })
          fetchBlacklistData()
        } else {
          await configApi.whitelist.delete(record.id)
          eventBus.emit(EVENTS.WHITELIST_DELETED, {
            whitelistId: record.id,
            whitelistName: record.name,
          })
          fetchWhitelistData()
        }
        toast.success(t('common.deleteSuccess'))
      } catch (error) {
        console.error(`Error deleting ${type}:`, error)
        toast.error(t('common.deleteFailed'))
      }
    }
  }

  const handleSubmit = async (values: KeywordListFormData) => {
    try {
      const submitData = {
        ...values,
        keywords: values.keywords
          .split('\n')
          .filter((k: string) => k.trim())
          .map((k) => k.trim()),
      }

      if (modalType === 'blacklist') {
        if (editingItem) {
          await configApi.blacklist.update(editingItem.id, submitData)
          toast.success(t('common.updateSuccess'))
        } else {
          await configApi.blacklist.create(submitData)
          toast.success(t('common.createSuccess'))
          eventBus.emit(EVENTS.BLACKLIST_CREATED)
        }
        fetchBlacklistData()
      } else {
        if (editingItem) {
          await configApi.whitelist.update(editingItem.id, submitData)
          toast.success(t('common.updateSuccess'))
        } else {
          await configApi.whitelist.create(submitData)
          toast.success(t('common.createSuccess'))
          eventBus.emit(EVENTS.WHITELIST_CREATED)
        }
        fetchWhitelistData()
      }

      setModalVisible(false)
    } catch (error) {
      console.error(`Error saving ${modalType}:`, error)
      toast.error(t('common.saveFailed'))
    }
  }

  const handleToggleStatus = async (record: Blacklist | Whitelist, type: ListType) => {
    try {
      const updateData = {
        name: record.name,
        keywords: record.keywords,
        description: record.description,
        is_active: !record.is_active,
      }

      if (type === 'blacklist') {
        await configApi.blacklist.update(record.id, updateData)
        fetchBlacklistData()
      } else {
        await configApi.whitelist.update(record.id, updateData)
        fetchWhitelistData()
      }
      toast.success(
        t(!record.is_active ? 'common.enableSuccess' : 'common.disableSuccess')
      )
    } catch (error) {
      console.error(`Error toggling ${type} status:`, error)
      toast.error(t('common.operationFailed'))
    }
  }

  const createColumns = (type: ListType): ColumnDef<Blacklist | Whitelist>[] => [
    {
      accessorKey: 'name',
      header: t(`${type}.name`),
    },
    {
      accessorKey: 'keywords',
      header: t(`${type}.keywordCount`),
      cell: ({ row }) => {
        const keywords = row.getValue('keywords') as string[]
        return keywords?.length || 0
      },
    },
    {
      accessorKey: 'description',
      header: t(`${type}.description`),
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
              onClick={() => handleToggleStatus(record, type)}
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
              onClick={() => handleEdit(record, type)}
              className="h-auto p-0"
            >
              <Edit className="mr-1 h-4 w-4" />
              {t('common.edit')}
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => handleDelete(record, type)}
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

  const blacklistColumns = createColumns('blacklist')
  const whitelistColumns = createColumns('whitelist')

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold tracking-tight">{t('keywordList.title')}</h2>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ListType)}>
        <div className="flex justify-between items-center mb-4">
          <TabsList>
            <TabsTrigger value="whitelist">{t('keywordList.whitelistTab')}</TabsTrigger>
            <TabsTrigger value="blacklist">{t('keywordList.blacklistTab')}</TabsTrigger>
          </TabsList>
          <Button onClick={() => handleAdd(activeTab)}>
            <Plus className="mr-2 h-4 w-4" />
            {activeTab === 'blacklist' ? t('blacklist.addBlacklist') : t('whitelist.addWhitelist')}
          </Button>
        </div>

        <TabsContent value="whitelist">
          <Card>
            <CardContent className="p-0">
              <DataTable
                columns={whitelistColumns}
                data={whitelistData}
                loading={whitelistLoading}
                pagination={false}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="blacklist">
          <Card>
            <CardContent className="p-0">
              <DataTable
                columns={blacklistColumns}
                data={blacklistData}
                loading={blacklistLoading}
                pagination={false}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={modalVisible} onOpenChange={setModalVisible}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {editingItem
                ? t(`${modalType}.edit${modalType === 'blacklist' ? 'Blacklist' : 'Whitelist'}`)
                : t(`${modalType}.add${modalType === 'blacklist' ? 'Blacklist' : 'Whitelist'}`)}
            </DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(`${modalType}.name`)}</FormLabel>
                    <FormControl>
                      <Input placeholder={t(`${modalType}.namePlaceholder`)} {...field} />
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
                    <FormLabel>{t(`${modalType}.keywords`)}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={6}
                        placeholder={t(`${modalType}.keywordsPlaceholder`)}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>{t(`${modalType}.keywordsExtra`)}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(`${modalType}.description`)}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={t(`${modalType}.descriptionPlaceholder`)}
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

export default KeywordListManagement
