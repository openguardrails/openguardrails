import React, { useState, useEffect, useCallback } from 'react';
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
  // Access context with refreshTrigger
  const context = useApplication() as ReturnType<typeof useApplication> & { _refreshTrigger?: number };
  const { currentApplicationId, setCurrentApplicationId } = context;
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true); // Start with loading=true

  const fetchApplications = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/v1/applications');
      const apps = response.data.filter((app: Application) => app.is_active);
      setApplications(apps);

      // Get current value from localStorage (most up-to-date)
      const storedAppId = localStorage.getItem('current_application_id');

      // Validate stored application ID exists in the fetched applications
      if (storedAppId) {
        const appExists = apps.some((app: Application) => app.id === storedAppId);
        if (!appExists && apps.length > 0) {
          // If stored app doesn't exist, set to first available app
          console.warn(`Stored application ID ${storedAppId} not found, switching to first available app`);
          setCurrentApplicationId(apps[0].id);
        } else if (appExists) {
          // Update context state to match localStorage (in case they got out of sync)
          setCurrentApplicationId(storedAppId);
        }
      } else if (apps.length > 0) {
        // Set default application if none selected
        console.log('No application selected, setting first available app:', apps[0].id);
        setCurrentApplicationId(apps[0].id);
      }
    } catch (error) {
      message.error(t('applicationSelector.fetchError'));
    } finally {
      setLoading(false);
    }
  }, [setCurrentApplicationId, t]); // Remove currentApplicationId from dependencies to avoid infinite loop

  useEffect(() => {
    fetchApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Refresh when refreshTrigger changes
  useEffect(() => {
    if (context._refreshTrigger !== undefined && context._refreshTrigger > 0) {
      fetchApplications();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context._refreshTrigger]);

  const handleChange = (value: string) => {
    setCurrentApplicationId(value);
  };

  // Only show currentApplicationId if we have loaded applications and it's valid
  const displayValue = loading ? undefined : (
    applications.some(app => app.id === currentApplicationId) ? currentApplicationId : undefined
  );

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
