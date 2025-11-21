import React, { useState, useEffect } from 'react';
import { Card, Table, Button, message, Spin, Space, Modal, Upload, Tag, Input, Drawer, Descriptions, Badge, Form } from 'antd';
import { UploadOutlined, ReloadOutlined, DeleteOutlined, EyeOutlined, EditOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { useAuth } from '../../contexts/AuthContext';
import { scannerPackagesApi } from '../../services/api';
import type { UploadFile } from 'antd';

const { TextArea } = Input;

interface Package {
  id: string;
  package_code: string;
  package_name: string;
  author: string;
  description?: string;
  version: string;
  scanner_count: number;
  price?: number;
  price_display?: string;
  created_at?: string;
  archived?: boolean;
  archived_at?: string;
  archive_reason?: string;
}

interface Scanner {
  id: string;
  scanner_tag: string;
  scanner_name: string;
  scanner_type: 'genai' | 'regex' | 'keyword';
  risk_level: 'high' | 'medium' | 'low';
  scan_target: 'prompt' | 'response' | 'both';
  is_active: boolean;
  description?: string;
  // definition is excluded for security reasons
}

interface PackageDetail extends Package {
  scanners: Scanner[];
}

const PackageMarketplace: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  // Dynamic price display function based on current language
  const formatPriceDisplay = (price: number | undefined, priceDisplay: string | undefined): string => {
    if (price === undefined || price === null) {
      return priceDisplay || 'Free';
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
  const [packages, setPackages] = useState<Package[]>([]);
  const [uploadModalVisible, setUploadModalVisible] = useState(false);
  const [archiveModalVisible, setArchiveModalVisible] = useState(false);
  const [selectedPackageForArchive, setSelectedPackageForArchive] = useState<Package | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<PackageDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [selectedPackageForEdit, setSelectedPackageForEdit] = useState<Package | null>(null);
  const [editForm] = Form.useForm();
  const [uploadPrice, setUploadPrice] = useState<number | null>(null);

  const isSuperAdmin = user?.is_super_admin || false;

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const packagesData = isSuperAdmin
        ? await scannerPackagesApi.getAllAdmin('purchasable', true)  // Admin: see all purchasable packages (including archived)
        : await scannerPackagesApi.getAll('purchasable');      // Regular user: only purchased packages
      setPackages(packagesData);
    } catch (error) {
      message.error(t('packageMarketplace.loadFailed'));
      console.error('Failed to load marketplace data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (fileList.length === 0) {
      message.error('Please select a JSON file');
      return;
    }

    const file = fileList[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const jsonContent = JSON.parse(e.target?.result as string);

        // Get current language for price formatting
        const currentLanguage = localStorage.getItem('language') || 'en';

        // Upload with price
        await scannerPackagesApi.uploadPackage({
          package_data: jsonContent,
          price: uploadPrice,
          language: currentLanguage
        });

        message.success(t('packageMarketplace.uploadSuccess'));
        setUploadModalVisible(false);
        setFileList([]);
        setUploadPrice(null);
        await loadData();
      } catch (error) {
        message.error(t('packageMarketplace.uploadFailed'));
        console.error('Failed to upload package:', error);
      }
    };

    reader.readAsText(file as any);
  };

  const handleArchivePackage = (pkg: Package) => {
    setSelectedPackageForArchive(pkg);
    setArchiveReason('');
    setArchiveModalVisible(true);
  };

  const handleConfirmArchive = async () => {
    if (!selectedPackageForArchive) return;

    try {
      await scannerPackagesApi.archivePackage(selectedPackageForArchive.id, archiveReason);
      message.success(t('packageMarketplace.archiveSuccess'));
      setArchiveModalVisible(false);
      setSelectedPackageForArchive(null);
      setArchiveReason('');
      await loadData();
    } catch (error) {
      message.error(t('packageMarketplace.archiveFailed'));
    }
  };

  const handleUnarchivePackage = async (pkg: Package) => {
    Modal.confirm({
      title: t('packageMarketplace.unarchivePackage'),
      content: (
        <div>
          <p>{t('packageMarketplace.confirmUnarchive')}</p>
          <p style={{ color: '#faad14', fontSize: '12px' }}>
            {t('packageMarketplace.unarchiveWarning')}
          </p>
        </div>
      ),
      onOk: async () => {
        try {
          await scannerPackagesApi.unarchivePackage(pkg.id);
          message.success(t('packageMarketplace.unarchiveSuccess'));
          await loadData();
        } catch (error) {
          message.error(t('packageMarketplace.unarchiveFailed'));
        }
      },
    });
  };

  const handleDeletePackage = (pkg: Package) => {
    Modal.confirm({
      title: t('packageMarketplace.deletePackage'),
      content: (
        <div>
          <p>{t('packageMarketplace.confirmDelete')}</p>
          <p style={{ color: '#ff4d4f', fontSize: '12px' }}>
            {t('packageMarketplace.deleteWarning')}
          </p>
        </div>
      ),
      onOk: async () => {
        try {
          await scannerPackagesApi.deletePackage(pkg.id);
          message.success(t('packageMarketplace.deleteSuccess'));
          await loadData();
        } catch (error) {
          message.error(t('packageMarketplace.deleteFailed'));
        }
      },
    });
  };

  const handleViewPackageDetail = async (pkg: Package) => {
    try {
      setLoadingDetail(true);
      setDrawerVisible(true);
      // Use marketplace detail endpoint for previewing packages (including unpurchased ones)
      const detail = await scannerPackagesApi.getMarketplaceDetail(pkg.id);
      setSelectedPackage(detail);
    } catch (error) {
      message.error(t('packageMarketplace.loadDetailFailed'));
      console.error('Failed to load package detail:', error);
      setDrawerVisible(false);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleEditPackage = (pkg: Package) => {
    setSelectedPackageForEdit(pkg);
    editForm.setFieldsValue({
      package_code: pkg.package_code,
      package_name: pkg.package_name,
      description: pkg.description,
      version: pkg.version,
      price: pkg.price,
      price_display: pkg.price_display || '',
    });
    setEditModalVisible(true);
  };

  const handleUpdatePackage = async () => {
    try {
      const values = await editForm.validateFields();
      if (!selectedPackageForEdit) return;

      await scannerPackagesApi.updatePackage(selectedPackageForEdit.id, values);
      message.success(t('packageMarketplace.updateSuccess'));
      setEditModalVisible(false);
      setSelectedPackageForEdit(null);
      editForm.resetFields();
      await loadData();
    } catch (error) {
      message.error(t('packageMarketplace.updateFailed'));
      console.error('Failed to update package:', error);
    }
  };

  const getRiskLevelColor = (level: string) => {
    switch (level) {
      case 'high':
        return 'red';
      case 'medium':
        return 'orange';
      case 'low':
        return 'blue';
      default:
        return 'default';
    }
  };

  const getScannerTypeLabel = (type: string) => {
    switch (type) {
      case 'genai':
        return t('scannerPackages.typeGenai');
      case 'regex':
        return t('scannerPackages.typeRegex');
      case 'keyword':
        return t('scannerPackages.typeKeyword');
      default:
        return type;
    }
  };

  const getScanTargetLabel = (target: string) => {
    switch (target) {
      case 'prompt':
        return t('scannerPackages.targetPrompt');
      case 'response':
        return t('scannerPackages.targetResponse');
      case 'both':
        return t('scannerPackages.targetBoth');
      default:
        return target;
    }
  };

  const packageColumns = [
    {
      title: t('packageMarketplace.packageName'),
      dataIndex: 'package_name',
      key: 'package_name',
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
      title: t('packageMarketplace.status'),
      dataIndex: 'archived',
      key: 'archived',
      width: 100,
      render: (archived: boolean, record: Package) => (
        <Tag color={archived ? 'default' : 'green'}>
          {archived ? t('packageMarketplace.archived') : t('packageMarketplace.active')}
        </Tag>
      ),
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
      width: isSuperAdmin ? 320 : 150,
      render: (_: any, record: Package) => (
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewPackageDetail(record)}
          >
            {t('packageMarketplace.viewDetails')}
          </Button>
          {isSuperAdmin && (
            <>
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => handleEditPackage(record)}
              >
                {t('common.edit')}
              </Button>
              {record.archived ? (
                <Button
                  size="small"
                  type="default"
                  onClick={() => handleUnarchivePackage(record)}
                >
                  {t('packageMarketplace.unarchivePackage')}
                </Button>
              ) : (
                <Button
                  size="small"
                  type="default"
                  onClick={() => handleArchivePackage(record)}
                >
                  {t('packageMarketplace.archivePackage')}
                </Button>
              )}
            </>
          )}
        </Space>
      ),
    },
  ];

  const uploadProps = {
    beforeUpload: (file: UploadFile) => {
      if (file.type !== 'application/json') {
        message.error('Only JSON files are allowed');
        return false;
      }
      setFileList([file]);
      return false;
    },
    fileList,
    onRemove: () => {
      setFileList([]);
    },
  };

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          title={t('packageMarketplace.title')}
          extra={
            <Space>
              <Button
                icon={<ReloadOutlined />}
                onClick={loadData}
                loading={loading}
              >
                {t('common.refresh')}
              </Button>
              {isSuperAdmin && (
                <Button
                  type="primary"
                  icon={<UploadOutlined />}
                  onClick={() => setUploadModalVisible(true)}
                >
                  {t('packageMarketplace.uploadPackage')}
                </Button>
              )}
            </Space>
          }
        >
          <Table
            columns={packageColumns}
            dataSource={packages}
            rowKey="id"
            pagination={{ pageSize: 20 }}
          />
        </Card>

        <Modal
          title={t('packageMarketplace.uploadPackage')}
          open={uploadModalVisible}
          onOk={handleUpload}
          onCancel={() => {
            setUploadModalVisible(false);
            setFileList([]);
            setUploadPrice(null);
          }}
          okText={t('common.upload')}
          cancelText={t('common.cancel')}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <strong>{t('packageMarketplace.packageJsonFormat')}</strong>
              <p style={{ fontSize: '12px', color: '#666' }}>
                {t('packageMarketplace.jsonFormatHelp')}
              </p>
            </div>

            <div>
              <label>{t('scannerPackages.price')}</label>
              <Input
                type="number"
                placeholder={t('packageMarketplace.pricePlaceholder')}
                value={uploadPrice || ''}
                onChange={(e) => setUploadPrice(e.target.value ? parseFloat(e.target.value) : null)}
                min={0}
                step="0.01"
                addonAfter={
                  <span style={{ fontSize: '12px', color: '#666' }}>
                    {i18n.language === 'zh' ? '元' : '$'}
                  </span>
                }
              />
              <p style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
                {t('packageMarketplace.priceHelp')}
              </p>
            </div>

            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />}>
                {t('packageMarketplace.uploadJson')}
              </Button>
            </Upload>
          </Space>
        </Modal>

        <Modal
          title={t('packageMarketplace.editPackage')}
          open={editModalVisible}
          onOk={handleUpdatePackage}
          onCancel={() => {
            setEditModalVisible(false);
            setSelectedPackageForEdit(null);
            editForm.resetFields();
          }}
          okText={t('common.save')}
          cancelText={t('common.cancel')}
          width={600}
        >
          {selectedPackageForEdit && (
            <Form
              form={editForm}
              layout="vertical"
              initialValues={{
                package_code: selectedPackageForEdit.package_code,
                package_name: selectedPackageForEdit.package_name,
                description: selectedPackageForEdit.description,
                version: selectedPackageForEdit.version,
                price: selectedPackageForEdit.price,
                price_display: selectedPackageForEdit.price_display || '',
              }}
            >
              <Form.Item
                name="package_code"
                label={t('scannerPackages.packageCode')}
                rules={[{ required: true, message: t('validation.required') }]}
              >
                <Input placeholder={t('scannerPackages.packageCode')} disabled />
              </Form.Item>

              <Form.Item
                name="package_name"
                label={t('scannerPackages.packageName')}
                rules={[{ required: true, message: t('validation.required') }]}
              >
                <Input placeholder={t('scannerPackages.packageName')} />
              </Form.Item>

              <Form.Item
                name="description"
                label={t('scannerPackages.description')}
              >
                <TextArea
                  placeholder={t('scannerPackages.description')}
                  rows={3}
                />
              </Form.Item>

              <Form.Item
                name="version"
                label={t('scannerPackages.version')}
                rules={[{ required: true, message: t('validation.required') }]}
              >
                <Input placeholder={t('scannerPackages.version')} />
              </Form.Item>

              <Form.Item
                name="price"
                label={t('scannerPackages.price')}
                tooltip={t('packageMarketplace.priceTooltip')}
              >
                <Input
                  type="number"
                  placeholder={t('packageMarketplace.pricePlaceholder')}
                  min={0}
                  step="0.01"
                  addonAfter={i18n.language === 'zh' ? '元' : '$'}
                />
              </Form.Item>

              <Form.Item
                name="price_display"
                label={t('scannerPackages.priceDisplay')}
                tooltip={t('packageMarketplace.priceDisplayTooltip')}
              >
                <Input
                  placeholder={t('packageMarketplace.priceDisplayPlaceholder')}
                />
              </Form.Item>
            </Form>
          )}
        </Modal>

        <Modal
          title={t('packageMarketplace.archivePackage')}
          open={archiveModalVisible}
          onOk={handleConfirmArchive}
          onCancel={() => {
            setArchiveModalVisible(false);
            setSelectedPackageForArchive(null);
            setArchiveReason('');
          }}
          okText={t('packageMarketplace.archivePackage')}
          cancelText={t('common.cancel')}
        >
          {selectedPackageForArchive && (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div>
                <p>{t('packageMarketplace.confirmArchive')}</p>
                <p style={{ color: '#faad14', fontSize: '12px' }}>
                  {t('packageMarketplace.archiveWarning')}
                </p>
              </div>
              <div>
                <label>{t('packageMarketplace.archiveReason')}</label>
                <TextArea
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  placeholder={t('packageMarketplace.archiveReasonPlaceholder')}
                  rows={4}
                  style={{ marginTop: '8px' }}
                />
              </div>
            </Space>
          )}
        </Modal>

        <Drawer
          title={t('packageMarketplace.packageDetails')}
          placement="right"
          width={720}
          open={drawerVisible}
          onClose={() => {
            setDrawerVisible(false);
            setSelectedPackage(null);
          }}
        >
          {loadingDetail ? (
            <Spin style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }} />
          ) : selectedPackage ? (
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              {/* Package Basic Info */}
              <Card size="small" title={t('packageMarketplace.basicInfo')}>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label={t('packageMarketplace.packageName')}>
                    {selectedPackage.package_name}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.packageCode')}>
                    <Tag color="blue">{selectedPackage.package_code}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.author')}>
                    {selectedPackage.author}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.version')}>
                    {selectedPackage.version}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.scannerCount')}>
                    <Badge count={selectedPackage.scanner_count} showZero color="blue" />
                  </Descriptions.Item>
                  <Descriptions.Item label={t('scannerPackages.priceDisplay')}>
                    {formatPriceDisplay(selectedPackage.price, selectedPackage.price_display)}
                  </Descriptions.Item>
                  {selectedPackage.description && (
                    <Descriptions.Item label={t('scannerPackages.description')}>
                      {selectedPackage.description}
                    </Descriptions.Item>
                  )}
                </Descriptions>
              </Card>

              {/* Scanners List */}
              <Card
                size="small"
                title={
                  <Space>
                    {t('packageMarketplace.scannersList')}
                    <Badge count={selectedPackage.scanners?.length || 0} showZero />
                  </Space>
                }
              >
                {selectedPackage.scanners && selectedPackage.scanners.length > 0 ? (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {selectedPackage.scanners.map((scanner) => (
                      <Card
                        key={scanner.id}
                        type="inner"
                        size="small"
                        title={
                          <Space>
                            <Tag color="purple">{scanner.scanner_tag}</Tag>
                            <span>{scanner.scanner_name}</span>
                          </Space>
                        }
                        extra={
                          <Badge
                            status={scanner.is_active ? 'success' : 'default'}
                            text={scanner.is_active ? t('common.active') : t('common.inactive')}
                          />
                        }
                      >
                        <Descriptions column={1} size="small">
                          <Descriptions.Item label={t('scannerPackages.scannerType')}>
                            <Tag color="cyan">{getScannerTypeLabel(scanner.scanner_type)}</Tag>
                          </Descriptions.Item>
                          <Descriptions.Item label={t('scannerPackages.riskLevel')}>
                            <Tag color={getRiskLevelColor(scanner.risk_level)}>
                              {t(`scannerPackages.riskLevel${scanner.risk_level.charAt(0).toUpperCase() + scanner.risk_level.slice(1)}`)}
                            </Tag>
                          </Descriptions.Item>
                          <Descriptions.Item label={t('scannerPackages.scanTarget')}>
                            <Tag color="geekblue">{getScanTargetLabel(scanner.scan_target)}</Tag>
                          </Descriptions.Item>
                        </Descriptions>
                      </Card>
                    ))}
                  </Space>
                ) : (
                  <div style={{ textAlign: 'center', padding: '20px', color: '#999' }}>
                    {t('packageMarketplace.noScannersFound')}
                  </div>
                )}
              </Card>
            </Space>
          ) : null}
        </Drawer>
      </Space>
    </Spin>
  );
};

export default PackageMarketplace;
