import React, { createContext, useContext, useState, ReactNode } from 'react';

interface ApplicationContextType {
  currentApplicationId: string | null;
  setCurrentApplicationId: (id: string | null) => void;
}

const ApplicationContext = createContext<ApplicationContextType | undefined>(undefined);

export const ApplicationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Initialize from localStorage
  const [currentApplicationId, setCurrentApplicationId] = useState<string | null>(() => {
    return localStorage.getItem('current_application_id');
  });

  // Update localStorage when applicationId changes
  const handleSetApplicationId = (id: string | null) => {
    setCurrentApplicationId(id);
    if (id) {
      localStorage.setItem('current_application_id', id);
    } else {
      localStorage.removeItem('current_application_id');
    }
  };

  return (
    <ApplicationContext.Provider value={{ currentApplicationId, setCurrentApplicationId: handleSetApplicationId }}>
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
