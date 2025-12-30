import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider } from './contexts/AuthContext'
import App from './App'
import './i18n' // Initialize i18n
import { initializeLanguage } from './utils/languageDetector'
import './index.css'

// Initialize language detection and render app
// Check if user is already logged in to get their language preference
const getInitialLanguage = async () => {
  try {
    // Check if user has auth token
    const token = localStorage.getItem('auth_token');
    if (token) {
      // Try to get user info to get language preference
      try {
        const { authService } = await import('./services/auth');
        const userInfo = await authService.getCurrentUser();
        return userInfo.language;
      } catch (error) {
        // If getting user info fails, continue with normal detection
        console.warn('Failed to get user language preference:', error);
      }
    }
    return undefined;
  } catch (error) {
    console.warn('Failed to check user language preference:', error);
    return undefined;
  }
};

getInitialLanguage().then((userLanguage) => {
  return initializeLanguage(userLanguage);
}).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter basename="/platform">
        <AuthProvider>
          <App />
          <Toaster position="top-right" richColors />
        </AuthProvider>
      </BrowserRouter>
    </React.StrictMode>,
  )
})