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
  Book,
  Grid3x3,
  ChevronDown,
  Menu as MenuIcon,
  X,
  Shield,
  ShieldAlert,
  ChevronLeft,
  CreditCard,
  Users,
  Layers,
  ListFilter,
  MessageSquareText,
  Cable,
  Network,
  ClipboardList,
  Target,
  MessageCircle,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { adminApi, configApi } from '../../services/api'
import LanguageSwitcher from '../LanguageSwitcher/LanguageSwitcher'
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
    if (user?.is_super_admin) {
      const interval = setInterval(() => {
        refreshSwitchStatus()
      }, 30000)
      return () => clearInterval(interval)
    }
  }, [user?.is_super_admin, refreshSwitchStatus])

  useEffect(() => {
    const fetchSystemVersion = async () => {
      try {
        const systemInfo = await configApi.getSystemInfo()
        const version = (systemInfo as any).version || systemInfo.app_version
        if (version) {
          setSystemVersion(`v${version}`)
        }
      } catch (error) {
        console.error('Failed to fetch system version:', error)
      }
    }
    fetchSystemVersion()
  }, [])

  interface MenuItem {
    key: string
    icon?: LucideIcon
    label: string
    children?: { key: string; label: string }[]
  }

  interface MenuSection {
    label: string
    items: MenuItem[]
  }

  const menuSections: MenuSection[] = [
    {
      label: t('nav.sectionDiscover'),
      items: [
        { key: '/dashboard', icon: LayoutDashboard, label: t('nav.dashboard') },
        { key: '/applications/list', icon: Grid3x3, label: t('nav.applicationList') },
        { key: '/applications/workspaces', icon: Layers, label: t('nav.workspaces') },
        { key: '/connection/models', icon: Cable, label: t('nav.modelConnection') },
        { key: '/connection/gateway', icon: Network, label: t('nav.gatewayConnection') },
      ],
    },
    {
      label: t('nav.sectionSecure'),
      items: [
        { key: '/config/guardrails', icon: Shield, label: t('nav.guardrails') },
        { key: '/config/data-masking', icon: ShieldAlert, label: t('nav.dataMasking') },
        { key: '/config/keyword-list', icon: ListFilter, label: t('config.keywordList') },
        { key: '/config/answers', icon: MessageSquareText, label: t('config.answers') },
        { key: '/security-gateway/policy', icon: Settings, label: t('nav.securityPolicy') },
        { key: '/security-gateway/appeals', icon: AlertTriangle, label: t('nav.falsePositiveAppeal') },
      ],
    },
    {
      label: t('nav.sectionRedTeaming'),
      items: [
        { key: '/redteaming/chat', icon: MessageCircle, label: t('nav.chatTesting') },
        { key: '/redteaming/campaigns', icon: Target, label: t('nav.attackCampaigns') },
      ],
    },
    {
      label: t('nav.sectionGovern'),
      items: [
        { key: '/results', icon: FileSearch, label: t('nav.logs') },
        { key: '/reports', icon: BarChart3, label: t('nav.reports') },
        { key: '/audit-log', icon: ClipboardList, label: t('nav.auditLog') },
      ],
    },
    {
      label: t('nav.sectionSettings'),
      items: [
        { key: '/team', icon: Users, label: t('nav.team') },
        ...(features.showSubscription()
          ? [{ key: '/subscription', icon: CreditCard, label: t('nav.subscription') }]
          : []),
        { key: '/documentation', icon: Book, label: t('nav.documentation') },
        ...(user?.is_super_admin
          ? [
              {
                key: '/admin',
                icon: Users,
                label: t('nav.admin'),
                children: [
                  { key: '/admin/users', label: t('nav.tenantManagement') },
                  ...(features.showRateLimits()
                    ? [{ key: '/admin/rate-limits', label: t('nav.rateLimiting') }]
                    : []),
                  ...(features.showSubscription()
                    ? [{ key: '/admin/subscriptions', label: t('nav.subscriptionManagement') }]
                    : []),
                  ...(features.showMarketplace()
                    ? [{ key: '/admin/package-marketplace', label: t('nav.packageMarketplace') }]
                    : []),
                  { key: '/admin/guardrail-upload', label: t('nav.guardrailUpload') },
                  { key: '/admin/retention', label: t('nav.retention') },
                ],
              },
            ]
          : []),
      ],
    },
  ]

  const handleMenuClick = (key: string) => {
    navigate(key)
    setMobileMenuOpen(false)
  }

  const getSelectedKey = () => {
    const path = location.pathname
    if (path === '/' || path === '') return '/dashboard'
    if (path === '/applications' || path === '/applications/') return '/applications/list'
    return path
  }

  const getOpenKeys = () => {
    const path = location.pathname
    if (path.startsWith('/admin')) return ['/admin']
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

  const selectedKey = getSelectedKey()
  const openKeys = getOpenKeys()

  const renderMenuItem = (item: MenuItem, isMobile = false) => {
    const isActive = selectedKey === item.key || selectedKey.startsWith(item.key + '/')
    const Icon = item.icon

    if (item.children) {
      const isOpen = openKeys.includes(item.key)
      const isChildActive = selectedKey.startsWith(item.key)
      return (
        <Collapsible key={item.key} defaultOpen={isOpen}>
          <CollapsibleTrigger className="w-full">
            <div
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer mb-0.5',
                isChildActive
                  ? 'text-sky-400'
                  : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
              )}
            >
              {Icon && <Icon className="h-[18px] w-[18px] flex-shrink-0" />}
              {(!collapsed || isMobile) && (
                <>
                  <span className="flex-1 text-left text-[13px] font-medium">{item.label}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              )}
            </div>
          </CollapsibleTrigger>
          {(!collapsed || isMobile) && (
            <CollapsibleContent>
              <div className="ml-8 space-y-0.5 mb-0.5">
                {item.children.map((child) => {
                  const isChildItemActive = selectedKey === child.key
                  return (
                    <div
                      key={child.key}
                      onClick={() => handleMenuClick(child.key)}
                      className={cn(
                        'px-3 py-1.5 rounded-md transition-colors cursor-pointer text-[13px]',
                        isChildItemActive
                          ? 'text-sky-400 bg-sky-400/10 font-medium'
                          : 'text-muted-foreground hover:text-slate-300 hover:bg-white/5'
                      )}
                    >
                      {child.label}
                    </div>
                  )
                })}
              </div>
            </CollapsibleContent>
          )}
        </Collapsible>
      )
    }

    return (
      <div
        key={item.key}
        onClick={() => handleMenuClick(item.key)}
        className={cn(
          'flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer mb-0.5 group',
          isActive
            ? 'bg-sky-400/10 text-sky-400 font-medium'
            : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
        )}
      >
        {Icon && (
          <Icon className={cn(
            'h-[18px] w-[18px] flex-shrink-0 transition-colors',
            isActive ? 'text-sky-400' : 'text-muted-foreground group-hover:text-slate-300'
          )} />
        )}
        {(!collapsed || isMobile) && <span className="text-[13px]">{item.label}</span>}
      </div>
    )
  }

  const SidebarNav = ({ isMobile = false }: { isMobile?: boolean }) => (
    <nav className="flex-1 overflow-y-auto py-3 px-2">
      {menuSections.map((section, sectionIdx) => (
        <div key={section.label}>
          {sectionIdx > 0 && <div className="my-3 mx-2 border-t border-white/5" />}
          {(!collapsed || isMobile) && (
            <div className="px-3 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">
              {section.label}
            </div>
          )}
          {collapsed && !isMobile && sectionIdx > 0 && <div className="my-1" />}
          {section.items.map((item) => renderMenuItem(item, isMobile))}
        </div>
      ))}
    </nav>
  )

  const UserSection = ({ isMobile = false }: { isMobile?: boolean }) => (
    <div className="border-t border-white/5">
      {switchInfo.is_switched && !collapsed && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20">
          <p className="text-[10px] text-amber-400 mb-1">{t('layout.switchedTo')}</p>
          <p className="text-xs text-amber-300 font-medium truncate">{switchInfo.target_user?.email}</p>
          <Button variant="ghost" size="sm" onClick={handleExitSwitch} className="w-full mt-2 h-7 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10">
            <RefreshCw className="h-3 w-3 mr-1" />
            {t('layout.exitSwitch')}
          </Button>
        </div>
      )}

      <Collapsible open={userMenuOpen} onOpenChange={setUserMenuOpen}>
        <CollapsibleTrigger className="w-full">
          <div className={cn(
            'flex items-center gap-3 px-3 py-3 hover:bg-white/5 transition-colors cursor-pointer',
            collapsed && !isMobile && 'justify-center'
          )}>
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center text-white flex-shrink-0">
              <User className="h-4 w-4" />
            </div>
            {(!collapsed || isMobile) && (
              <div className="flex-1 min-w-0 text-left">
                <p className="text-[13px] font-medium text-slate-200 truncate">{user?.email}</p>
                <div className="flex items-center gap-1 mt-0.5">
                  {user?.is_super_admin && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded bg-red-500/15 text-red-400 border border-red-500/20 font-medium">
                      {t('layout.admin')}
                    </span>
                  )}
                  {systemVersion && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded bg-white/5 text-muted-foreground border border-white/10">
                      {systemVersion}
                    </span>
                  )}
                </div>
              </div>
            )}
            {(!collapsed || isMobile) && (
              <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', userMenuOpen && 'rotate-180')} />
            )}
          </div>
        </CollapsibleTrigger>

        {(!collapsed || isMobile) && (
          <CollapsibleContent>
            <div className="bg-white/[0.02] border-t border-white/5">
              <button onClick={() => navigate('/account')} className="w-full px-4 py-2.5 text-left text-[13px] text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors flex items-center gap-2">
                <User className="h-4 w-4" />
                {t('nav.account')}
              </button>

              {user?.is_super_admin && !switchInfo.is_switched && (
                <button onClick={showSwitchModal} className="w-full px-4 py-2.5 text-left text-[13px] text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors flex items-center gap-2">
                  <RefreshCw className="h-4 w-4" />
                  {t('layout.switchUser')}
                </button>
              )}

              <div className="border-t border-white/5" />

              <div className="px-4 py-2.5">
                <LanguageSwitcher />
              </div>

              <div className="border-t border-white/5" />

              <button
                onClick={() => {
                  logout()
                  navigate('/login')
                }}
                className="w-full px-4 py-2.5 text-left text-[13px] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors flex items-center gap-2"
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
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className={cn(
        'bg-[hsl(225,35%,8%)] border-r border-white/[0.06] transition-all duration-300 flex flex-col',
        collapsed ? 'w-16' : 'w-60',
        'hidden lg:flex'
      )}>
        {/* Logo */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-white/[0.06]">
          <div
            className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0"
            onClick={() => {
              if (collapsed) setCollapsed(false)
              else navigate('/dashboard')
            }}
          >
            <img src="/platform/logo-dark.png" alt="Logo" className="h-7 w-7 flex-shrink-0" />
            {!collapsed && (
              <span className="font-bold text-[15px] text-white tracking-tight truncate">
                OpenGuardrails
              </span>
            )}
          </div>
          {!collapsed && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed(true)}
              className="text-muted-foreground hover:text-slate-300 hover:bg-white/5 h-7 w-7 p-0 flex-shrink-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>

        <SidebarNav />
        <UserSection />
      </aside>

      {/* Mobile Sidebar */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)} />
          <aside className="fixed left-0 top-0 bottom-0 w-60 bg-[hsl(225,35%,8%)] flex flex-col">
            <div className="h-14 flex items-center justify-between px-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-2.5">
                <img src="/platform/logo-dark.png" alt="Logo" className="h-7 w-7" />
                <span className="font-bold text-[15px] text-white tracking-tight">OpenGuardrails</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setMobileMenuOpen(false)} className="text-slate-500 hover:text-white hover:bg-white/5">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <SidebarNav isMobile />
            <UserSection isMobile />
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-14 bg-[hsl(225,30%,10%)] border-b border-white/[0.06] flex items-center justify-between px-4 lg:px-6 flex-shrink-0">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" className="lg:hidden text-slate-500 hover:text-white hover:bg-white/5" onClick={() => setMobileMenuOpen(true)}>
              <MenuIcon className="h-5 w-5" />
            </Button>
            <h1 className="text-[15px] font-semibold text-slate-200">{t('common.appName')}</h1>
          </div>
          <div className="flex items-center gap-2 lg:gap-3">
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-hidden p-4 lg:p-5 min-h-0">
          <div className="bg-card rounded-lg border border-border p-5 h-full min-h-0 overflow-y-auto">
            {children}
          </div>
        </main>
      </div>

      {/* Tenant switch Dialog */}
      <Dialog open={switchModalVisible} onOpenChange={setSwitchModalVisible}>
        <DialogContent className="sm:max-w-[600px] bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">{t('layout.switchTenant')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('layout.selectTenantPrompt')}</p>
            <Select onValueChange={handleSwitchUser}>
              <SelectTrigger className="bg-secondary border-border text-foreground">
                <SelectValue placeholder={t('layout.selectTenantPlaceholder')} />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <div className="flex items-center justify-between w-full">
                      <span className="text-foreground">{u.email}</span>
                      <div className="flex gap-1 ml-2">
                        {u.is_super_admin && <span className="og-badge-high">{t('layout.admin')}</span>}
                        {u.is_verified ? (
                          <span className="og-badge-safe">{t('layout.verified')}</span>
                        ) : (
                          <span className="og-badge-medium">{t('layout.unverified')}</span>
                        )}
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('layout.switchNote')}</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Layout
