import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  FileSearch,
  BarChart3,
  Settings,
  User,
  LogOut,
  RefreshCw,
  TestTube,
  Book,
  Grid3x3,
  ChevronDown,
  Menu as MenuIcon,
  X,
  Shield,
  ChevronLeft,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { adminApi, configApi } from '../../services/api'
import LanguageSwitcher from '../LanguageSwitcher/LanguageSwitcher'
import ApplicationSelector from '../ApplicationSelector'
import { features } from '../../config'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { toast } from 'sonner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { cn } from '../../lib/utils'

interface LayoutProps {
  children: React.ReactNode
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [switchModalVisible, setSwitchModalVisible] = useState(false)
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [systemVersion, setSystemVersion] = useState<string>('')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout, switchInfo, switchToUser, exitSwitch, refreshSwitchStatus } = useAuth()

  useEffect(() => {
    // If super admin, periodically check switch status
    if (user?.is_super_admin) {
      const interval = setInterval(() => {
        refreshSwitchStatus()
      }, 30000) // Check every 30 seconds
      return () => clearInterval(interval)
    }
  }, [user?.is_super_admin, refreshSwitchStatus])

  useEffect(() => {
    // Get system version information
    const fetchSystemVersion = async () => {
      try {
        const systemInfo = await configApi.getSystemInfo()
        console.log('System info:', systemInfo)
        // Backend returns 'version' field, not 'app_version'
        const version = (systemInfo as any).version || systemInfo.app_version
        if (version) {
          setSystemVersion(`v${version}`)
        } else {
          console.log('No version in system info')
        }
      } catch (error) {
        console.error('Failed to fetch system version:', error)
      }
    }

    fetchSystemVersion()
  }, [])

  const menuItems = [
    {
      key: '/dashboard',
      icon: LayoutDashboard,
      label: t('nav.dashboard'),
    },
    {
      key: '/online-test',
      icon: TestTube,
      label: t('nav.onlineTest'),
    },
    {
      key: '/results',
      icon: FileSearch,
      label: t('nav.results'),
    },
    {
      key: '/reports',
      icon: BarChart3,
      label: t('nav.reports'),
    },
    {
      key: '/applications',
      icon: Grid3x3,
      label: t('nav.applications'),
    },
    {
      key: '/security-gateway',
      icon: Shield,
      label: t('nav.securityGateway'),
    },
    {
      key: '/config',
      icon: Settings,
      label: t('nav.config'),
      children: [
        {
          key: '/config/official-scanners',
          label: t('scannerPackages.officialScanners'),
        },
        {
          key: '/config/custom-scanners',
          label: t('customScanners.title'),
        },
        {
          key: '/config/sensitivity-thresholds',
          label: t('config.sensitivity'),
        },
        {
          key: '/config/data-security',
          label: t('config.dataSecurity'),
        },
        {
          key: '/config/ban-policy',
          label: t('config.banPolicy'),
        },
        {
          key: '/config/blacklist',
          label: t('config.blacklist'),
        },
        {
          key: '/config/whitelist',
          label: t('config.whitelist'),
        },
        {
          key: '/config/responses',
          label: t('config.template'),
        },
        {
          key: '/config/knowledge-bases',
          label: t('config.knowledge'),
        },
      ],
    },
    // Subscription & Usage (for all users in SaaS mode)
    ...(features.showSubscription()
      ? [
          {
            key: '/subscription',
            icon: Grid3x3,
            label: t('nav.subscription'),
          },
        ]
      : []),
    {
      key: '/documentation',
      icon: Book,
      label: t('nav.documentation'),
    },
    // Admin menu - Only super admins can see (placed at bottom)
    ...(user?.is_super_admin
      ? [
          {
            key: '/admin',
            icon: Settings,
            label: t('nav.admin'),
            children: [
              {
                key: '/admin/users',
                label: t('nav.tenantManagement'),
              },
              {
                key: '/admin/rate-limits',
                label: t('nav.rateLimiting'),
              },
              // Subscription management only in SaaS mode
              ...(features.showSubscription()
                ? [
                    {
                      key: '/admin/subscriptions',
                      label: t('nav.subscriptionManagement'),
                    },
                  ]
                : []),
              // Package marketplace only in SaaS mode
              ...(features.showMarketplace()
                ? [
                    {
                      key: '/admin/package-marketplace',
                      label: t('nav.packageMarketplace'),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
  ]

  const handleMenuClick = (key: string) => {
    navigate(key)
    setMobileMenuOpen(false)
  }

  const getSelectedKeys = () => {
    const path = location.pathname
    if (path.startsWith('/config') || path.startsWith('/admin') || path.startsWith('/security-gateway')) {
      return [path]
    }
    if (path === '/' || path === '/') {
      return ['/dashboard']
    }
    return [path.startsWith('/') ? path : '/platform' + path]
  }

  const getOpenKeys = () => {
    const path = location.pathname
    if (path.startsWith('/config')) {
      return ['/config']
    }
    if (path.startsWith('/admin')) {
      return ['/admin']
    }
    return []
  }

  const loadUsers = async () => {
    if (!user?.is_super_admin) return

    setLoading(true)
    try {
      const response = await adminApi.getUsers()
      setUsers(response.users || [])
    } catch (error) {
      console.error('Failed to load users:', error)
      toast.error(t('layout.loadUsersError'))
    } finally {
      setLoading(false)
    }
  }

  const handleSwitchUser = async (userId: string) => {
    try {
      await switchToUser(userId)
      setSwitchModalVisible(false)
      toast.success(t('layout.switchSuccess'))
      // Refresh current page
      window.location.reload()
    } catch (error) {
      console.error('Switch user failed:', error)
      toast.error(t('layout.switchError'))
    }
  }

  const handleExitSwitch = async () => {
    try {
      await exitSwitch()
      toast.success(t('layout.exitSwitchSuccess'))
      // Refresh current page
      window.location.reload()
    } catch (error) {
      console.error('Exit switch failed:', error)
      toast.error(t('layout.exitSwitchError'))
    }
  }

  const showSwitchModal = () => {
    setSwitchModalVisible(true)
    loadUsers()
  }

  const selectedKeys = getSelectedKeys()
  const openKeys = getOpenKeys()

  // User section at bottom of sidebar
  const UserSection = ({ isMobile = false }: { isMobile?: boolean }) => (
    <div className="border-t border-slate-200">
      {/* Tenant switch status */}
      {switchInfo.is_switched && !collapsed && (
        <div className="px-3 py-2 bg-orange-50 border-b border-orange-200">
          <p className="text-xs text-orange-600 mb-1">{t('layout.switchedTo')}</p>
          <p className="text-xs text-orange-900 font-medium truncate">{switchInfo.target_user?.email}</p>
          <Button variant="ghost" size="sm" onClick={handleExitSwitch} className="w-full mt-2 h-7 text-xs text-orange-700 hover:text-orange-900 hover:bg-orange-100">
            <RefreshCw className="h-3 w-3 mr-1" />
            {t('layout.exitSwitch')}
          </Button>
        </div>
      )}

      {/* User info section */}
      <Collapsible open={userMenuOpen} onOpenChange={setUserMenuOpen}>
        <CollapsibleTrigger className="w-full">
          <div className={cn('flex items-center gap-3 px-3 py-3 hover:bg-slate-100 transition-colors cursor-pointer', collapsed && 'justify-center')}>
            <div className="h-9 w-9 rounded-full bg-blue-600 flex items-center justify-center text-white flex-shrink-0">
              <User className="h-5 w-5" />
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium text-slate-900 truncate">{user?.email}</p>
                <div className="flex items-center gap-1 mt-0.5">
                  {user?.is_super_admin && <span className="px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-700 border border-red-200">{t('layout.admin')}</span>}
                  {systemVersion && <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-100 text-slate-600 border border-slate-200">{systemVersion}</span>}
                </div>
              </div>
            )}
            {!collapsed && <ChevronDown className={cn('h-4 w-4 text-slate-500 transition-transform', userMenuOpen && 'rotate-180')} />}
          </div>
        </CollapsibleTrigger>

        {!collapsed && (
          <CollapsibleContent>
            <div className="bg-slate-50 border-t border-slate-200">
              {/* Account */}
              <button onClick={() => navigate('/account')} className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:text-slate-900 hover:bg-slate-100 transition-colors flex items-center gap-2">
                <User className="h-4 w-4" />
                {t('nav.account')}
              </button>

              {/* Super admin switch user */}
              {user?.is_super_admin && !switchInfo.is_switched && (
                <button onClick={showSwitchModal} className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:text-slate-900 hover:bg-slate-100 transition-colors flex items-center gap-2">
                  <RefreshCw className="h-4 w-4" />
                  {t('layout.switchUser')}
                </button>
              )}

              <div className="border-t border-slate-200" />

              {/* Language Switcher */}
              <div className="px-4 py-2.5">
                <LanguageSwitcher />
              </div>

              <div className="border-t border-slate-200" />

              {/* Logout */}
              <button
                onClick={() => {
                  logout()
                  navigate('/login')
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-red-600 hover:text-red-700 hover:bg-red-50 transition-colors flex items-center gap-2"
              >
                <LogOut className="h-4 w-4" />
                {t('nav.logout')}
              </button>
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  )

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className={cn('bg-white border-r border-slate-200 transition-all duration-300 flex flex-col', collapsed ? 'w-16' : 'w-64', 'hidden lg:flex')}>
        {/* Logo + Collapse Toggle */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200">
          <div
            className="flex items-center gap-2 cursor-pointer flex-1 min-w-0"
            onClick={() => {
              if (collapsed) {
                setCollapsed(false)
              } else {
                navigate('/dashboard')
              }
            }}
          >
            <img src="/platform/logo-dark.png" alt="Logo" className="h-8 w-8 flex-shrink-0" />
            {!collapsed && <span className="font-bold text-lg text-slate-900 truncate">OpenGuardrails</span>}
          </div>
          {!collapsed && (
            <Button variant="ghost" size="sm" onClick={() => setCollapsed(true)} className="text-slate-500 hover:text-slate-700 hover:bg-slate-100 h-8 w-8 p-0 flex-shrink-0">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto py-4 px-2">
          {menuItems.map((item) => {
            if (item.children) {
              const isOpen = openKeys.includes(item.key)
              return (
                <Collapsible key={item.key} defaultOpen={isOpen}>
                  <CollapsibleTrigger className="w-full">
                    <div
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer mb-1',
                        selectedKeys.some((k) => k.startsWith(item.key)) ? 'bg-blue-50 text-blue-700' : 'text-slate-700'
                      )}
                    >
                      {item.icon && <item.icon className="h-5 w-5 flex-shrink-0" />}
                      {!collapsed && (
                        <>
                          <span className="flex-1 text-left text-sm font-medium">{item.label}</span>
                          <ChevronDown className="h-4 w-4" />
                        </>
                      )}
                    </div>
                  </CollapsibleTrigger>
                  {!collapsed && (
                    <CollapsibleContent>
                      <div className="ml-8 space-y-1 mb-1">
                        {item.children.map((child) => (
                          <div
                            key={child.key}
                            onClick={() => handleMenuClick(child.key)}
                            className={cn(
                              'px-3 py-2 rounded-md hover:bg-slate-100 transition-colors cursor-pointer text-sm',
                              selectedKeys.includes(child.key) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:text-slate-900'
                            )}
                          >
                            {child.label}
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              )
            }

            const Icon = item.icon
            return (
              <div
                key={item.key}
                onClick={() => handleMenuClick(item.key)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer mb-1',
                  selectedKeys.includes(item.key) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 hover:text-slate-900'
                )}
              >
                {Icon && <Icon className="h-5 w-5 flex-shrink-0" />}
                {!collapsed && <span className="text-sm font-medium">{item.label}</span>}
              </div>
            )
          })}
        </nav>

        {/* User Section at Bottom */}
        <UserSection />
      </aside>

      {/* Mobile Sidebar */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fixed inset-0 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
          <aside className="fixed left-0 top-0 bottom-0 w-64 bg-white flex flex-col">
            <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <img src="/platform/logo-dark.png" alt="Logo" className="h-8 w-8" />
                <span className="font-bold text-lg text-slate-900">OpenGuardrails</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setMobileMenuOpen(false)} className="text-slate-500">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <nav className="flex-1 overflow-y-auto py-4 px-2">
              {menuItems.map((item) => {
                if (item.children) {
                  const isOpen = openKeys.includes(item.key)
                  return (
                    <Collapsible key={item.key} defaultOpen={isOpen}>
                      <CollapsibleTrigger className="w-full">
                        <div
                          className={cn(
                            'flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer mb-1',
                            selectedKeys.some((k) => k.startsWith(item.key)) ? 'bg-blue-50 text-blue-700' : 'text-slate-700'
                          )}
                        >
                          {item.icon && <item.icon className="h-5 w-5 flex-shrink-0" />}
                          <span className="flex-1 text-left text-sm font-medium">{item.label}</span>
                          <ChevronDown className="h-4 w-4" />
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="ml-8 space-y-1 mb-1">
                          {item.children.map((child) => (
                            <div
                              key={child.key}
                              onClick={() => handleMenuClick(child.key)}
                              className={cn(
                                'px-3 py-2 rounded-md hover:bg-slate-100 transition-colors cursor-pointer text-sm',
                                selectedKeys.includes(child.key) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:text-slate-900'
                              )}
                            >
                              {child.label}
                            </div>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )
                }

                const Icon = item.icon
                return (
                  <div
                    key={item.key}
                    onClick={() => handleMenuClick(item.key)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer mb-1',
                      selectedKeys.includes(item.key) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 hover:text-slate-900'
                    )}
                  >
                    {Icon && <Icon className="h-5 w-5 flex-shrink-0" />}
                    <span className="text-sm font-medium">{item.label}</span>
                  </div>
                )
              })}
            </nav>
            <UserSection isMobile />
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 lg:px-6 flex-shrink-0">
          {/* Left side - Mobile menu & Title */}
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setMobileMenuOpen(true)}>
              <MenuIcon className="h-5 w-5" />
            </Button>
            <h1 className="text-lg font-bold text-slate-900">{t('common.appName')}</h1>
          </div>

          {/* Right side - Actions */}
          <div className="flex items-center gap-2 lg:gap-3">
            {/* Application Selector */}
            <ApplicationSelector />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="bg-white rounded-md border border-slate-200 p-6 shadow-sm">
            {children}
          </div>
        </main>
      </div>

      {/* Tenant switch Dialog */}
      <Dialog open={switchModalVisible} onOpenChange={setSwitchModalVisible}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{t('layout.switchTenant')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{t('layout.selectTenantPrompt')}</p>
            <Select onValueChange={handleSwitchUser}>
              <SelectTrigger>
                <SelectValue placeholder={t('layout.selectTenantPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <div className="flex items-center justify-between w-full">
                      <span>{u.email}</span>
                      <div className="flex gap-1">
                        {u.is_super_admin && <span className="px-2 py-0.5 text-xs rounded bg-red-100 text-red-800">{t('layout.admin')}</span>}
                        {u.is_verified ? (
                          <span className="px-2 py-0.5 text-xs rounded bg-green-100 text-green-800">{t('layout.verified')}</span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800">{t('layout.unverified')}</span>
                        )}
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500">{t('layout.switchNote')}</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Layout
