import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Spin, Alert } from 'antd';
import {
  SafetyOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  FileProtectOutlined,
  LockOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import { dashboardApi } from '../../services/api';
import type { DashboardStats } from '../../types';

const Dashboard: React.FC = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await dashboardApi.getStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(t('dashboard.errorFetchingStats'));
      console.error('Error fetching stats:', err);
    } finally {
      setLoading(false);
    }
  };

  const getRiskDistributionOption = () => {
    if (!stats) return {};

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
            { value: stats.risk_distribution['high_risk'] || 0, name: t('dashboard.highRisk'), itemStyle: { color: '#ff4d4f' } },
            { value: stats.risk_distribution['medium_risk'] || 0, name: t('dashboard.mediumRisk'), itemStyle: { color: '#faad14' } },
            { value: stats.risk_distribution['low_risk'] || 0, name: t('dashboard.lowRisk'), itemStyle: { color: '#fadb14' } },
            { value: stats.risk_distribution['no_risk'] || 0, name: t('dashboard.noRisk'), itemStyle: { color: '#52c41a' } },
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
    };
  };

  const getTrendOption = () => {
    if (!stats) return {};

    const dates = stats.daily_trends.map(item => item.date);
    const totalData = stats.daily_trends.map(item => item.total);
    const highRiskData = stats.daily_trends.map(item => item.high_risk);
    const mediumRiskData = stats.daily_trends.map(item => item.medium_risk);

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
        message={t('dashboard.error')}
        description={error}
        type="error"
        showIcon
        action={
          <button onClick={fetchStats} style={{ border: 'none', background: 'none', color: '#1890ff', cursor: 'pointer' }}>
            {t('dashboard.retry')}
          </button>
        }
      />
    );
  }

  if (!stats) return null;

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>{t('dashboard.title')}</h2>

      {/* Overall statistics */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('dashboard.totalRequests')}
              value={stats.total_requests}
              prefix={<FileProtectOutlined />}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('dashboard.securityRisks')}
              value={stats.security_risks}
              prefix={<SafetyOutlined />}
              valueStyle={{ color: '#fa8c16' }}
              suffix={t('dashboard.times')}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('dashboard.complianceRisks')}
              value={stats.compliance_risks}
              prefix={<SafetyOutlined />}
              valueStyle={{ color: '#722ed1' }}
              suffix={t('dashboard.times')}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('dashboard.dataLeaks')}
              value={stats.data_leaks}
              prefix={<LockOutlined />}
              valueStyle={{ color: '#eb2f96' }}
              suffix={t('dashboard.times')}
            />
          </Card>
        </Col>
      </Row>

      {/* Risk type distribution */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('dashboard.totalRisks')}
              value={stats.high_risk_count + stats.medium_risk_count + stats.low_risk_count}
              prefix={<ExclamationCircleOutlined />}
              valueStyle={{ color: '#ff7a45' }}
              suffix={t('dashboard.times')}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('dashboard.safePassed')}
              value={stats.safe_count}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a' }}
              suffix={t('dashboard.times')}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('dashboard.blockRate')}
              value={stats.total_requests > 0 ? ((stats.high_risk_count + stats.medium_risk_count + stats.low_risk_count) / stats.total_requests * 100).toFixed(1) : 0}
              prefix={<WarningOutlined />}
              valueStyle={{ color: '#1890ff' }}
              suffix="%"
            />
          </Card>
        </Col>
      </Row>


      {/* Charts */}
      <Row gutter={16}>
        <Col span={12}>
          <Card>
            <ReactECharts option={getRiskDistributionOption()} style={{ height: 400 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card>
            <ReactECharts option={getTrendOption()} style={{ height: 400 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;