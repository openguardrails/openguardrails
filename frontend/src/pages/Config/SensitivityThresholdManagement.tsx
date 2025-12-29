import React, { useState, useEffect } from 'react'
import { InfoCircleOutlined, Edit, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/data-table/DataTable'
import { InputNumber } from '@/components/ui/input-number'
import { sensitivityThresholdApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { useApplication } from '../../contexts/ApplicationContext'
import type { ColumnDef } from '@tanstack/react-table'

interface SensitivityThresholdConfig {
  high_sensitivity_threshold: number
  medium_sensitivity_threshold: number
  low_sensitivity_threshold: number
  sensitivity_trigger_level: string
}

interface SensitivityLevel {
  key: string
  name: string
  threshold: number
  description: string
  target: string
}

const SensitivityThresholdManagement: React.FC = () => {
  const { t } = useTranslation()
  const [config, setConfig] = useState<SensitivityThresholdConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [editingLevels, setEditingLevels] = useState<SensitivityLevel[]>([])
  const [saving, setSaving] = useState(false)
  const { onUserSwitch } = useAuth()
  const { currentApplicationId } = useApplication()

  useEffect(() => {
    if (currentApplicationId) {
      loadConfig()
    }
  }, [currentApplicationId])

  // Listen to user switch event, automatically refresh config
  useEffect(() => {
    const unsubscribe = onUserSwitch(() => {
      loadConfig()
    })
    return unsubscribe
  }, [onUserSwitch])

  const loadConfig = async () => {
    try {
      setLoading(true)
      const data = await sensitivityThresholdApi.get()
      setConfig(data)
    } catch (error) {
      toast.error(t('sensitivity.fetchFailed'))
      console.error('Failed to load sensitivity threshold config:', error)
    } finally {
      setLoading(false)
    }
  }

  // Get sensitivity level data
  const getSensitivityLevels = (): SensitivityLevel[] => {
    if (!config) return []

    return [
      {
        key: 'high',
        name: t('sensitivity.high'),
        threshold: config.high_sensitivity_threshold,
        description: t('sensitivity.strictestDetection'),
        target: t('sensitivity.highSensitivityTarget'),
      },
      {
        key: 'medium',
        name: t('sensitivity.medium'),
        threshold: config.medium_sensitivity_threshold,
        description: t('sensitivity.balancedDetection'),
        target: t('sensitivity.mediumSensitivityTarget'),
      },
      {
        key: 'low',
        name: t('sensitivity.low'),
        threshold: config.low_sensitivity_threshold,
        description: t('sensitivity.loosestDetection'),
        target: t('sensitivity.lowSensitivityTarget'),
      },
    ]
  }

  // Open edit modal
  const handleEdit = () => {
    const levels = getSensitivityLevels()
    setEditingLevels(levels)
    setEditModalVisible(true)
  }

  // Validate threshold settings
  const validateThresholds = (levels: SensitivityLevel[]): boolean => {
    const sortedLevels = [...levels].sort((a, b) => b.threshold - a.threshold)
    // Threshold must be between 0 and 1
    if (sortedLevels[0].threshold < 0 || sortedLevels[0].threshold > 1) {
      toast.error(t('sensitivity.invalidThreshold'))
      return false
    }

    // Check if sorted from high to low
    if (
      sortedLevels[0].key !== 'low' ||
      sortedLevels[1].key !== 'medium' ||
      sortedLevels[2].key !== 'high'
    ) {
      toast.error(t('sensitivity.thresholdOrder'))
      return false
    }

    // Check if there is overlap
    for (let i = 0; i < sortedLevels.length - 1; i++) {
      if (sortedLevels[i].threshold <= sortedLevels[i + 1].threshold) {
        toast.error(t('sensitivity.thresholdOrder'))
        return false
      }
    }

    return true
  }

  // Save config
  const handleSave = async () => {
    if (!validateThresholds(editingLevels)) return

    try {
      setSaving(true)

      const newConfig: SensitivityThresholdConfig = {
        high_sensitivity_threshold: editingLevels.find((l) => l.key === 'high')!.threshold,
        medium_sensitivity_threshold: editingLevels.find((l) => l.key === 'medium')!.threshold,
        low_sensitivity_threshold: editingLevels.find((l) => l.key === 'low')!.threshold,
        sensitivity_trigger_level: config?.sensitivity_trigger_level || 'medium',
      }

      await sensitivityThresholdApi.update(newConfig)
      setConfig(newConfig)
      setEditModalVisible(false)
      toast.success(t('sensitivity.saveSuccess'))
    } catch (error) {
      toast.error(t('sensitivity.fetchFailed'))
      console.error('Failed to update sensitivity threshold config:', error)
    } finally {
      setSaving(false)
    }
  }

  // Handle current sensitivity level change
  const handleTriggerLevelChange = async (value: string) => {
    if (!config) return

    try {
      setSaving(true)
      const newConfig = { ...config, sensitivity_trigger_level: value }

      await sensitivityThresholdApi.update(newConfig)
      setConfig(newConfig)

      const levelNames = {
        low: t('sensitivity.low'),
        medium: t('sensitivity.medium'),
        high: t('sensitivity.high'),
      }
      toast.success(
        t('sensitivity.levelChangeSuccess', {
          level: levelNames[value as keyof typeof levelNames],
        })
      )
    } catch (error) {
      toast.error(t('sensitivity.fetchFailed'))
      console.error('Failed to update sensitivity trigger level:', error)
    } finally {
      setSaving(false)
    }
  }

  const getSensitivityColor = (name: string): 'destructive' | 'default' | 'outline' => {
    if (name === t('sensitivity.high')) return 'destructive'
    if (name === t('sensitivity.medium')) return 'default'
    return 'outline'
  }

  // Table column definition
  const columns: ColumnDef<SensitivityLevel>[] = [
    {
      accessorKey: 'name',
      header: t('sensitivity.levelName'),
      cell: ({ row }) => {
        const name = row.getValue('name') as string
        return <Badge variant={getSensitivityColor(name)}>{name}</Badge>
      },
    },
    {
      accessorKey: 'threshold',
      header: t('sensitivity.threshold'),
      cell: ({ row }) => {
        const value = row.getValue('threshold') as number
        return <code className="text-xs bg-gray-100 px-2 py-1 rounded">{value.toFixed(2)}</code>
      },
    },
    {
      accessorKey: 'description',
      header: t('common.description'),
    },
    {
      accessorKey: 'target',
      header: t('sensitivity.targetScenario'),
    },
  ]

  // Edit modal table column
  const editColumns: ColumnDef<SensitivityLevel>[] = [
    {
      accessorKey: 'name',
      header: t('sensitivity.sensitivityLevel'),
      cell: ({ row }) => {
        const name = row.getValue('name') as string
        return <Badge variant={getSensitivityColor(name)}>{name}</Badge>
      },
    },
    {
      accessorKey: 'threshold',
      header: t('sensitivity.probabilityThreshold'),
      cell: ({ row }) => {
        const value = row.getValue('threshold') as number
        const index = editingLevels.findIndex((l) => l.key === row.original.key)
        return (
          <InputNumber
            value={value}
            min={0}
            max={1}
            onChange={(newValue) => {
              if (newValue !== undefined) {
                const newLevels = [...editingLevels]
                newLevels[index] = { ...newLevels[index], threshold: newValue }
                setEditingLevels(newLevels)
              }
            }}
            className="w-full"
          />
        )
      },
    },
  ]

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        </div>
      </div>
    )
  }

  if (!config) {
    return <div>{t('sensitivity.fetchFailed')}</div>
  }

  const sensitivityLevels = getSensitivityLevels()

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <InfoCircleOutlined className="h-5 w-5" />
                {t('sensitivity.title')}
              </h3>
              <p className="text-gray-600 mt-2">{t('sensitivity.description')}</p>
            </div>

            {/* Current config table */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">{t('sensitivity.currentSensitivityLevel')}</CardTitle>
                <Button onClick={handleEdit} size="sm">
                  <Edit className="mr-2 h-4 w-4" />
                  {t('sensitivity.editThresholds')}
                </Button>
              </CardHeader>
              <CardContent>
                <DataTable columns={columns} data={sensitivityLevels} pagination={false} />
              </CardContent>
            </Card>

            {/* Current sensitivity level config */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('sensitivity.currentSensitivityLevel')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm font-medium text-blue-900 mb-2">
                    {t('sensitivity.configurationExplanation')}
                  </p>
                  <div className="space-y-1 text-xs text-blue-800">
                    <p>
                      •{' '}
                      {t('sensitivity.highSensitivityDesc', {
                        threshold: config.high_sensitivity_threshold,
                      })}
                    </p>
                    <p>
                      •{' '}
                      {t('sensitivity.mediumSensitivityDesc', {
                        threshold: config.medium_sensitivity_threshold,
                      })}
                    </p>
                    <p>
                      •{' '}
                      {t('sensitivity.lowSensitivityDesc', {
                        threshold: config.low_sensitivity_threshold,
                      })}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="font-medium">{t('sensitivity.currentLevel')}：</span>
                  <Select
                    value={config?.sensitivity_trigger_level}
                    onValueChange={handleTriggerLevelChange}
                    disabled={saving}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">
                        <div className="flex items-center gap-2">
                          <Badge variant="destructive">{t('sensitivity.high')}</Badge>
                          <span>{t('sensitivity.sensitivityLabel')}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="medium">
                        <div className="flex items-center gap-2">
                          <Badge variant="default">{t('sensitivity.medium')}</Badge>
                          <span>{t('sensitivity.sensitivityLabel')}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="low">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{t('sensitivity.low')}</Badge>
                          <span>{t('sensitivity.sensitivityLabel')}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="mt-2 p-2 bg-gray-50 rounded border border-dashed border-gray-300">
                  <p className="text-xs text-gray-600">
                    {config?.sensitivity_trigger_level === 'high' &&
                      t('sensitivity.currentDetectionRule', {
                        threshold: config.high_sensitivity_threshold,
                      })}
                    {config?.sensitivity_trigger_level === 'medium' &&
                      t('sensitivity.currentDetectionRule', {
                        threshold: config.medium_sensitivity_threshold,
                      })}
                    {config?.sensitivity_trigger_level === 'low' &&
                      t('sensitivity.currentDetectionRule', {
                        threshold: config.low_sensitivity_threshold,
                      })}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      {/* Edit modal */}
      <Dialog open={editModalVisible} onOpenChange={setEditModalVisible}>
        <DialogContent className="sm:max-w-[800px]">
          <DialogHeader>
            <DialogTitle>{t('sensitivity.editThresholds')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm font-medium text-yellow-900 mb-2">
                {t('sensitivity.editInstructions')}
              </p>
              <div className="space-y-1 text-xs text-yellow-800">
                <p>• {t('sensitivity.editDescription1')}</p>
                <p>• {t('sensitivity.editDescription2')}</p>
              </div>
            </div>

            <DataTable columns={editColumns} data={editingLevels} pagination={false} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalVisible(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              <Check className="mr-2 h-4 w-4" />
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default SensitivityThresholdManagement
