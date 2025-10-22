import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Spin, Alert, DatePicker, Statistic } from 'antd';
import { SafetyOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import dayjs from 'dayjs';
import { dashboardApi } from '../../services/api';
import type { DashboardStats } from '../../types';

const { RangePicker } = DatePicker;

const Reports: React.FC = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(30, 'day'),
    dayjs()
  ]);

  useEffect(() => {
    fetchReportData();
  }, [dateRange]);

  const fetchReportData = async () => {
    try {
      setLoading(true);
      
      // get stats and category distribution data in parallel
      const [statsData, categoryDistributionData] = await Promise.all([
        dashboardApi.getStats(),
        dashboardApi.getCategoryDistribution({
          start_date: dateRange[0].format('YYYY-MM-DD'),
          end_date: dateRange[1].format('YYYY-MM-DD')
        })
      ]);
      
      setStats(statsData);
      setCategoryData(categoryDistributionData.categories || []);
      setError(null);
    } catch (err) {
      setError(t('reports.errorFetchingReports'));
      console.error('Error fetching report data:', err);
    } finally {
      setLoading(false);
    }
  };

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
    };
  };

  const getTrendOption = () => {
    if (!stats || !stats.daily_trends || stats.daily_trends.length === 0) {
      return {
        title: {
          text: t('reports.riskTrendPeriod', {
            from: dateRange[0].format('MM-DD'),
            to: dateRange[1].format('MM-DD')
          }),
          left: 'center',
        },
        xAxis: { type: 'category', data: [] },
        yAxis: { type: 'value' },
        series: [{ name: t('reports.riskDetectionCount'), type: 'line', data: [] }]
      };
    }

    const dates = stats.daily_trends.map(item => item.date);
    const riskData = stats.daily_trends.map(item =>
      (item.high_risk || 0) + (item.medium_risk || 0) + (item.low_risk || 0)
    );

    return {
      title: {
        text: t('reports.riskTrendPeriod', {
          from: dateRange[0].format('MM-DD'),
          to: dateRange[1].format('MM-DD')
        }),
        left: 'center',
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const date = dayjs(params[0].name).format('YYYY-MM-DD');
          return `${date}<br/>${t('reports.riskDetectionCount')}: ${params[0].value}`;
        },
      },
      xAxis: {
        type: 'category',
        data: dates.map(date => dayjs(date).format('MM/DD')),
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
    };
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message={t('reports.error')}
        description={error}
        type="error"
        showIcon
        action={
          <button onClick={fetchReportData} style={{ border: 'none', background: 'none', color: '#1890ff', cursor: 'pointer' }}>
            {t('reports.retry')}
          </button>
        }
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2>{t('reports.title')}</h2>
        <RangePicker
          value={dateRange}
          onChange={(dates) => {
            if (dates) {
              setDateRange([dates[0]!, dates[1]!]);
            }
          }}
          format="YYYY-MM-DD"
          placeholder={[t('reports.startDate'), t('reports.endDate')]}
        />
      </div>

      {/* Risk statistics cards */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={8}>
            <Card>
              <Statistic
                title={t('reports.securityRisksDetected')}
                value={stats.security_risks}
                prefix={<SafetyOutlined />}
                valueStyle={{ color: '#fa8c16' }}
                suffix={t('reports.times')}
              />
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic
                title={t('reports.complianceRisksDetected')}
                value={stats.compliance_risks}
                prefix={<SafetyOutlined />}
                valueStyle={{ color: '#722ed1' }}
                suffix={t('reports.times')}
              />
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic
                title={t('reports.dataLeaksDetected')}
                value={stats.data_leaks}
                prefix={<LockOutlined />}
                valueStyle={{ color: '#eb2f96' }}
                suffix={t('reports.times')}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={16}>
        <Col span={12}>
          <Card title={t('reports.categoryDistribution')}>
            {categoryData.length > 0 ? (
              <ReactECharts option={getCategoryDistributionOption()} style={{ height: 400 }} />
            ) : (
              <div style={{ height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                {t('reports.noRiskCategoryData')}
              </div>
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title={t('reports.riskTrend')}>
            {stats ? (
              <ReactECharts option={getTrendOption()} style={{ height: 400 }} />
            ) : (
              <div style={{ height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                {t('reports.noTrendData')}
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Reports;