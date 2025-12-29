import React, { useEffect, useState, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Shield,
  AlertTriangle,
  CheckCircle,
  TrendingUp,
  FileProtect,
  Lock,
  AlertCircle,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { dashboardApi } from '../../services/api'
import type { DashboardStats } from '../../types'
import { useApplication } from '../../contexts/ApplicationContext'

const Dashboard: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentApplicationId } = useApplication()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true)
      const data = await dashboardApi.getStats()
      setStats(data)
      setError(null)
    } catch (err) {
      setError(t('dashboard.errorFetchingStats'))
      console.error('Error fetching stats:', err)
    } finally {
      setLoading(false)
    }
  }, [t, currentApplicationId])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  const getRiskDistributionOption = () => {
    if (!stats) return {}

    return {
      title: {
        text: t('dashboard.riskDistribution'),
        left: 'center',
      },
      tooltip: {
        trigger: 'item',
        formatter: '{a} <br/>{b}: {c} ({d}%)',
      },
      legend: {
        orient: 'vertical',
        left: 'left',
      },
      series: [
        {
          name: t('dashboard.riskLevel'),
          type: 'pie',
          radius: '50%',
          data: [
            {
              value: stats.risk_distribution['high_risk'] || 0,
              name: t('dashboard.highRisk'),
              itemStyle: { color: '#ff4d4f' },
            },
            {
              value: stats.risk_distribution['medium_risk'] || 0,
              name: t('dashboard.mediumRisk'),
              itemStyle: { color: '#faad14' },
            },
            {
              value: stats.risk_distribution['low_risk'] || 0,
              name: t('dashboard.lowRisk'),
              itemStyle: { color: '#fadb14' },
            },
            {
              value: stats.risk_distribution['no_risk'] || 0,
              name: t('dashboard.noRisk'),
              itemStyle: { color: '#52c41a' },
            },
          ],
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)',
            },
          },
        },
      ],
    }
  }

  const getTrendOption = () => {
    if (!stats) return {}

    const dates = stats.daily_trends.map((item) => item.date)
    const totalData = stats.daily_trends.map((item) => item.total)
    const highRiskData = stats.daily_trends.map((item) => item.high_risk)
    const mediumRiskData = stats.daily_trends.map((item) => item.medium_risk)

    return {
      title: {
        text: t('dashboard.dailyTrends'),
        left: 'center',
      },
      tooltip: {
        trigger: 'axis',
      },
      legend: {
        data: [t('dashboard.totalDetections'), t('dashboard.highRisk'), t('dashboard.mediumRisk')],
        bottom: 0,
      },
      xAxis: {
        type: 'category',
        data: dates,
      },
      yAxis: {
        type: 'value',
      },
      series: [
        {
          name: t('dashboard.totalDetections'),
          type: 'line',
          data: totalData,
          itemStyle: { color: '#1890ff' },
        },
        {
          name: t('dashboard.highRisk'),
          type: 'line',
          data: highRiskData,
          itemStyle: { color: '#ff4d4f' },
        },
        {
          name: t('dashboard.mediumRisk'),
          type: 'line',
          data: mediumRiskData,
          itemStyle: { color: '#faad14' },
        },
      ],
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-5 w-5" />
        <AlertDescription className="ml-2 flex items-center justify-between">
          <div>
            <p className="font-medium">{t('dashboard.error')}</p>
            <p className="text-sm mt-1">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStats}>
            {t('dashboard.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (!stats) return null

  const handleSecurityRisksClick = () => {
    navigate('/results', { state: { security_risk_level: 'any_risk' } })
  }

  const handleComplianceRisksClick = () => {
    navigate('/results', { state: { compliance_risk_level: 'any_risk' } })
  }

  const handleDataLeaksClick = () => {
    navigate('/results', { state: { data_risk_level: 'any_risk' } })
  }

  const handleTotalRisksClick = () => {
    navigate('/results', { state: { risk_level: 'any_risk' } })
  }

  const handleRiskLevelClick = (riskLevel: string) => {
    navigate('/results', { state: { risk_level: [riskLevel] } })
  }

  const handleSafePassedClick = () => {
    navigate('/results', { state: { risk_level: ['no_risk'] } })
  }

  const handleTotalDetectionsClick = () => {
    navigate('/results')
  }

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold tracking-tight">{t('dashboard.title')}</h2>

      {/* Overall Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={handleTotalDetectionsClick}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.totalRequests')}
            </CardTitle>
            <FileProtect className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">{stats.total_requests}</div>
          </CardContent>
        </Card>

        <Card
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={handleSecurityRisksClick}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.securityRisks')}
            </CardTitle>
            <Shield className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-500">
              {stats.security_risks}
              <span className="text-sm font-normal text-gray-500 ml-2">
                {t('dashboard.times')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={handleComplianceRisksClick}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.complianceRisks')}
            </CardTitle>
            <Shield className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-purple-600">
              {stats.compliance_risks}
              <span className="text-sm font-normal text-gray-500 ml-2">
                {t('dashboard.times')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={handleDataLeaksClick}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.dataLeaks')}
            </CardTitle>
            <Lock className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-pink-600">
              {stats.data_leaks}
              <span className="text-sm font-normal text-gray-500 ml-2">
                {t('dashboard.times')}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Risk Type Distribution */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={handleTotalRisksClick}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.totalRisks')}
            </CardTitle>
            <AlertTriangle className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-600">
              {stats.high_risk_count + stats.medium_risk_count + stats.low_risk_count}
              <span className="text-sm font-normal text-gray-500 ml-2">
                {t('dashboard.times')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={handleSafePassedClick}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.safePassed')}
            </CardTitle>
            <CheckCircle className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">
              {stats.safe_count}
              <span className="text-sm font-normal text-gray-500 ml-2">
                {t('dashboard.times')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              {t('dashboard.blockRate')}
            </CardTitle>
            <TrendingUp className="h-5 w-5 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">
              {stats.total_requests > 0
                ? (
                    ((stats.high_risk_count + stats.medium_risk_count + stats.low_risk_count) /
                      stats.total_requests) *
                    100
                  ).toFixed(1)
                : 0}
              <span className="text-xl font-normal text-gray-500">%</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-6">
            <ReactECharts
              option={getRiskDistributionOption()}
              style={{ height: 400 }}
              onEvents={{
                click: (params: any) => {
                  const riskLevelMap: { [key: string]: string } = {
                    [t('dashboard.highRisk')]: 'high_risk',
                    [t('dashboard.mediumRisk')]: 'medium_risk',
                    [t('dashboard.lowRisk')]: 'low_risk',
                    [t('dashboard.noRisk')]: 'no_risk',
                  }
                  const riskLevel = riskLevelMap[params.name]
                  if (riskLevel) {
                    handleRiskLevelClick(riskLevel)
                  }
                },
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <ReactECharts option={getTrendOption()} style={{ height: 400 }} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default Dashboard
