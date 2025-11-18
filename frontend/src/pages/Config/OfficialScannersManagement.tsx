import React, { useState, useEffect } from 'react';
import { Card, Table, Switch, Button, message, Spin, Tabs, Tag, Space, Modal, Descriptions, Tooltip, Drawer } from 'antd';
import { InfoCircleOutlined, ReloadOutlined, ShoppingOutlined, EyeOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { scannerPackagesApi, scannerConfigsApi, purchasesApi } from '../../services/api';
import { useApplication } from '../../contexts/ApplicationContext';
import { useAuth } from '../../contexts/AuthContext';
import { eventBus, EVENTS } from '../../utils/eventBus';

interface ScannerConfig {
  id: string;
  tag: string;
  name: string;
  description?: string;
  scanner_type: string;
  package_name: string;
  package_id?: string;
  is_custom: boolean;
  is_enabled: boolean;
  risk_level: string;
  scan_prompt: boolean;
  scan_response: boolean;
  default_risk_level: string;
  default_scan_prompt: boolean;
  default_scan_response: boolean;
  has_risk_level_override: boolean;
  has_scan_prompt_override: boolean;
  has_scan_response_override: boolean;
}

interface Package {
  id: string;
  package_code: string;
  package_name: string;
  author: string;
  description?: string;
  version: string;
  scanner_count: number;
  package_type: string;
  created_at?: string;
  // Marketplace specific fields
  price?: number;
  price_display?: string;
  purchase_status?: string;
  purchased?: boolean;
  purchase_requested?: boolean;
}

const OfficialScannersManagement: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { currentApplicationId } = useApplication();

  // Dynamic price display function based on current language
  const formatPriceDisplay = (price: number | undefined, priceDisplay: string | undefined): string => {
    if (price === undefined || price === null) {
      return priceDisplay || t('scannerPackages.free');
    }

    // Format the price based on current language
    const currentLang = i18n.language;
    if (currentLang === 'zh') {
      // For Chinese: remove any existing formatting and apply Yuan symbol
      return `￥${price}元`;
    } else {
      // For English and others: use Dollar symbol
      return `$${price}`;
    }
  };
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scannerConfigs, setScannerConfigs] = useState<ScannerConfig[]>([]);
  const [builtinPackages, setBuiltinPackages] = useState<Package[]>([]);
  const [purchasedPackages, setPurchasedPackages] = useState<Package[]>([]);
  const [marketplacePackages, setMarketplacePackages] = useState<Package[]>([]);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);
  const [purchaseModalVisible, setPurchaseModalVisible] = useState(false);
  const [purchasePackage, setPurchasePackage] = useState<Package | null>(null);
  const [detailsDrawerVisible, setDetailsDrawerVisible] = useState(false);
  const [detailsPackage, setDetailsPackage] = useState<Package | null>(null);
  const [packageDetails, setPackageDetails] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  
  // Active tab key - support URL hash for direct navigation
  const [activeTabKey, setActiveTabKey] = useState<string>(() => {
    // Get initial tab from URL hash (e.g., #marketplace)
    const hash = window.location.hash.replace('#', '');
    return ['builtin', 'purchased', 'marketplace'].includes(hash) ? hash : 'builtin';
  });

  useEffect(() => {
    // Load packages regardless of application selection (built-in packages are global)
    loadPackagesOnly();

    // Load scanner configs only if application is selected
    if (currentApplicationId) {
      loadScannerConfigs();
    }
  }, [currentApplicationId]);

  const loadPackagesOnly = async () => {
    try {
      // Load built-in packages (no application needed)
      const allBuiltin = await scannerPackagesApi.getAll('builtin');
      setBuiltinPackages(allBuiltin);

      // Load marketplace packages to get purchase status information
      const marketplace = await scannerPackagesApi.getMarketplace();

      // Filter purchased packages (those with purchased=true)
      setPurchasedPackages(marketplace.filter((p: Package) => p.purchased));

      // Filter marketplace packages (available for purchase, not yet purchased)
      setMarketplacePackages(marketplace.filter((p: Package) => !p.purchased));
    } catch (error) {
      message.error(t('scannerPackages.loadFailed'));
      console.error('Failed to load packages:', error);
    }
  };

  const loadScannerConfigs = async () => {
    try {
      setLoading(true);
      // Load scanner configs (requires application)
      const configs = await scannerConfigsApi.getAll(true);
      setScannerConfigs(configs.filter((c: ScannerConfig) => !c.is_custom));
    } catch (error) {
      message.error(t('scannerPackages.loadFailed'));
      console.error('Failed to load scanner configs:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadData = () => {
    loadScannerConfigs();
  };

  const handleToggleScanner = async (scannerId: string, enabled: boolean) => {
    try {
      setSaving(true);
      await scannerConfigsApi.update(scannerId, { is_enabled: enabled });
      message.success(t('scannerPackages.configurationSaved'));
      // Update local state
      setScannerConfigs(prev => prev.map(s =>
        s.id === scannerId ? { ...s, is_enabled: enabled } : s
      ));
    } catch (error) {
      message.error(t('scannerPackages.updateFailed'));
      console.error('Failed to update scanner:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleScanPrompt = async (scannerId: string, enabled: boolean) => {
    try {
      setSaving(true);
      await scannerConfigsApi.update(scannerId, { scan_prompt: enabled });
      message.success(t('scannerPackages.configurationSaved'));
      // Update local state - once user modifies, has_override becomes true
      setScannerConfigs(prev => prev.map(s =>
        s.id === scannerId ? { ...s, scan_prompt: enabled, has_scan_prompt_override: true } : s
      ));
    } catch (error) {
      message.error(t('scannerPackages.updateFailed'));
      console.error('Failed to update scanner:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleScanResponse = async (scannerId: string, enabled: boolean) => {
    try {
      setSaving(true);
      await scannerConfigsApi.update(scannerId, { scan_response: enabled });
      message.success(t('scannerPackages.configurationSaved'));
      // Update local state - once user modifies, has_override becomes true
      setScannerConfigs(prev => prev.map(s =>
        s.id === scannerId ? { ...s, scan_response: enabled, has_scan_response_override: true } : s
      ));
    } catch (error) {
      message.error(t('scannerPackages.updateFailed'));
      console.error('Failed to update scanner:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async (scannerId: string) => {
    try {
      setSaving(true);
      await scannerConfigsApi.reset(scannerId);
      message.success(t('scannerPackages.resetSuccess'));
      await loadData();
    } catch (error) {
      message.error(t('scannerPackages.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = () => {
    Modal.confirm({
      title: t('scannerPackages.resetAllToDefault'),
      content: t('scannerPackages.confirmResetAll'),
      onOk: async () => {
        try {
          setSaving(true);
          await scannerConfigsApi.resetAll();
          message.success(t('scannerPackages.resetAllSuccess'));
          await loadData();
        } catch (error) {
          message.error(t('scannerPackages.updateFailed'));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const handleRequestPurchase = (pkg: Package) => {
    setPurchasePackage(pkg);
    setPurchaseModalVisible(true);
  };

  const handleClosePurchaseModal = () => {
    setPurchaseModalVisible(false);
    setPurchasePackage(null);
  };

  const handleSubmitPurchase = async () => {
    try {
      if (!purchasePackage) return;

      await purchasesApi.request(
        purchasePackage.id,
        user?.email || '',
        ''
      );

      message.success(t('scannerPackages.purchaseRequestSubmitted'));
      handleClosePurchaseModal();
      // Reload data to refresh marketplace packages
      await loadPackagesOnly();
      // Emit event to notify other components
      eventBus.emit(EVENTS.MARKETPLACE_SCANNER_PURCHASED, { packageId: purchasePackage.id, packageName: purchasePackage.package_name });
    } catch (error: any) {
      console.error('Failed to submit purchase request:', error);
      message.error(error.response?.data?.detail || t('scannerPackages.purchaseRequestFailed'));
    }
  };

  const handleViewDetails = async (pkg: Package) => {
    setDetailsPackage(pkg);
    setDetailsDrawerVisible(true);
    setLoadingDetails(true);
    try {
      // Use marketplace detail endpoint for previewing packages (including unpurchased ones)
      // This endpoint hides sensitive scanner definitions for unpurchased packages
      const details = await scannerPackagesApi.getMarketplaceDetail(pkg.id);
      setPackageDetails(details);
    } catch (error) {
      message.error(t('scannerPackages.loadDetailsFailed'));
      console.error('Failed to load package details:', error);
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleCloseDetailsDrawer = () => {
    setDetailsDrawerVisible(false);
    setDetailsPackage(null);
    setPackageDetails(null);
  };

  const getRiskLevelColor = (level: string) => {
    const colors: { [key: string]: string } = {
      'high_risk': 'red',
      'medium_risk': 'orange',
      'low_risk': 'green',
    };
    return colors[level] || 'default';
  };

  const getScannerTypeLabel = (type: string) => {
    const types: { [key: string]: string } = {
      'genai': t('scannerPackages.scannerTypeGenai'),
      'regex': t('scannerPackages.scannerTypeRegex'),
      'keyword': t('scannerPackages.scannerTypeKeyword'),
    };
    return types[type] || type;
  };

  const getEnabledCount = (packageId: string) => {
    const packageScanners = scannerConfigs.filter(s => s.package_id === packageId);
    const enabledCount = packageScanners.filter(s => s.is_enabled).length;
    const totalCount = packageScanners.length;
    return `${enabledCount}/${totalCount}`;
  };

  // Columns for built-in and purchased packages (with configuration)
  const packageColumns = [
    {
      title: t('scannerPackages.packageName'),
      dataIndex: 'package_name',
      key: 'package_name',
      width: 250,
    },
    {
      title: t('scannerPackages.description'),
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: t('scannerPackages.author'),
      dataIndex: 'author',
      key: 'author',
      width: 150,
    },
    {
      title: t('scannerPackages.version'),
      dataIndex: 'version',
      key: 'version',
      width: 100,
    },
    {
      title: t('scannerPackages.enabled'),
      dataIndex: 'scanner_count',
      key: 'enabled',
      width: 120,
      render: (_: any, record: Package) => getEnabledCount(record.id),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 150,
      render: (_: any, record: Package) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => handleOpenDrawer(record)}
          disabled={!currentApplicationId}
        >
          {t('scannerPackages.viewScanners')}
        </Button>
      ),
    },
  ];

  // Columns for marketplace packages (no configuration, show purchase info)
  const marketplaceColumns = [
    {
      title: t('scannerPackages.packageName'),
      dataIndex: 'package_name',
      key: 'package_name',
      width: 250,
    },
    {
      title: t('scannerPackages.description'),
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: t('scannerPackages.author'),
      dataIndex: 'author',
      key: 'author',
      width: 150,
    },
    {
      title: t('scannerPackages.version'),
      dataIndex: 'version',
      key: 'version',
      width: 100,
    },
    {
      title: t('scannerPackages.scannerCount'),
      dataIndex: 'scanner_count',
      key: 'scanner_count',
      width: 120,
    },
    {
      title: t('scannerPackages.priceDisplay'),
      dataIndex: 'price',
      key: 'price_display',
      width: 120,
      render: (_: any, record: Package) => {
        // Use dynamic price formatting based on current language
        return formatPriceDisplay(record.price, record.price_display);
      },
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 200,
      render: (_: any, record: Package) => (
        <Space>
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewDetails(record)}
          >
            {t('scannerPackages.viewDetails')}
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<ShoppingOutlined />}
            onClick={() => handleRequestPurchase(record)}
          >
            {t('scannerPackages.requestPurchase')}
          </Button>
        </Space>
      ),
    },
  ];

  const getPackageScanners = (packageId: string) => {
    return scannerConfigs.filter(s => s.package_id === packageId);
  };

  const handleOpenDrawer = (pkg: Package) => {
    setSelectedPackage(pkg);
    setDrawerVisible(true);
  };

  const handleCloseDrawer = () => {
    setDrawerVisible(false);
    setSelectedPackage(null);
  };

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          title={t('scannerPackages.title')}
          extra={
            <Space>
              <Button
                icon={<ReloadOutlined />}
                onClick={loadData}
                loading={loading}
              >
                {t('common.refresh')}
              </Button>
              <Button
                danger
                onClick={handleResetAll}
                disabled={saving}
              >
                {t('scannerPackages.resetAllToDefault')}
              </Button>
            </Space>
          }
        >
          <Tabs
            activeKey={activeTabKey}
            onChange={(key) => {
              setActiveTabKey(key);
              // Update URL hash for shareable links
              window.location.hash = key;
            }}
            items={[
              {
                key: 'builtin',
                label: t('scannerPackages.builtinPackages'),
                children: (
                  <Table
                    columns={packageColumns}
                    dataSource={builtinPackages}
                    rowKey="id"
                    pagination={false}
                  />
                ),
              },
              {
                key: 'purchased',
                label: `${t('scannerPackages.purchasedPackages')} (${purchasedPackages.length})`,
                children: (
                  <Table
                    columns={packageColumns}
                    dataSource={purchasedPackages}
                    rowKey="id"
                    pagination={false}
                    locale={{ emptyText: t('scannerPackages.noPurchasedPackages') }}
                  />
                ),
              },
              {
                key: 'marketplace',
                label: `${t('scannerPackages.marketplace')} (${marketplacePackages.length})`,
                children: (
                  <Table
                    columns={marketplaceColumns}
                    dataSource={marketplacePackages}
                    rowKey="id"
                    pagination={false}
                    locale={{ emptyText: t('scannerPackages.noMarketplacePackages') }}
                  />
                ),
              },
            ]}
          />
        </Card>

        <Modal
          title={t('scannerPackages.submitPurchaseRequest')}
          open={purchaseModalVisible}
          onOk={handleSubmitPurchase}
          onCancel={handleClosePurchaseModal}
          okText={t('common.submit')}
          cancelText={t('common.cancel')}
          width={600}
          confirmLoading={saving}
        >
          {purchasePackage && (
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label={t('scannerPackages.packageName')}>
                  {purchasePackage.package_name}
                </Descriptions.Item>
                <Descriptions.Item label={t('scannerPackages.author')}>
                  {purchasePackage.author}
                </Descriptions.Item>
                <Descriptions.Item label={t('scannerPackages.version')}>
                  {purchasePackage.version}
                </Descriptions.Item>
                <Descriptions.Item label={t('scannerPackages.scannerCount')}>
                  {purchasePackage.scanner_count}
                </Descriptions.Item>
                <Descriptions.Item label={t('scannerPackages.priceDisplay')}>
                  {formatPriceDisplay(purchasePackage.price, purchasePackage.price_display)}
                </Descriptions.Item>
                {purchasePackage.description && (
                  <Descriptions.Item label={t('scannerPackages.description')}>
                    {purchasePackage.description}
                  </Descriptions.Item>
                )}
              </Descriptions>

              <div style={{
                padding: '16px',
                backgroundColor: '#f0f2f5',
                borderRadius: '4px',
                textAlign: 'center'
              }}>
                <p style={{ marginBottom: '8px', fontSize: '14px', color: '#595959' }}>
                  {t('scannerPackages.confirmPurchaseRequest')}
                </p>
              </div>

              <div style={{
                padding: '12px',
                backgroundColor: '#e6f7ff',
                borderRadius: '4px',
                border: '1px solid #91d5ff'
              }}>
                <p style={{ marginBottom: '0', fontSize: '13px', color: '#096dd9' }}>
                  <InfoCircleOutlined style={{ marginRight: '8px' }} />
                  {t('scannerPackages.purchaseRequestInfo')}
                </p>
              </div>
            </Space>
          )}
        </Modal>

        <Drawer
          title={selectedPackage ? `${selectedPackage.package_name} - ${t('scannerPackages.scannersList')}` : ''}
          placement="right"
          width={1000}
          onClose={handleCloseDrawer}
          open={drawerVisible}
        >
          {selectedPackage && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label={t('scannerPackages.description')}>
                  {selectedPackage.description || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('scannerPackages.author')}>
                  {selectedPackage.author}
                </Descriptions.Item>
                <Descriptions.Item label={t('scannerPackages.version')}>
                  {selectedPackage.version}
                </Descriptions.Item>
                                <Descriptions.Item label={t('scannerPackages.enabled')}>
                  {getEnabledCount(selectedPackage.id)}
                </Descriptions.Item>
              </Descriptions>

              <Table
                columns={[
                  {
                    title: t('scannerPackages.scannerTag'),
                    dataIndex: 'tag',
                    key: 'tag',
                    width: 80,
                    fixed: 'left',
                    render: (tag: string) => <Tag color="blue">{tag}</Tag>,
                  },
                  {
                    title: t('scannerPackages.scannerName'),
                    dataIndex: 'name',
                    key: 'name',
                    width: 200,
                    ellipsis: true,
                  },
                  {
                    title: t('scannerPackages.scannerType'),
                    dataIndex: 'scanner_type',
                    key: 'scanner_type',
                    width: 100,
                    render: (type: string) => getScannerTypeLabel(type),
                  },
                  {
                    title: t('scannerPackages.riskLevel'),
                    dataIndex: 'risk_level',
                    key: 'risk_level',
                    width: 150,
                    render: (level: string, record: ScannerConfig) => (
                      <Space>
                        <Tag color={getRiskLevelColor(level)}>
                          {t(`risk.level.${level}`)}
                        </Tag>
                        {record.has_risk_level_override && (
                          <Tooltip title={t('scannerPackages.hasOverrides')}>
                            <InfoCircleOutlined style={{ color: '#1890ff' }} />
                          </Tooltip>
                        )}
                      </Space>
                    ),
                  },
                  {
                    title: t('scannerPackages.isEnabled'),
                    dataIndex: 'is_enabled',
                    key: 'is_enabled',
                    width: 80,
                    render: (enabled: boolean, record: ScannerConfig) => (
                      <Switch
                        checked={enabled}
                        onChange={(checked) => handleToggleScanner(record.id, checked)}
                        loading={saving}
                      />
                    ),
                  },
                  {
                    title: t('scannerPackages.scanPrompt'),
                    dataIndex: 'scan_prompt',
                    key: 'scan_prompt',
                    width: 100,
                    render: (enabled: boolean, record: ScannerConfig) => (
                      <Space direction="vertical" size={0} align="center">
                        <Switch
                          checked={enabled}
                          onChange={(checked) => handleToggleScanPrompt(record.id, checked)}
                          loading={saving}
                          size="small"
                        />
                        {record.has_scan_prompt_override && (
                          <Tooltip title={t('scannerPackages.hasOverrides')}>
                            <InfoCircleOutlined style={{ color: '#1890ff', fontSize: '12px' }} />
                          </Tooltip>
                        )}
                      </Space>
                    ),
                  },
                  {
                    title: t('scannerPackages.scanResponse'),
                    dataIndex: 'scan_response',
                    key: 'scan_response',
                    width: 100,
                    render: (enabled: boolean, record: ScannerConfig) => (
                      <Space direction="vertical" size={0} align="center">
                        <Switch
                          checked={enabled}
                          onChange={(checked) => handleToggleScanResponse(record.id, checked)}
                          loading={saving}
                          size="small"
                        />
                        {record.has_scan_response_override && (
                          <Tooltip title={t('scannerPackages.hasOverrides')}>
                            <InfoCircleOutlined style={{ color: '#1890ff', fontSize: '12px' }} />
                          </Tooltip>
                        )}
                      </Space>
                    ),
                  },
                  {
                    title: t('common.actions'),
                    key: 'actions',
                    width: 120,
                    fixed: 'right',
                    render: (_: any, record: ScannerConfig) => (
                      <Button
                        type="link"
                        size="small"
                        onClick={() => handleReset(record.id)}
                        disabled={!record.has_risk_level_override && !record.has_scan_prompt_override && !record.has_scan_response_override}
                      >
                        {t('scannerPackages.resetToDefault')}
                      </Button>
                    ),
                  },
                ]}
                dataSource={getPackageScanners(selectedPackage.id)}
                rowKey="id"
                pagination={false}
                size="small"
                scroll={{ x: 'max-content' }}
              />
            </Space>
          )}
        </Drawer>

        {/* Marketplace Package Details Drawer */}
        <Drawer
          title={detailsPackage ? `${detailsPackage.package_name} - ${t('scannerPackages.packageDetails')}` : ''}
          placement="right"
          width={900}
          onClose={handleCloseDetailsDrawer}
          open={detailsDrawerVisible}
        >
          <Spin spinning={loadingDetails}>
            {detailsPackage && (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label={t('scannerPackages.packageName')}>
                    {detailsPackage.package_name}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.description')}>
                    {detailsPackage.description || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.author')}>
                    {detailsPackage.author}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.version')}>
                    {detailsPackage.version}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.scannerCount')}>
                    {detailsPackage.scanner_count}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.priceDisplay')}>
                    {formatPriceDisplay(detailsPackage.price, detailsPackage.price_display)}
                  </Descriptions.Item>
                </Descriptions>

                {packageDetails && packageDetails.scanners && packageDetails.scanners.length > 0 && (
                  <>
                    <div style={{ fontWeight: 'bold', fontSize: '16px' }}>
                      {t('scannerPackages.scannersIncluded')}
                    </div>
                    <Table
                      columns={[
                        {
                          title: t('scannerPackages.scannerTag'),
                          dataIndex: 'tag',
                          key: 'tag',
                          width: 80,
                          render: (tag: string) => <Tag color="blue">{tag}</Tag>,
                        },
                        {
                          title: t('scannerPackages.scannerName'),
                          dataIndex: 'name',
                          key: 'name',
                          width: 200,
                        },
                        {
                          title: t('scannerPackages.scannerType'),
                          dataIndex: 'scanner_type',
                          key: 'scanner_type',
                          width: 100,
                          render: (type: string) => getScannerTypeLabel(type),
                        },
                        {
                          title: t('scannerPackages.riskLevel'),
                          dataIndex: 'default_risk_level',
                          key: 'default_risk_level',
                          width: 120,
                          render: (level: string) => (
                            <Tag color={getRiskLevelColor(level)}>
                              {t(`risk.level.${level}`)}
                            </Tag>
                          ),
                        },
                      ]}
                      dataSource={packageDetails.scanners}
                      rowKey="tag"
                      pagination={false}
                      size="small"
                    />
                  </>
                )}

                <div style={{
                  padding: '16px',
                  backgroundColor: '#f0f2f5',
                  borderRadius: '4px',
                  textAlign: 'center'
                }}>
                  <p style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 'bold' }}>
                    {t('scannerPackages.interestedInPurchase')}
                  </p>
                  <Button
                    type="primary"
                    icon={<ShoppingOutlined />}
                    onClick={() => {
                      handleCloseDetailsDrawer();
                      handleRequestPurchase(detailsPackage);
                    }}
                  >
                    {t('scannerPackages.requestPurchase')}
                  </Button>
                </div>
              </Space>
            )}
          </Spin>
        </Drawer>
      </Space>
    </Spin>
  );
};

export default OfficialScannersManagement;
