import React, { useState, useEffect } from 'react';
import { Upload, Image, message, Alert, Button } from 'antd';
import { PlusOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { UploadFile } from 'antd/es/upload/interface';
import { billingService } from '../../services/billing';

interface Subscription {
  subscription_type: 'free' | 'subscribed';
}

interface ImageUploadProps {
  onChange?: (base64Images: string[]) => void;
  maxCount?: number;
  maxSize?: number; // MB
  showSubscriptionPrompt?: boolean; // 显示订阅提示
}

const ImageUpload: React.FC<ImageUploadProps> = ({
  onChange,
  maxCount = 5,
  maxSize = 10,
  showSubscriptionPrompt = true
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [previewImage, setPreviewImage] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch subscription status
  useEffect(() => {
    const fetchSubscription = async () => {
      try {
        const sub = await billingService.getCurrentSubscription();
        setSubscription(sub);
      } catch (e: any) {
        console.error('Failed to fetch subscription:', e);
        // 默认为免费用户以避免服务中断
        setSubscription({ subscription_type: 'free' });
      } finally {
        setLoading(false);
      }
    };

    fetchSubscription();
  }, []);

  // Convert file to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to read file'));
        }
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // Handle file selection
  const handleChange = async (info: any) => {
    // Check subscription before allowing image upload
    if (subscription && subscription.subscription_type === 'free') {
      message.warning(t('imageUpload.subscriptionRequired') || 'Image detection is only available for subscribed users. Please upgrade your plan to access this feature.');
      return;
    }

    let newFileList = [...info.fileList];

    // Limit quantity
    if (newFileList.length > maxCount) {
      message.warning(t('imageUpload.maxCountWarning', { count: maxCount }));
      newFileList = newFileList.slice(0, maxCount);
    }

    setFileList(newFileList);

    // Convert all files to base64
    try {
      const base64List: string[] = [];
      for (const file of newFileList) {
        if (file.originFileObj) {
          const base64 = await fileToBase64(file.originFileObj as File);
          base64List.push(base64);
        }
      }
      onChange?.(base64List);
    } catch (error) {
      console.error('Failed to convert images to base64:', error);
      message.error(t('imageUpload.processingFailed'));
    }
  };

  // Validation before upload
  const beforeUpload = (file: File) => {
    // Validate file type
    const isImage = file.type.startsWith('image/');
    if (!isImage) {
      message.error(t('imageUpload.onlyImageFiles'));
      return Upload.LIST_IGNORE;
    }

    // Validate file size
    const isLtMaxSize = file.size / 1024 / 1024 < maxSize;
    if (!isLtMaxSize) {
      message.error(t('imageUpload.fileSizeExceeded', { size: maxSize }));
      return Upload.LIST_IGNORE;
    }

    return false; // Prevent automatic upload
  };

  // Preview image
  const handlePreview = async (file: UploadFile) => {
    if (!file.url && !file.preview && file.originFileObj) {
      file.preview = await fileToBase64(file.originFileObj as File);
    }
    setPreviewImage(file.url || file.preview || '');
    setPreviewOpen(true);
  };

  // Remove image
  const handleRemove = (file: UploadFile) => {
    const newFileList = fileList.filter(item => item.uid !== file.uid);
    setFileList(newFileList);

    // Update base64 list
    const updateBase64List = async () => {
      const base64List: string[] = [];
      for (const f of newFileList) {
        if (f.originFileObj) {
          const base64 = await fileToBase64(f.originFileObj as File);
          base64List.push(base64);
        }
      }
      onChange?.(base64List);
    };
    updateBase64List();
  };

  const uploadButton = (
    <div>
      <PlusOutlined />
      <div style={{ marginTop: 8 }}>{t('imageUpload.uploadImage')}</div>
    </div>
  );

  const restrictedUploadButton = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', cursor: 'not-allowed' }}>
      <LockOutlined />
      <div style={{ marginTop: 8, fontSize: 12, textAlign: 'center' }}>
        {t('imageUpload.subscriptionRequired') || 'Subscription Required'}
      </div>
    </div>
  );

  if (loading) {
    return <Upload listType="picture-card" disabled>Loading...</Upload>;
  }

  const isSubscribed = subscription?.subscription_type === 'subscribed';
  const renderSubscriptionPrompt = showSubscriptionPrompt && !isSubscribed;

  return (
    <>
      {renderSubscriptionPrompt && (
        <Alert
          message="Subscription Required"
          description="Image detection is only available for subscribed users. Please upgrade your plan to access this feature."
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          action={
            <Button type="primary" size="small" onClick={() => navigate('/subscription')}>
              Upgrade Plan
            </Button>
          }
        />
      )}
      <Upload
        listType="picture-card"
        fileList={fileList}
        beforeUpload={isSubscribed ? beforeUpload : () => Upload.LIST_IGNORE}
        onChange={isSubscribed ? handleChange : undefined}
        onPreview={handlePreview}
        onRemove={handleRemove}
        multiple
        accept="image/*"
        disabled={!isSubscribed}
      >
        {fileList.length >= maxCount ? null : (isSubscribed ? uploadButton : restrictedUploadButton)}
      </Upload>
      {previewImage && (
        <Image
          wrapperStyle={{ display: 'none' }}
          preview={{
            visible: previewOpen,
            onVisibleChange: (visible) => setPreviewOpen(visible),
          }}
          src={previewImage}
        />
      )}
      {isSubscribed ? (
        <div style={{ marginTop: 8, color: '#666', fontSize: 12 }}>
          {t('imageUpload.supportedFormats')} | {t('imageUpload.maxSizePerImage', { size: maxSize })} | {t('imageUpload.maxImageCount', { count: maxCount })}
        </div>
      ) : (
        <div style={{ marginTop: 8, color: '#888', fontSize: 12, textAlign: 'center' }}>
          <LockOutlined /> {t('imageUpload.subscriptionFeature') || 'Premium Feature - Upgrade to Enable'}
        </div>
      )}
    </>
  );
};

export default ImageUpload;