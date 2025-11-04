import React, { useState, useEffect } from 'react';
import { Select, Spin, message } from 'antd';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useApplication } from '../../contexts/ApplicationContext';

const { Option } = Select;

interface Application {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

const ApplicationSelector: React.FC = () => {
  const { t } = useTranslation();
  const { currentApplicationId, setCurrentApplicationId } = useApplication();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true); // Start with loading=true

  useEffect(() => {
    fetchApplications();
  }, []);

  const fetchApplications = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/v1/applications');
      const apps = response.data.filter((app: Application) => app.is_active);
      setApplications(apps);

      // Set default application if none selected
      if (!currentApplicationId && apps.length > 0) {
        setCurrentApplicationId(apps[0].id);
      }
    } catch (error) {
      message.error(t('applicationSelector.fetchError'));
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (value: string) => {
    setCurrentApplicationId(value);
  };

  // Only show currentApplicationId if we have loaded applications
  const displayValue = loading ? undefined : currentApplicationId;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontWeight: 500, fontSize: '14px' }}>{t('applicationSelector.label')}:</span>
      <Select
        value={displayValue}
        onChange={handleChange}
        style={{ minWidth: 180 }}
        loading={loading}
        placeholder={t('applicationSelector.placeholder')}
        notFoundContent={loading ? <Spin size="small" /> : t('applicationSelector.noApplications')}
      >
        {applications.map(app => (
          <Option key={app.id} value={app.id}>
            {app.name}
          </Option>
        ))}
      </Select>
    </div>
  );
};

export default ApplicationSelector;
