# Frontend Migration Progress

> **Migration**: Ant Design → Tailwind CSS + Shadcn/ui (Enterprise SaaS Style)
> **Started**: 2025-12-28
> **Status**: 🚧 In Progress (Stage 1-4 Complete, 1 Auth Page Done)

---

## Overview

### Objective
Complete frontend rewrite from React + Ant Design to React + Tailwind CSS + Shadcn/ui with **Stripe/Linear/AWS enterprise SaaS** aesthetics.

### Strategy
- **Approach**: One-time full rewrite (not gradual migration)
- **Scope**: 27 page components + 5 reusable components (~15,154 lines)
- **Design**: Professional enterprise SaaS (Stripe/Linear style)
- **Timeline**: ~36 working days (estimated)

### Tech Stack Migration

| Component | From | To |
|-----------|------|-----|
| UI Framework | Ant Design 5.12.0 | **Removed** |
| Styling | CSS Modules | Tailwind CSS 3.4.17 |
| Components | Ant Design | Shadcn/ui (Radix UI + Tailwind) |
| Icons | @ant-design/icons | lucide-react |
| Forms | Ant Design Form | React Hook Form + Zod |
| Notifications | message API | sonner (toast) |
| Tables | Ant Design Table | TanStack Table (pending) |
| Date Utils | dayjs | date-fns |

---

## Design System

### Color Palette (Stripe/Linear Style)

**Light Mode:**
```css
Primary:       #0070f3  (Stripe Blue)
Main Text:     #0f172a  (Slate 900)
Secondary Text:#64748b  (Slate 500)
Borders:       #e2e8f0  (Slate 200)
Background:    #ffffff  (White)
Muted BG:      #f1f5f9  (Slate 100)
```

**Dark Mode:**
```css
Primary:       hsl(211 100% 55%)  (Brighter Blue)
Main Text:     #f8fafc  (Slate 50)
Secondary Text:#94a3b8  (Slate 400)
Borders:       #202938  (Dark Slate)
Background:    #0d111a  (Deep Slate)
```

### Design Principles
- ✅ Solid colors (no gradients except login page)
- ✅ 6-8px border radius (enterprise standard)
- ✅ Subtle shadows (no colored glows)
- ✅ Higher information density
- ✅ Professional blue for CTAs
- ✅ Black/white/gray for hierarchy

---

## Progress Tracking

### ✅ Stage 1: Foundation (Days 1-2) - COMPLETE

**Branch**: `migration/tailwind-shadcn`

**Completed Tasks:**
- [x] Created migration branch
- [x] Installed Tailwind CSS 3.4.17 (fixed 4.x version issue)
- [x] Configured PostCSS (CommonJS format)
- [x] Created tailwind.config.js with Shadcn theme
- [x] Installed core dependencies:
  - @tanstack/react-table
  - react-hook-form, @hookform/resolvers, zod
  - date-fns, react-day-picker
  - sonner
  - lucide-react
  - Radix UI primitives (12 packages)
- [x] Created src/lib/utils.ts (cn helper)
- [x] Updated vite.config.ts (@ path alias)
- [x] Configured enterprise SaaS colors in index.css
- [x] Added Inter font to index.html
- [x] Installed Radix UI components

**Key Files Created:**
```
frontend/
├── tailwind.config.js
├── postcss.config.js
├── src/
│   ├── index.css (enterprise SaaS colors)
│   └── lib/
│       └── utils.ts
```

**Commits:**
- `feat(frontend): 初始化 Tailwind CSS + Shadcn/ui (第一阶段)`
- `fix(frontend): 修复 Tailwind CSS 版本问题` (locked to 3.4.17)
- `style(frontend): 更新配色为 Stripe/Linear 企业级 SaaS 风格`

**Issues Resolved:**
- ❌ **Tailwind CSS 4.x Error**: npm installed 4.1.18 instead of 3.x
  - **Fix**: Uninstalled and reinstalled `tailwindcss@3.4.17`
  - **Verification**: Checked node_modules/tailwindcss/package.json
- ❌ **PostCSS Config Error**: ES module format incompatible
  - **Fix**: Changed to CommonJS (`module.exports`)

---

### ✅ Stage 2: Core Components (Days 3-5) - COMPLETE

**Base UI Components Created:**
- [x] Button (6 variants: default, destructive, outline, secondary, ghost, link)
- [x] Card (full family: Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter)
- [x] Input
- [x] Label
- [x] Badge (7 variants: default, secondary, destructive, outline, success, warning, danger)
- [x] Form (React Hook Form integration)
- [x] Dialog (replaces Ant Design Modal)
- [x] Alert (with AlertTitle, AlertDescription)

**Utility Files Created:**
- [x] src/lib/validators.ts (Zod schemas for auth forms)

**Demo Page:**
- [x] src/pages/TailwindDemo.tsx (accessible at `/platform/tailwind-demo`)

**Integration:**
- [x] Added Toaster to src/main.tsx

**Key Files:**
```
frontend/src/
├── components/ui/
│   ├── button.tsx
│   ├── card.tsx
│   ├── input.tsx
│   ├── label.tsx
│   ├── badge.tsx
│   ├── form.tsx
│   ├── dialog.tsx
│   └── alert.tsx
└── lib/
    └── validators.ts
```

---

### ✅ Stage 3: First Page Migration (Days 6-8) - COMPLETE

**Migrated Pages:**
- [x] **Login.tsx** (267 lines, completely rewritten)

**Migration Details:**

**Before:**
```typescript
// Ant Design components
import { Form, Input, Button, message, Modal } from 'antd'
import { MailOutlined, LockOutlined } from '@ant-design/icons'

// Ant Design Form
<Form onFinish={handleSubmit}>
  <Form.Item name="email" rules={[...]}>
    <Input prefix={<MailOutlined />} />
  </Form.Item>
</Form>
```

**After:**
```typescript
// Shadcn/ui components + React Hook Form
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Mail, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// React Hook Form + Zod
const form = useForm<LoginFormData>({
  resolver: zodResolver(loginSchema),
})

<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)}>
    <FormField
      control={form.control}
      name="email"
      render={({ field }) => (
        <FormItem>
          <FormControl>
            <Input {...field} />
          </FormControl>
        </FormItem>
      )}
    />
  </form>
</Form>
```

**Features Preserved:**
- ✅ Email/password validation
- ✅ Error handling with toast notifications
- ✅ Email verification alert
- ✅ Password change modal
- ✅ i18n support (English/Chinese)
- ✅ Gradient background (Tailwind)
- ✅ Responsive design

**Commit:**
- `feat(frontend): 迁移 Login 页面到 Tailwind CSS + Shadcn/ui`

**Backup:**
- Created `Login.tsx.old` for reference

---

## ✅ Stage 4: Remaining Components (Days 9-11) - COMPLETE

**Components Created:**
- [x] Select (dropdown with search) - Radix UI Select primitive
- [x] Textarea (multi-line input)
- [x] Switch (toggle) - Radix UI Switch
- [x] Tabs (tab navigation) - Radix UI Tabs
- [x] Sheet (drawer/side panel) - Radix UI Dialog for drawer
- [x] Table (base table components)
- [x] **DataTable** (CRITICAL - for Results page)
  - Based on TanStack Table
  - Server-side pagination
  - Custom page size selection
  - Loading states
  - Empty state handling
  - Responsive design
- [x] Calendar (date picker) - react-day-picker
- [x] Popover (dropdown container) - Radix UI Popover
- [x] DateRangePicker (for Results page filters)
  - Date range selection with calendar
  - Two-month view
  - Formatted display

**Commits:**
- `feat(frontend): 创建剩余 UI 组件 (Stage 4)`
- `feat(frontend): 添加 Calendar, Popover 和 DateRangePicker 组件`

**Status**: All core UI components now available for page migration!

---

## 🚧 Stage 5: Authentication Pages (Days 12-15) - IN PROGRESS

**Pages to Migrate:**
- [x] **Register.tsx** (multi-step form) - COMPLETE
  - Two-step process: Registration + Email verification
  - React Hook Form with Zod validation
  - Strong password validation (uppercase, lowercase, number)
  - Countdown timer for resend code
  - Custom step indicator (not using Ant Design Steps)
  - All functionality preserved
  - Gradient background
- [ ] Verify.tsx (email verification)
- [ ] ForgotPassword.tsx (password reset request)
- [ ] ResetPassword.tsx (password reset form)

**Commit:**
- `feat(frontend): 迁移 Register 页面到 Tailwind CSS + Shadcn/ui`

**Progress**: 1/4 auth pages complete (25%)

---

## 📋 Stage 6: Dashboard (Days 16-17) - PENDING

**File**: `src/pages/Dashboard/Dashboard.tsx`

**Key Changes:**
- Ant Design Row/Col → Tailwind Grid
- Ant Design Statistic → Custom Card components
- Preserve ECharts integration (no changes needed)

**Layout Example:**
```typescript
// Old
<Row gutter={[16, 16]}>
  <Col xs={24} sm={12} md={6}>
    <Card><Statistic /></Card>
  </Col>
</Row>

// New
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
  <Card className="hover:shadow-md transition-shadow cursor-pointer">
    <CardHeader>
      <CardTitle>Total Requests</CardTitle>
    </CardHeader>
    <CardContent>
      <div className="text-3xl font-bold">{stats.total_requests}</div>
    </CardContent>
  </Card>
</div>
```

---

## 📋 Stage 7: Results Page (Days 18-21) - PENDING

**File**: `src/pages/Results/Results.tsx` (850 lines, **most complex**)

**Components Needed:**
- DataTable (with pagination, sorting)
- Select (risk level, category filters)
- DateRangePicker (date filters)
- Sheet (detail drawer)
- Badge (risk levels)

**Key Features:**
- Filtering (risk level, category, date range, search)
- Server-side pagination
- Detail drawer with images
- Excel export

**Estimated**: 4 days

---

## 📋 Stage 8: Config Pages (Days 22-27) - PENDING

**10 Pages** (varying complexity):

1. **OfficialScannersManagement.tsx** (855 lines, second most complex)
   - 3 tabs (Built-in, Purchased, Marketplace)
   - Nested tables (packages → scanners)
   - Switch toggles for scanners
   - **Estimated**: 2 days

2. **CustomScannersManagement.tsx**
   - CRUD operations
   - **Estimated**: 1 day

3. **ApplicationManagement.tsx**
   - CRUD operations
   - API key management
   - **Estimated**: 1 day

4. **BlacklistManagement.tsx** / **WhitelistManagement.tsx**
   - Similar structure
   - Tag input for keywords
   - **Estimated**: 0.5 day each

5. **ResponseTemplateManagement.tsx**
   - Table + editor
   - **Estimated**: 0.5 day

6. **KnowledgeBaseManagement.tsx**
   - File upload + table
   - **Estimated**: 1 day

7. **BanPolicy.tsx**
   - Form configuration
   - **Estimated**: 0.5 day

8. **SensitivityThresholdManagement.tsx**
   - Form + Slider
   - **Estimated**: 0.5 day

9. **EntityTypeManagement.tsx**
   - Simple table
   - **Estimated**: 0.5 day

---

## 📋 Stage 9: Admin Pages (Days 28-30) - PENDING

**4 Pages:**

1. **UserManagement.tsx**
   - User CRUD
   - Switch user (super admin)
   - **Estimated**: 1 day

2. **RateLimitManagement.tsx**
   - Form configuration
   - **Estimated**: 0.5 day

3. **SubscriptionManagement.tsx** (SaaS mode)
   - Subscription tiers table
   - **Estimated**: 1 day

4. **PackageMarketplace.tsx** (SaaS mode)
   - Package upload
   - **Estimated**: 0.5 day

---

## 📋 Stage 10: Other Pages (Days 31-33) - PENDING

**5 Pages:**

1. **Account.tsx**
   - 3 tabs (Profile, API Keys, Password)
   - **Estimated**: 1 day

2. **Reports.tsx**
   - Statistics + charts
   - **Estimated**: 0.5 day

3. **OnlineTest.tsx**
   - Test interface
   - Image upload
   - **Estimated**: 1 day

4. **SecurityGateway.tsx**
   - Proxy configuration
   - **Estimated**: 0.5 day

5. **Documentation.tsx**
   - Simple content page
   - **Estimated**: 0.5 day

---

## 📋 Stage 11: Reusable Components (Days 34-35) - PENDING

**5 Components:**

1. **LanguageSwitcher.tsx**
   - Ant Design Dropdown → Shadcn DropdownMenu
   - **Estimated**: 0.5 day

2. **ApplicationSelector.tsx**
   - Ant Design Select → Shadcn Select
   - **Estimated**: 0.5 day

3. **ImageUpload.tsx**
   - Custom upload component
   - **Estimated**: 0.5 day

4. **PaymentButton.tsx**
   - Button with payment icons
   - **Estimated**: 0.25 day

5. **ProtectedRoute.tsx**
   - No UI changes (logic only)
   - **Estimated**: 0 day

---

## 📋 Stage 12: API Layer (Day 36) - PENDING

**Files to Update:**
- src/services/api.ts
- src/services/auth.ts
- src/services/payment.ts
- src/services/billing.ts

**Changes:**
- Replace all `message.success()` → `toast.success()`
- Replace all `message.error()` → `toast.error()`
- Replace all `message.warning()` → `toast.warning()`
- Replace all `message.loading()` → `toast.loading()`

**Estimated**: 1 day

---

## Testing Plan

### Functional Testing
- [ ] All 27 pages functional
- [ ] Authentication flow (login, register, verify, reset)
- [ ] Results filtering and pagination
- [ ] Config CRUD operations
- [ ] Admin operations
- [ ] API calls working
- [ ] i18n (English/Chinese)
- [ ] Docker deployment (`docker compose up -d`)

### Visual QA
- [ ] Enterprise SaaS aesthetics (Stripe/Linear style)
- [ ] Consistent spacing (24-32px between cards)
- [ ] Subtle shadows (not colored)
- [ ] 6-8px border radius
- [ ] Stripe Blue (#0070f3) for CTAs
- [ ] Inter font loaded
- [ ] No Ant Design remnants

### Accessibility
- [ ] Keyboard navigation
- [ ] Focus states visible
- [ ] WCAG AA contrast (4.5:1)
- [ ] Screen reader labels

### Performance
- [ ] Page load < 2s
- [ ] Bundle size < 500KB (gzipped)
- [ ] Table rendering 1000 rows < 1s

---

## Dependency Changes

### To Remove (After Migration Complete)
```json
{
  "antd": "^5.12.0",
  "@ant-design/icons": "^5.2.0",
  "dayjs": "^1.11.0"
}
```

### Added
```json
{
  "tailwindcss": "3.4.17",
  "postcss": "^8.4.49",
  "autoprefixer": "^10.4.20",
  "@tanstack/react-table": "^8.11.2",
  "react-hook-form": "^7.49.2",
  "@hookform/resolvers": "^3.3.3",
  "zod": "^3.22.4",
  "date-fns": "^3.0.6",
  "react-day-picker": "^8.10.0",
  "sonner": "^1.3.1",
  "lucide-react": "^0.303.0",
  "@radix-ui/react-dialog": "^1.0.5",
  "@radix-ui/react-dropdown-menu": "^2.0.6",
  "@radix-ui/react-label": "^2.0.2",
  "@radix-ui/react-select": "^2.0.0",
  "@radix-ui/react-slot": "^1.0.2",
  "@radix-ui/react-switch": "^1.0.3",
  "@radix-ui/react-tabs": "^1.0.4",
  "class-variance-authority": "^0.7.0",
  "clsx": "^2.1.0",
  "tailwind-merge": "^2.2.0",
  "tailwindcss-animate": "^1.0.7"
}
```

---

## Known Issues

### Resolved
- ✅ **Tailwind CSS 4.x incompatibility** - Locked to 3.4.17
- ✅ **PostCSS config format** - Changed to CommonJS
- ✅ **Color scheme too monotone** - Updated to Stripe/Linear colors

### Active
- None

---

## Git Workflow

**Branch**: `migration/tailwind-shadcn`

**Commit Conventions:**
- `feat(frontend): ` - New features/migrations
- `fix(frontend): ` - Bug fixes
- `style(frontend): ` - Styling changes
- `refactor(frontend): ` - Code refactoring

**Testing Before Merge:**
```bash
# Full reset test
docker compose down -v
docker compose up -d

# Check all services
docker ps
docker logs openguardrails-platform

# Verify frontend
curl http://localhost:3000/platform/
```

---

## Success Criteria

### Must Have
- [x] Tailwind CSS installed and working
- [x] Shadcn/ui components functional
- [x] Enterprise SaaS color scheme applied
- [ ] All 27 pages migrated
- [ ] All features working (auth, detection, config, admin)
- [ ] i18n preserved
- [ ] Docker one-click deployment working
- [ ] No Ant Design dependencies remaining
- [ ] No console errors
- [ ] No TypeScript errors

### Nice to Have
- [ ] Performance improvements
- [ ] Bundle size reduction
- [ ] Accessibility improvements
- [ ] Dark mode fully tested

---

## Resources

### Documentation
- [Tailwind CSS Docs](https://tailwindcss.com/docs)
- [Shadcn/ui Components](https://ui.shadcn.com/)
- [React Hook Form](https://react-hook-form.com/)
- [Zod](https://zod.dev/)
- [TanStack Table](https://tanstack.com/table/latest)
- [Radix UI](https://www.radix-ui.com/)

### Design References
- [Stripe Design System](https://stripe.com/design)
- [Linear Design](https://linear.app/)
- [AWS Console](https://console.aws.amazon.com/)
- [Vercel Dashboard](https://vercel.com/dashboard)

---

## Timeline Summary

| Stage | Days | Status |
|-------|------|--------|
| 1. Foundation | 1-2 | ✅ Complete |
| 2. Core Components | 3-5 | ✅ Complete |
| 3. Login Page | 6-8 | ✅ Complete |
| 4. Remaining Components | 9-11 | ✅ Complete |
| 5. Auth Pages | 12-15 | 🚧 In Progress (1/4 pages done) |
| 6. Dashboard | 16-17 | 🚧 Pending |
| 7. Results Page | 18-21 | 🚧 Pending |
| 8. Config Pages | 22-27 | 🚧 Pending |
| 9. Admin Pages | 28-30 | 🚧 Pending |
| 10. Other Pages | 31-33 | 🚧 Pending |
| 11. Reusable Components | 34-35 | 🚧 Pending |
| 12. API Layer | 36 | 🚧 Pending |

**Total Estimated**: 36 working days (single developer)
**Current Progress**: ~33% (12/36 days complete - Stages 1-4 done, Stage 5 started)

---

## Next Actions

### Immediate (Next)
1. ✅ ~~Create all UI components~~ - DONE
2. ✅ ~~Migrate Register.tsx~~ - DONE
3. Migrate Verify.tsx
4. Migrate ForgotPassword.tsx
5. Migrate ResetPassword.tsx

### Short Term (This Week)
1. Complete all auth pages (Verify, ForgotPassword, ResetPassword)
2. Migrate Dashboard page
3. Start Results page migration (now that DataTable is ready)

### Medium Term (Next Week)
1. Complete Results page (most complex, 850 lines)
2. Start config pages migration
3. Migrate OfficialScannersManagement (second most complex, 855 lines)

---

**Last Updated**: 2025-12-28 (Post Stage 4 & Register migration)
**Updated By**: Migration Team
**Next Review**: After Stage 4 completion
