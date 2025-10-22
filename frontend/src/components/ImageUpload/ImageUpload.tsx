import React, { useState } from 'react';
import { Upload, Image, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { UploadFile } from 'antd/es/upload/interface';

interface ImageUploadProps {
  onChange?: (base64Images: string[]) => void;
  maxCount?: number;
  maxSize?: number; // MB
}

const ImageUpload: React.FC<ImageUploadProps> = ({
  onChange,
  maxCount = 5,
  maxSize = 10
}) => {
  const { t } = useTranslation();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [previewImage, setPreviewImage] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

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

  return (
    <>
      <Upload
        listType="picture-card"
        fileList={fileList}
        beforeUpload={beforeUpload}
        onChange={handleChange}
        onPreview={handlePreview}
        onRemove={handleRemove}
        multiple
        accept="image/*"
      >
        {fileList.length >= maxCount ? null : uploadButton}
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
      <div style={{ marginTop: 8, color: '#666', fontSize: 12 }}>
        {t('imageUpload.supportedFormats')} | {t('imageUpload.maxSizePerImage', { size: maxSize })} | {t('imageUpload.maxImageCount', { count: maxCount })}
      </div>
    </>
  );
};

export default ImageUpload;