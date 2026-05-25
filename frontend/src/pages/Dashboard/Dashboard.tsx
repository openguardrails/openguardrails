import React, { useEffect, useState, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Shield,
  AlertTriangle,
  CheckCircle,
  TrendingUp,
  FileCheck,
  Lock,
  AlertCircle,
} from 'lucide-react'

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
      backgroundColor: 'transparent',
      title: {
        text: t('dashboard.riskDistribution'),
        left: 'center',
        textStyle: { color: '#e2e8f0', fontSize: 14, fontWeight: 600 },
      },
      tooltip: {
        trigger: 'item',
        formatter: '{a} <br/>{b}: {c} ({d}%)',
        backgroundColor: 'rgba(20, 27, 39, 0.95)',
        borderColor: 'rgba(255,255,255,0.1)',
        textStyle: { color: '#e2e8f0' },
      },
      legend: {
        orient: 'vertical',
        left: 'left',
        textStyle: { color: '#94a3b8' },
      },
      series: [
        {
          name: t('dashboard.riskLevel'),
          type: 'pie',
          radius: ['35%', '55%'],
          data: [
            {
              value: stats.risk_distribution['high_risk'] || 0,
              name: t('dashboard.highRisk'),
              itemStyle: { color: '#ef4444' },
            },
            {
              value: stats.risk_distribution['medium_risk'] || 0,
              name: t('dashboard.mediumRisk'),
              itemStyle: { color: '#f59e0b' },
            },
            {
              value: stats.risk_distribution['low_risk'] || 0,
              name: t('dashboard.lowRisk'),
              itemStyle: { color: '#eab308' },
            },
            {
              value: stats.risk_distribution['no_risk'] || 0,
              name: t('dashboard.noRisk'),
              itemStyle: { color: '#10b981' },
            },
          ],
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)',
            },
          },
          label: {
            color: '#94a3b8',
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
      backgroundColor: 'transparent',
      title: {
        text: t('dashboard.dailyTrends'),
        left: 'center',
        textStyle: { color: '#e2e8f0', fontSize: 14, fontWeight: 600 },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(20, 27, 39, 0.95)',
        borderColor: 'rgba(255,255,255,0.1)',
        textStyle: { color: '#e2e8f0' },
      },
      legend: {
        data: [t('dashboard.totalDetections'), t('dashboard.highRisk'), t('dashboard.mediumRisk')],
        bottom: 0,
        textStyle: { color: '#94a3b8' },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '12%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
        axisLabel: { color: '#64748b' },
      },
      yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
        axisLabel: { color: '#64748b' },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
      },
      series: [
        {
          name: t('dashboard.totalDetections'),
          type: 'line',
          data: totalData,
          smooth: true,
          itemStyle: { color: '#0ea5e9' },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(14,165,233,0.15)' }, { offset: 1, color: 'rgba(14,165,233,0)' }] } },
        },
        {
          name: t('dashboard.highRisk'),
          type: 'line',
          data: highRiskData,
          smooth: true,
          itemStyle: { color: '#ef4444' },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(239,68,68,0.1)' }, { offset: 1, color: 'rgba(239,68,68,0)' }] } },
        },
        {
          name: t('dashboard.mediumRisk'),
          type: 'line',
          data: mediumRiskData,
          smooth: true,
          itemStyle: { color: '#f59e0b' },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(245,158,11,0.1)' }, { offset: 1, color: 'rgba(245,158,11,0)' }] } },
        },
      ],
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"></div>
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive" className="bg-red-500/10 border-red-500/20">
        <AlertCircle className="h-5 w-5 text-red-400" />
        <AlertDescription className="ml-2 flex items-center justify-between">
          <div>
            <p className="font-medium text-red-400">{t('dashboard.error')}</p>
            <p className="text-sm mt-1 text-red-400/80">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStats} className="border-red-500/20 text-red-400 hover:bg-red-500/10">
            {t('dashboard.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (!stats) return null

  const handleSecurityRisksClick = () => navigate('/results', { state: { security_risk_level: 'any_risk' } })
  const handleComplianceRisksClick = () => navigate('/results', { state: { compliance_risk_level: 'any_risk' } })
  const handleDataLeaksClick = () => navigate('/results', { state: { data_risk_level: 'any_risk' } })
  const handleTotalRisksClick = () => navigate('/results', { state: { risk_level: 'any_risk' } })
  const handleRiskLevelClick = (riskLevel: string) => navigate('/results', { state: { risk_level: [riskLevel] } })
  const handleSafePassedClick = () => navigate('/results', { state: { risk_level: ['no_risk'] } })
  const handleTotalDetectionsClick = () => navigate('/results')

  const statCards = [
    {
      label: t('dashboard.totalRequests'),
      value: stats.total_requests,
      icon: FileCheck,
      color: 'text-sky-400',
      iconColor: 'text-sky-400/60',
      onClick: handleTotalDetectionsClick,
    },
    {
      label: t('dashboard.securityRisks'),
      value: stats.security_risks,
      suffix: t('dashboard.times'),
      icon: Shield,
      color: 'text-orange-400',
      iconColor: 'text-orange-400/60',
      onClick: handleSecurityRisksClick,
    },
    {
      label: t('dashboard.complianceRisks'),
      value: stats.compliance_risks,
      suffix: t('dashboard.times'),
      icon: Shield,
      color: 'text-purple-400',
      iconColor: 'text-purple-400/60',
      onClick: handleComplianceRisksClick,
    },
    {
      label: t('dashboard.dataLeaks'),
      value: stats.data_leaks,
      suffix: t('dashboard.times'),
      icon: Lock,
      color: 'text-pink-400',
      iconColor: 'text-pink-400/60',
      onClick: handleDataLeaksClick,
    },
  ]

  const summaryCards = [
    {
      label: t('dashboard.totalRisks'),
      value: stats.high_risk_count + stats.medium_risk_count + stats.low_risk_count,
      suffix: t('dashboard.times'),
      icon: AlertTriangle,
      color: 'text-orange-400',
      iconColor: 'text-orange-400/60',
      onClick: handleTotalRisksClick,
    },
    {
      label: t('dashboard.safePassed'),
      value: stats.safe_count,
      suffix: t('dashboard.times'),
      icon: CheckCircle,
      color: 'text-emerald-400',
      iconColor: 'text-emerald-400/60',
      onClick: handleSafePassedClick,
    },
    {
      label: t('dashboard.blockRate'),
      value: stats.total_requests > 0
        ? ((stats.high_risk_count + stats.medium_risk_count + stats.low_risk_count) / stats.total_requests * 100).toFixed(1)
        : 0,
      suffix: '%',
      icon: TrendingUp,
      color: 'text-sky-400',
      iconColor: 'text-sky-400/60',
    },
  ]

  return (
    <div className="space-y-6">
      <h2 className="og-page-title">{t('dashboard.title')}</h2>

      {/* Overall Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="og-stat-card cursor-pointer"
            onClick={card.onClick}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-medium text-muted-foreground">{card.label}</span>
              <card.icon className={`h-5 w-5 ${card.iconColor}`} />
            </div>
            <div className={`text-3xl font-bold ${card.color}`}>
              {card.value}
              {card.suffix && (
                <span className="text-sm font-normal text-muted-foreground ml-2">{card.suffix}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Risk Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <div
            key={card.label}
            className={`og-stat-card ${card.onClick ? 'cursor-pointer' : ''}`}
            onClick={card.onClick}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-medium text-muted-foreground">{card.label}</span>
              <card.icon className={`h-5 w-5 ${card.iconColor}`} />
            </div>
            <div className={`text-3xl font-bold ${card.color}`}>
              {card.value}
              {card.suffix && (
                <span className={`${card.suffix === '%' ? 'text-xl' : 'text-sm'} font-normal text-muted-foreground ml-1`}>
                  {card.suffix}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-lg p-5">
          <ReactECharts
            option={getRiskDistributionOption()}
            style={{ height: 380 }}
            onEvents={{
              click: (params: any) => {
                const riskLevelMap: { [key: string]: string } = {
                  [t('dashboard.highRisk')]: 'high_risk',
                  [t('dashboard.mediumRisk')]: 'medium_risk',
                  [t('dashboard.lowRisk')]: 'low_risk',
                  [t('dashboard.noRisk')]: 'no_risk',
                }
                const riskLevel = riskLevelMap[params.name]
                if (riskLevel) handleRiskLevelClick(riskLevel)
              },
            }}
          />
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <ReactECharts option={getTrendOption()} style={{ height: 380 }} />
        </div>
      </div>
    </div>
  )
}

export default Dashboard
