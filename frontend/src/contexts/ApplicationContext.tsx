import React, { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface ApplicationContextType {
  currentApplicationId: string | null;
  setCurrentApplicationId: (id: string | null) => void;
  refreshApplications: () => void;
}

const ApplicationContext = createContext<ApplicationContextType | undefined>(undefined);

export const ApplicationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Initialize from localStorage
  const [currentApplicationId, setCurrentApplicationId] = useState<string | null>(() => {
    return localStorage.getItem('current_application_id');
  });
  
  // Refresh trigger for ApplicationSelector
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Update localStorage when applicationId changes
  const handleSetApplicationId = (id: string | null) => {
    setCurrentApplicationId(id);
    if (id) {
      localStorage.setItem('current_application_id', id);
    } else {
      localStorage.removeItem('current_application_id');
    }
  };

  // Function to trigger refresh of applications list
  const refreshApplications = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  return (
    <ApplicationContext.Provider 
      value={{ 
        currentApplicationId, 
        setCurrentApplicationId: handleSetApplicationId,
        refreshApplications,
        // Internal: expose refreshTrigger for ApplicationSelector
        _refreshTrigger: refreshTrigger,
      } as ApplicationContextType & { _refreshTrigger: number }}>
      {children}
    </ApplicationContext.Provider>
  );
};

export const useApplication = () => {
  const context = useContext(ApplicationContext);
  if (context === undefined) {
    throw new Error('useApplication must be used within an ApplicationProvider');
  }
  return context;
};
