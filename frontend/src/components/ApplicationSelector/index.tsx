import React, { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useApplication } from '../../contexts/ApplicationContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from 'sonner';

interface Application {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

const ApplicationSelector: React.FC = () => {
  const { t } = useTranslation();
  // Access context with refreshTrigger and auth for user events
  const context = useApplication() as ReturnType<typeof useApplication> & { _refreshTrigger?: number };
  const { currentApplicationId, setCurrentApplicationId } = context;
  const { isAuthenticated, onUserSwitch } = useAuth();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true); // Start with loading=true

  const fetchApplications = useCallback(async () => {
    if (!isAuthenticated) return;

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
        }
        // Note: We don't explicitly set it here if it exists, because the context already
        // handles syncing with localStorage. This prevents potential infinite loops.
      } else if (apps.length > 0) {
        // Set default application if none selected
        console.log('No application selected, setting first available app:', apps[0].id);
        setCurrentApplicationId(apps[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch applications:', error);
      toast.error(t('applicationSelector.fetchError'));
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, setCurrentApplicationId, t]);

  useEffect(() => {
    // Only fetch applications when user is authenticated
    if (isAuthenticated) {
      fetchApplications();
    } else {
      // Clear applications when user logs out
      setApplications([]);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]); // Re-fetch when authentication state changes

  // Refresh when refreshTrigger changes
  useEffect(() => {
    if (context._refreshTrigger !== undefined && context._refreshTrigger > 0) {
      fetchApplications();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context._refreshTrigger]);

  // Listen to user switch events to refresh applications
  useEffect(() => {
    if (!isAuthenticated) return;

    const unsubscribe = onUserSwitch(() => {
      // Fetch applications immediately after user switch
      fetchApplications();
    });

    return unsubscribe;
  }, [isAuthenticated, onUserSwitch, fetchApplications]);

  const handleChange = (value: string) => {
    setCurrentApplicationId(value);
  };

  // Only show currentApplicationId if we have loaded applications and it's valid
  const displayValue = loading ? undefined : (
    applications.some(app => app.id === currentApplicationId) ? currentApplicationId : undefined
  );

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-slate-700">{t('applicationSelector.label')}:</span>
      <Select value={displayValue} onValueChange={handleChange} disabled={loading}>
        <SelectTrigger className="w-[180px] h-9 text-sm border-slate-200 focus:ring-blue-500">
          {loading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              <SelectValue placeholder={t('applicationSelector.placeholder')} />
            </div>
          ) : applications.length === 0 ? (
            <SelectValue placeholder={t('applicationSelector.noApplications')} />
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent className="min-w-[180px]">
          {applications.map(app => (
            <SelectItem key={app.id} value={app.id}>
              {app.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

export default ApplicationSelector;