import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { authService, UserInfo } from '../services/auth';
import { adminApi } from '../services/api';

interface SwitchInfo {
  is_switched: boolean;
  admin_user?: { id: string; email: string };
  target_user?: { id: string; email: string; api_key: string };
}

interface AuthContextType {
  user: UserInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  switchInfo: SwitchInfo;
  login: (email: string, password: string, language?: string) => Promise<void>;
  logout: () => Promise<void>;
  switchToUser: (userId: string) => Promise<void>;
  exitSwitch: () => Promise<void>;
  refreshSwitchStatus: () => Promise<void>;
  refreshUserInfo: () => Promise<void>;
  // User switch event listener
  onUserSwitch: (callback: () => void) => () => void; // Return function to cancel listener
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [switchInfo, setSwitchInfo] = useState<SwitchInfo>({ is_switched: false });
  const [switchCallbacks, setSwitchCallbacks] = useState<Set<() => void>>(new Set());

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      if (authService.isAuthenticated()) {
        const userInfo = await authService.getCurrentUser();
        setUser(userInfo);
        setIsAuthenticated(true);
        
        // Set user language preference if available
        if (userInfo.language) {
          localStorage.setItem('i18nextLng', userInfo.language);
          // Trigger language change without page reload
          const i18n = (await import('../i18n')).default;
          await i18n.changeLanguage(userInfo.language);
        }
        
        // Check user switch status
        await refreshSwitchStatus();
      } else {
        setUser(null);
        setIsAuthenticated(false);
        setSwitchInfo({ is_switched: false });
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      setUser(null);
      setIsAuthenticated(false);
      setSwitchInfo({ is_switched: false });
      authService.clearToken();
    } finally {
      setIsLoading(false);
    }
  };

  const refreshSwitchStatus = async () => {
    try {
      const response = await adminApi.getCurrentSwitch();
      setSwitchInfo(response);
    } catch (error) {
      // If not super admin or no switch permission, ignore error
      setSwitchInfo({ is_switched: false });
    }
  };

  const refreshUserInfo = async () => {
    try {
      if (authService.isAuthenticated()) {
        const userInfo = await authService.getCurrentUser();
        setUser(userInfo);
        
        // Update language preference if changed
        if (userInfo.language) {
          localStorage.setItem('i18nextLng', userInfo.language);
          // Trigger language change without page reload
          const i18n = (await import('../i18n')).default;
          await i18n.changeLanguage(userInfo.language);
        }
      }
    } catch (error) {
      console.error('Failed to refresh user info:', error);
    }
  };

  const login = async (email: string, password: string, language?: string) => {
    try {
      const response = await authService.login({ email, password, language });
      authService.setToken(response.access_token);
      
      const userInfo = await authService.getCurrentUser();
      setUser(userInfo);
      setIsAuthenticated(true);
      
      // Set language preference after successful login
      if (userInfo.language) {
        localStorage.setItem('i18nextLng', userInfo.language);
        // Trigger language change without page reload
        const i18n = (await import('../i18n')).default;
        await i18n.changeLanguage(userInfo.language);
      }
      
      // Refresh switch status after login, avoid 401 prompt due to concurrent requests on homepage
      try {
        await refreshSwitchStatus();
      } catch (e) {
        // Ignore switch status error
      }
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  };

  const logout = async () => {
    try {
      await authService.logout();
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setUser(null);
      setIsAuthenticated(false);
      setSwitchInfo({ is_switched: false });
      localStorage.removeItem('switch_session_token');
    }
  };

  const switchToUser = async (userId: string) => {
    try {
      const response = await adminApi.switchToUser(userId);
      localStorage.setItem('switch_session_token', response.switch_session_token);
      await refreshSwitchStatus();
      // Notify all listeners that user switched
      switchCallbacks.forEach(callback => callback());
    } catch (error) {
      console.error('Switch user failed:', error);
      throw error;
    }
  };

  const exitSwitch = async () => {
    try {
      await adminApi.exitSwitch();
      localStorage.removeItem('switch_session_token');
      await refreshSwitchStatus();
      // Notify all listeners that user exited switch
      switchCallbacks.forEach(callback => callback());
    } catch (error) {
      console.error('Exit switch failed:', error);
      throw error;
    }
  };

  const onUserSwitch = useCallback((callback: () => void) => {
    setSwitchCallbacks(prev => new Set(prev).add(callback));
    // Return function to cancel listener
    return () => {
      setSwitchCallbacks(prev => {
        const newSet = new Set(prev);
        newSet.delete(callback);
        return newSet;
      });
    };
  }, []);

  const value = {
    user,
    isAuthenticated,
    isLoading,
    switchInfo,
    login,
    logout,
    switchToUser,
    exitSwitch,
    refreshSwitchStatus,
    refreshUserInfo,
    onUserSwitch,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};