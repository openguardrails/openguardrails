import React, { useEffect, useState } from 'react';
import { Table, Card, Select, DatePicker, Space, Tag, Button, Drawer, Typography, Row, Col, Input, Spin, Image, message } from 'antd';
import { EyeOutlined, ReloadOutlined, SearchOutlined, FileImageOutlined, PictureOutlined, DownloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { resultsApi } from '../../services/api';
import type { DetectionResult, PaginatedResponse } from '../../types';

const { RangePicker } = DatePicker;
const { Option } = Select;
const { Text, Paragraph } = Typography;

const Results: React.FC = () => {
  const { t } = useTranslation();
  const [data, setData] = useState<PaginatedResponse<DetectionResult> | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedResult, setSelectedResult] = useState<DetectionResult | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filters, setFilters] = useState({
    risk_level: undefined as string | undefined,
    result_type: undefined as string | undefined,
    category: undefined as string | undefined,
    date_range: null as [dayjs.Dayjs, dayjs.Dayjs] | null,
    content_search: undefined as string | undefined,
    request_id_search: undefined as string | undefined,
  });
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
  });

  useEffect(() => {
    fetchResults();
  }, [pagination.current, pagination.pageSize, filters]);

  const fetchResults = async () => {
    try {
      setLoading(true);
      const params: any = {
        page: pagination.current,
        per_page: pagination.pageSize,
      };

      if (filters.risk_level) {
        params.risk_level = filters.risk_level;
      }
      if (filters.result_type) {
        params.result_type = filters.result_type;
      }
      if (filters.category) {
        params.category = filters.category;
      }
      if (filters.date_range) {
        params.start_date = filters.date_range[0].format('YYYY-MM-DD');
        params.end_date = filters.date_range[1].format('YYYY-MM-DD');
      }
      if (filters.content_search) {
        params.content_search = filters.content_search;
      }
      if (filters.request_id_search) {
        params.request_id_search = filters.request_id_search;
      }

      const result = await resultsApi.getResults(params);
      setData(result);
    } catch (error) {
      console.error('Error fetching results:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (paginationParams: any) => {
    setPagination({
      current: paginationParams.current,
      pageSize: paginationParams.pageSize,
    });
  };

  const handleFilterChange = (key: string, value: any) => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
    }));
    setPagination(prev => ({ ...prev, current: 1 })); // Reset page number
  };

  const handleExport = async () => {
    try {
      message.loading({ content: t('results.exporting'), key: 'export' });

      const params: any = {};

      if (filters.risk_level) {
        params.risk_level = filters.risk_level;
      }
      if (filters.category) {
        params.category = filters.category;
      }
      if (filters.date_range) {
        params.start_date = filters.date_range[0].format('YYYY-MM-DD');
        params.end_date = filters.date_range[1].format('YYYY-MM-DD');
      }
      if (filters.content_search) {
        params.content_search = filters.content_search;
      }
      if (filters.request_id_search) {
        params.request_id_search = filters.request_id_search;
      }

      const blob = await resultsApi.exportResults(params);

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `detection_results_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      message.success({ content: t('results.exportSuccess'), key: 'export' });
    } catch (error) {
      console.error('Export error:', error);
      message.error({ content: t('results.exportFailed'), key: 'export' });
    }
  };

  const showDetail = async (record: DetectionResult) => {
    setDetailLoading(true);
    setDrawerVisible(true);
    try {
      // Call detail API to get full content
      const fullRecord = await resultsApi.getResult(record.id);
      console.log('Full record from API:', fullRecord);
      console.log('has_image:', fullRecord.has_image);
      console.log('image_count:', fullRecord.image_count);
      console.log('image_paths:', fullRecord.image_paths);
      setSelectedResult(fullRecord);
    } catch (error) {
      console.error('Failed to fetch full record:', error);
      // If fetching detail fails, still display truncated content
      setSelectedResult(record);
    } finally {
      setDetailLoading(false);
    }
  };

  const getRiskLevelColor = (level: string) => {
    // 后端返回的是标准化的英文值，直接匹配
    switch (level) {
      case 'high_risk':
        return 'red';
      case 'medium_risk':
        return 'orange';
      case 'low_risk':
        return 'yellow';
      case 'no_risk':
      case 'safe':
        return 'green';
      default: 
        return 'default';
    }
  };

  // Helper function to format risk display
  const formatRiskDisplay = (riskLevel: string, categories: string[]) => {
    const noRisk = t('risk.level.no_risk');
    if (riskLevel === '无风险' || riskLevel === noRisk) {
      return noRisk;
    }
    if (categories && categories.length > 0) {
      return `${riskLevel} ${categories[0]}`;
    }
    return riskLevel;
  };

  // Helper function to format request ID display - show latter half with ellipsis
  const formatRequestId = (requestId: string) => {
    if (requestId.length <= 20) {
      return requestId;
    }
    // Show last 18 characters with ellipsis at the beginning
    return '...' + requestId.slice(-18);
  };

  // 定义所有风险类别
  const getAllCategories = () => {
    return [
      'sensitive_political_topic',
      'damage_to_national_image',
      'violent_crime',
      'prompt_attack',
      'general_political_topic',
      'harm_to_minors',
      'illegal_activities',
      'pornography',
      'discriminatory_content',
      'insults',
      'privacy_violation',
      'business_violations',
    ];
  };

  const columns = [
    {
      title: t('results.detectionContent'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: {
        showTitle: false,
      },
      width: 250,
      render: (text: string, record: DetectionResult) => (
        <span
          style={{ cursor: 'pointer', color: '#1890ff' }}
          onClick={() => showDetail(record)}
        >
          {record.has_image && (
            <Tag color="blue" icon={<FileImageOutlined />} style={{ marginRight: 8 }}>
              {t('results.imageCount', { count: record.image_count })}
            </Tag>
          )}
          <span title={text}>{text}</span>
        </span>
      ),
    },
    {
      title: t('results.requestId'),
      dataIndex: 'request_id',
      key: 'request_id',
      width: 140,
      render: (text: string) => (
        <span
          title={text}
          style={{
            cursor: 'pointer',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'block',
            maxWidth: '130px'
          }}
        >
          {formatRequestId(text)}
        </span>
      ),
    },
    {
      title: t('results.promptAttack'),
      key: 'prompt_attack',
      width: 150,
      render: (_: any, record: DetectionResult) => {
        const riskLevel = record.security_risk_level || t('risk.level.no_risk');
        const categories = record.security_categories || [];
        const displayText = formatRiskDisplay(riskLevel, categories);

        return (
          <Tag
            color={getRiskLevelColor(riskLevel)}
            style={{ fontSize: '12px' }}
            title={categories.join(', ')}
          >
            {displayText}
          </Tag>
        );
      },
    },
    {
      title: t('results.contentCompliance'),
      key: 'content_compliance',
      width: 150,
      render: (_: any, record: DetectionResult) => {
        const riskLevel = record.compliance_risk_level || t('risk.level.no_risk');
        const categories = record.compliance_categories || [];
        const displayText = formatRiskDisplay(riskLevel, categories);

        return (
          <Tag
            color={getRiskLevelColor(riskLevel)}
            style={{ fontSize: '12px' }}
            title={categories.join(', ')}
          >
            {displayText}
          </Tag>
        );
      },
    },
    {
      title: t('results.dataLeak'),
      key: 'data_leak',
      width: 150,
      render: (_: any, record: DetectionResult) => {
        const riskLevel = record.data_risk_level || t('risk.level.no_risk');
        const categories = record.data_categories || [];
        const displayText = formatRiskDisplay(riskLevel, categories);

        return (
          <Tag
            color={getRiskLevelColor(riskLevel)}
            style={{ fontSize: '12px' }}
            title={categories.join(', ')}
          >
            {displayText}
          </Tag>
        );
      },
    },
    {
      title: t('results.suggestedAction'),
      dataIndex: 'suggest_action',
      key: 'suggest_action',
      width: 90,
      render: (action: string) => {
        const pass = t('action.pass');
        const reject = t('action.reject');
        const replace = t('action.replace');
        let color = 'default';
        if (action === pass) {
          color = 'green';
        } else if (action === reject) {
          color = 'red';
        } else if (action === replace) {
          color = 'orange';
        }
        return <Tag color={color} style={{ fontSize: '12px' }}>{action}</Tag>;
      },
    },
    {
      title: t('results.detectionTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 120,
      render: (time: string) => (
        <span style={{ fontSize: '12px' }} title={dayjs(time).format('YYYY-MM-DD HH:mm:ss')}>
          {dayjs(time).format('MM-DD HH:mm')}
        </span>
      ),
    },
    {
      title: t('results.action'),
      key: 'action',
      width: 70,
      fixed: 'right' as const,
      render: (_: any, record: DetectionResult) => (
        <Button
          type="link"
          icon={<EyeOutlined />}
          size="small"
          onClick={() => showDetail(record)}
        >
          {t('results.details')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>{t('results.title')}</h2>

      <Card style={{ marginBottom: 24 }}>
        <Space wrap>

          <Select
            placeholder={t('results.selectRiskLevel')}
            allowClear
            size="middle"
            style={{ width: 120 }}
            value={filters.risk_level}
            onChange={(value) => handleFilterChange('risk_level', value)}
          >
            <Option value="high_risk">{t('risk.level.high_risk')}</Option>
            <Option value="medium_risk">{t('risk.level.medium_risk')}</Option>
            <Option value="low_risk">{t('risk.level.low_risk')}</Option>
            <Option value="no_risk">{t('risk.level.no_risk')}</Option>
          </Select>


          <Select
            placeholder={t('results.selectCategory')}
            allowClear
            size="middle"
            style={{ width: 150 }}
            value={filters.category}
            onChange={(value) => handleFilterChange('category', value)}
          >
            {getAllCategories().map(category => (
              <Option key={category} value={category}>{category}</Option>
            ))}
          </Select>

          <Input
            placeholder={t('results.contentSearch')}
            allowClear
            size="middle"
            style={{ width: 200, height: 32 }}
            prefix={<SearchOutlined />}
            value={filters.content_search}
            onChange={(e) => handleFilterChange('content_search', e.target.value || undefined)}
          />

          <Input
            placeholder={t('results.requestIdSearch')}
            allowClear
            size="middle"
            style={{ width: 200, height: 32 }}
            prefix={<SearchOutlined />}
            value={filters.request_id_search}
            onChange={(e) => handleFilterChange('request_id_search', e.target.value || undefined)}
          />

          <RangePicker
            placeholder={[t('results.startDate'), t('results.endDate')]}
            value={filters.date_range}
            onChange={(dates) => handleFilterChange('date_range', dates)}
          />

          <Button
            icon={<ReloadOutlined />}
            onClick={fetchResults}
          >
            {t('results.refresh')}
          </Button>

          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={handleExport}
          >
            {t('results.export')}
          </Button>
        </Space>
      </Card>

      <Card>
        <Table
          columns={columns}
          dataSource={data?.items || []}
          rowKey="id"
          loading={loading}
          size="small"
          tableLayout="fixed"
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: data?.total || 0,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => t('results.paginationText', { from: range[0], to: range[1], total }),
            size: 'small',
          }}
          onChange={handleTableChange}
        />
      </Card>

      <Drawer
        title={t('results.detectionDetails')}
        width={720}
        onClose={() => {
          setDrawerVisible(false);
          setSelectedResult(null);
        }}
        open={drawerVisible}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: '50px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16 }}>{t('results.loadingDetails')}</div>
          </div>
        ) : selectedResult && (
          <div>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Text strong>{t('results.requestId')}:</Text>
              </Col>
              <Col span={16}>
                <Text code>{selectedResult.request_id}</Text>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Text strong>{t('results.promptAttack')}:</Text>
              </Col>
              <Col span={16}>
                <Tag color={getRiskLevelColor(selectedResult.security_risk_level || t('risk.level.no_risk'))}>
                  {formatRiskDisplay(selectedResult.security_risk_level || t('risk.level.no_risk'), selectedResult.security_categories || [])}
                </Tag>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Text strong>{t('results.contentCompliance')}:</Text>
              </Col>
              <Col span={16}>
                <Tag color={getRiskLevelColor(selectedResult.compliance_risk_level || t('risk.level.no_risk'))}>
                  {formatRiskDisplay(selectedResult.compliance_risk_level || t('risk.level.no_risk'), selectedResult.compliance_categories || [])}
                </Tag>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Text strong>{t('results.dataLeak')}:</Text>
              </Col>
              <Col span={16}>
                <Tag color={getRiskLevelColor(selectedResult.data_risk_level || t('risk.level.no_risk'))}>
                  {formatRiskDisplay(selectedResult.data_risk_level || t('risk.level.no_risk'), selectedResult.data_categories || [])}
                </Tag>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Text strong>{t('results.suggestedAction')}:</Text>
              </Col>
              <Col span={16}>
                <Tag color={selectedResult.suggest_action === t('action.pass') ? 'green' : selectedResult.suggest_action === t('action.reject') ? 'red' : 'orange'}>
                  {selectedResult.suggest_action}
                </Tag>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Text strong>{t('results.detectionTime')}:</Text>
              </Col>
              <Col span={16}>
                <Text>{dayjs(selectedResult.created_at).format('YYYY-MM-DD HH:mm:ss')}</Text>
              </Col>
            </Row>

            <div style={{ marginBottom: 16 }}>
              <Text strong>{t('results.detectionContent')}:</Text>
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: '#f5f5f5',
                  borderRadius: 4,
                }}
              >
                {/* Display text content */}
                {selectedResult.content && (
                  <Paragraph style={{ marginBottom: selectedResult.has_image ? 12 : 0 }}>
                    {selectedResult.content}
                  </Paragraph>
                )}

                {/* If there are images, display thumbnails in content */}
                {selectedResult.has_image && selectedResult.image_urls && selectedResult.image_urls.length > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <Text strong style={{ display: 'block', marginBottom: 8 }}>
                      {t('results.imagesCount', { count: selectedResult.image_count })}:
                    </Text>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      {selectedResult.image_urls.map((imageUrl, index) => {
                        return (
                          <div
                            key={index}
                            style={{
                              border: '1px solid #d9d9d9',
                              borderRadius: 4,
                              padding: 4,
                              background: '#fafafa'
                            }}
                          >
                            <Image
                              src={imageUrl}
                              alt={`${t('results.image')} ${index + 1}`}
                              style={{
                                width: 150,
                                height: 150,
                                objectFit: 'cover',
                                borderRadius: 4
                              }}
                            />
                            <Text
                              type="secondary"
                              style={{
                                fontSize: 11,
                                display: 'block',
                                marginTop: 4,
                                textAlign: 'center'
                              }}
                            >
                              {t('results.image')} {index + 1}
                            </Text>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {t('results.contentLengthChars', { length: selectedResult.content.length })}
                {selectedResult.has_image && ` | ${t('results.includesImages', { count: selectedResult.image_count })}`}
              </Text>
            </div>

            {selectedResult.suggest_answer && (
              <div style={{ marginBottom: 16 }}>
                <Text strong>{t('results.suggestedAnswer')}:</Text>
                <Paragraph
                  style={{
                    marginTop: 8,
                    padding: 12,
                    background: '#f0f8ff',
                    borderRadius: 4,
                  }}
                >
                  {selectedResult.suggest_answer}
                </Paragraph>
              </div>
            )}

            {((selectedResult.security_categories && selectedResult.security_categories.length > 0) ||
              (selectedResult.compliance_categories && selectedResult.compliance_categories.length > 0) ||
              (selectedResult.data_categories && selectedResult.data_categories.length > 0)) && (
              <div style={{ marginBottom: 16 }}>
                <Text strong>{t('results.riskDetails')}:</Text>
                <div style={{ marginTop: 8 }}>
                  {selectedResult.security_categories && selectedResult.security_categories.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <Text strong style={{ fontSize: '12px' }}>{t('results.promptAttack')}: </Text>
                      {selectedResult.security_categories.map((category, index) => (
                        <Tag key={`security-${index}`} color="red" style={{ marginBottom: 4 }}>
                          {category}
                        </Tag>
                      ))}
                    </div>
                  )}
                  {selectedResult.compliance_categories && selectedResult.compliance_categories.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <Text strong style={{ fontSize: '12px' }}>{t('results.contentCompliance')}: </Text>
                      {selectedResult.compliance_categories.map((category, index) => (
                        <Tag key={`compliance-${index}`} color="orange" style={{ marginBottom: 4 }}>
                          {category}
                        </Tag>
                      ))}
                    </div>
                  )}
                  {selectedResult.data_categories && selectedResult.data_categories.length > 0 && (
                    <div>
                      <Text strong style={{ fontSize: '12px' }}>{t('results.dataLeak')}: </Text>
                      {selectedResult.data_categories.map((category, index) => (
                        <Tag key={`data-${index}`} color="magenta" style={{ marginBottom: 4 }}>
                          {category}
                        </Tag>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedResult.ip_address && (
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={8}>
                  <Text strong>{t('results.sourceIP')}:</Text>
                </Col>
                <Col span={16}>
                  <Text code>{selectedResult.ip_address}</Text>
                </Col>
              </Row>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default Results;