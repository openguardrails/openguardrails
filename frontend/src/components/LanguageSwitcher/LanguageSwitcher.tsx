import React, { useState } from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from 'sonner';

const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();
  const { isAuthenticated, refreshUserInfo } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleLanguageChange = async (lang: string) => {
    if (lang === i18n.language) return;

    try {
      setLoading(true);

      // Update i18n and localStorage immediately for better UX
      i18n.changeLanguage(lang);
      localStorage.setItem('i18nextLng', lang);

      // If user is authenticated, update language preference on server
      if (isAuthenticated) {
        try {
          await authService.updateLanguage(lang);
          // Refresh user info to get updated language preference
          await refreshUserInfo();
          toast.success('Language preference updated successfully');
        } catch (error) {
          console.error('Failed to update language preference:', error);
          toast.warning('Language changed locally, but failed to save preference');
        }
      }

      // Reload page to apply language change
      window.location.reload();
    } catch (error) {
      console.error('Language change failed:', error);
      toast.error('Failed to change language');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Select value={i18n.language} onValueChange={handleLanguageChange} disabled={loading}>
      <SelectTrigger className="w-full h-9 text-sm border-slate-200 focus:ring-blue-500">
        <Languages className="h-4 w-4 mr-2 text-slate-500" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[140px]">
        <SelectItem value="en">English</SelectItem>
        <SelectItem value="zh">中文</SelectItem>
      </SelectContent>
    </Select>
  );
};

export default LanguageSwitcher;