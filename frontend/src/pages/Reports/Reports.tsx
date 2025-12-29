import React, { useEffect, useState, useCallback } from 'react'
import { Shield, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactECharts from 'echarts-for-react'
import { format, subDays } from 'date-fns'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { dashboardApi } from '../../services/api'
import type { DashboardStats } from '../../types'
import { useApplication } from '../../contexts/ApplicationContext'
import type { DateRange } from 'react-day-picker'

const Reports: React.FC = () => {
  const { t } = useTranslation()
  const { currentApplicationId } = useApplication()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [categoryData, setCategoryData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  })

  const fetchReportData = useCallback(async () => {
    if (!dateRange.from || !dateRange.to) return

    try {
      setLoading(true)

      // get stats and category distribution data in parallel
      const [statsData, categoryDistributionData] = await Promise.all([
        dashboardApi.getStats(),
        dashboardApi.getCategoryDistribution({
          start_date: format(dateRange.from, 'yyyy-MM-dd'),
          end_date: format(dateRange.to, 'yyyy-MM-dd'),
        }),
      ])

      setStats(statsData)
      setCategoryData(categoryDistributionData.categories || [])
      setError(null)
    } catch (err) {
      const errorMsg = t('reports.errorFetchingReports')
      setError(errorMsg)
      toast.error(errorMsg)
      console.error('Error fetching report data:', err)
    } finally {
      setLoading(false)
    }
  }, [t, currentApplicationId, dateRange])

  useEffect(() => {
    fetchReportData()
  }, [fetchReportData])

  const getCategoryDistributionOption = () => {
    return {
      title: {
        text: t('reports.categoryDistribution'),
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
          name: t('reports.riskCategory'),
          type: 'pie',
          radius: '50%',
          data: categoryData,
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
    if (!stats || !stats.daily_trends || stats.daily_trends.length === 0) {
      return {
        title: {
          text: dateRange.from && dateRange.to
            ? t('reports.riskTrendPeriod', {
                from: format(dateRange.from, 'MM-dd'),
                to: format(dateRange.to, 'MM-dd'),
              })
            : '',
          left: 'center',
        },
        xAxis: { type: 'category', data: [] },
        yAxis: { type: 'value' },
        series: [{ name: t('reports.riskDetectionCount'), type: 'line', data: [] }],
      }
    }

    const dates = stats.daily_trends.map((item) => item.date)
    const riskData = stats.daily_trends.map(
      (item) => (item.high_risk || 0) + (item.medium_risk || 0) + (item.low_risk || 0)
    )

    return {
      title: {
        text: dateRange.from && dateRange.to
          ? t('reports.riskTrendPeriod', {
              from: format(dateRange.from, 'MM-dd'),
              to: format(dateRange.to, 'MM-dd'),
            })
          : '',
        left: 'center',
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const date = format(new Date(params[0].name), 'yyyy-MM-dd')
          return `${date}<br/>${t('reports.riskDetectionCount')}: ${params[0].value}`
        },
      },
      xAxis: {
        type: 'category',
        data: dates.map((date) => format(new Date(date), 'MM/dd')),
      },
      yAxis: {
        type: 'value',
      },
      series: [
        {
          name: t('reports.riskDetectionCount'),
          type: 'line',
          data: riskData,
          itemStyle: { color: '#ff4d4f' },
          smooth: true,
        },
      ],
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <h3 className="text-red-900 font-semibold">{t('reports.error')}</h3>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
          <Button variant="link" onClick={fetchReportData} className="text-blue-600">
            {t('reports.retry')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold tracking-tight">{t('reports.title')}</h2>
        <DateRangePicker
          value={dateRange}
          onChange={(range) => {
            if (range?.from && range?.to) {
              setDateRange(range)
            }
          }}
        />
      </div>

      {/* Risk statistics cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                {t('reports.securityRisksDetected')}
              </CardTitle>
              <Shield className="h-5 w-5 text-gray-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-orange-600">
                {stats.security_risks}
                <span className="text-sm font-normal text-gray-500 ml-2">{t('reports.times')}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                {t('reports.complianceRisksDetected')}
              </CardTitle>
              <Shield className="h-5 w-5 text-gray-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-purple-600">
                {stats.compliance_risks}
                <span className="text-sm font-normal text-gray-500 ml-2">{t('reports.times')}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                {t('reports.dataLeaksDetected')}
              </CardTitle>
              <Lock className="h-5 w-5 text-gray-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-pink-600">
                {stats.data_leaks}
                <span className="text-sm font-normal text-gray-500 ml-2">{t('reports.times')}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('reports.categoryDistribution')}</CardTitle>
          </CardHeader>
          <CardContent>
            {categoryData.length > 0 ? (
              <ReactECharts option={getCategoryDistributionOption()} style={{ height: 400 }} />
            ) : (
              <div className="h-[400px] flex items-center justify-center text-gray-400">
                {t('reports.noRiskCategoryData')}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('reports.riskTrend')}</CardTitle>
          </CardHeader>
          <CardContent>
            {stats ? (
              <ReactECharts option={getTrendOption()} style={{ height: 400 }} />
            ) : (
              <div className="h-[400px] flex items-center justify-center text-gray-400">
                {t('reports.noTrendData')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default Reports
