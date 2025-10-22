# 数据库Migration指南

## 概述

OpenGuardrails现在使用自动化的数据库migration系统来管理数据库架构变更。

## Migration系统特性

✅ **自动执行**: 应用启动时自动运行未执行的migrations
✅ **版本跟踪**: 通过`schema_migrations`表跟踪已执行的migrations
✅ **幂等性**: 所有migrations使用`IF NOT EXISTS`/`IF EXISTS`保证幂等性
✅ **顺序执行**: 按版本号顺序执行migrations
✅ **错误处理**: Migration失败时停止执行并记录错误
✅ **独立运行**: 可以独立运行migrations，无需启动应用

## 目录结构

```
backend/
├── migrations/
│   ├── README.md                 # Migration系统文档
│   ├── create_migration.sh       # 创建新migration的脚本
│   ├── run_migrations.py         # Migration运行器
│   └── versions/                 # Migration SQL文件
│       ├── 001_add_ban_policy_tables.sql
│       ├── 002_add_tenant_kb_disable_table.sql
│       └── ...
```

## 创建新的Migration

### 方法1: 使用脚本（推荐）

```bash
cd backend/migrations
./create_migration.sh "add_user_preferences_table"
```

这会自动创建一个新的migration文件，包含版本号和模板。

### 方法2: 手动创建

1. 在`backend/migrations/versions/`目录下创建新文件
2. 文件命名格式: `{version}_{description}.sql`
   - 例如: `003_add_user_preferences.sql`
3. 编写SQL语句

### Migration文件示例

```sql
-- Migration: Add user preferences table
-- Version: 003
-- Date: 2025-01-21
-- Author: Your Name

-- Description:
-- Adds a table to store user-specific preferences and settings

CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    preference_key VARCHAR(100) NOT NULL,
    preference_value TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT user_preferences_unique UNIQUE (tenant_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_tenant_id
ON user_preferences(tenant_id);

COMMENT ON TABLE user_preferences IS 'Stores user-specific preferences and settings';
COMMENT ON COLUMN user_preferences.preference_key IS 'Preference key identifier';
COMMENT ON COLUMN user_preferences.preference_value IS 'Preference value (JSON or text)';
```

## Migration最佳实践

### 1. 幂等性 (Idempotent)

**总是**使用`IF NOT EXISTS`/`IF EXISTS`:

```sql
-- ✓ 正确
CREATE TABLE IF NOT EXISTS my_table (...);
CREATE INDEX IF NOT EXISTS idx_name ON my_table(column);
ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_column VARCHAR(100);

-- ✗ 错误
CREATE TABLE my_table (...);  -- 重复运行会失败
```

### 2. 增量变更

每个migration只做一件事：

```sql
-- ✓ 正确 - 专注于单个功能
-- Migration: Add email notification preferences
CREATE TABLE IF NOT EXISTS email_preferences (...);

-- ✗ 错误 - 混合多个不相关的变更
CREATE TABLE IF NOT EXISTS email_preferences (...);
CREATE TABLE IF NOT EXISTS user_avatars (...);
ALTER TABLE tenants ADD COLUMN phone_number VARCHAR(20);
```

### 3. 向后兼容

确保migration不会破坏现有功能：

```sql
-- ✓ 正确 - 添加可选列
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'UTC';

-- ⚠️ 注意 - 添加NOT NULL列需要默认值
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

-- ✗ 危险 - 删除列可能破坏现有代码
-- ALTER TABLE tenants DROP COLUMN IF EXISTS old_field;  -- 需要谨慎评估
```

### 4. 添加注释

为表和列添加描述性注释：

```sql
COMMENT ON TABLE my_table IS 'Stores user preferences for the application';
COMMENT ON COLUMN my_table.status IS 'Current status: active, inactive, or pending';
```

### 5. 索引优化

为查询频繁的列添加索引：

```sql
-- 单列索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 复合索引（注意列的顺序）
CREATE INDEX IF NOT EXISTS idx_logs_tenant_date ON logs(tenant_id, created_at DESC);

-- 部分索引（仅索引特定条件的行）
CREATE INDEX IF NOT EXISTS idx_active_users ON users(email) WHERE is_active = true;
```

## 运行Migrations

### 自动运行（启动时）

Migrations会在应用启动时自动运行（仅在admin-service中）：

```bash
docker-compose up
# 或
python3 start_admin_service.py
```

你会看到日志输出：

```
Running database migrations...
Found 2 pending migration(s):
  - 001: add_ban_policy_tables
  - 002: add_tenant_kb_disable_table
Executing migration 001: add_ban_policy_tables
✓ Migration 001 completed successfully
Executing migration 002: add_tenant_kb_disable_table
✓ Migration 002 completed successfully
Database migrations completed: 2 migration(s) executed
```

### 手动运行

```bash
cd backend
python3 migrations/run_migrations.py
```

### 预览待执行的Migrations（Dry Run）

```bash
cd backend
python3 migrations/run_migrations.py --dry-run
```

## Migration跟踪表

系统使用`schema_migrations`表跟踪已执行的migrations：

```sql
SELECT * FROM schema_migrations ORDER BY version;
```

| version | description              | filename                          | executed_at         | success | error_message |
|---------|--------------------------|-----------------------------------|---------------------|---------|---------------|
| 1       | add_ban_policy_tables    | 001_add_ban_policy_tables.sql    | 2025-01-21 10:00:00 | true    | null          |
| 2       | add_tenant_kb_disable_table | 002_add_tenant_kb_disable_table.sql | 2025-01-21 10:00:01 | true    | null          |

## 常见问题

### Q: Migration失败了怎么办？

1. 查看错误日志
2. 修复migration SQL文件中的问题
3. 从`schema_migrations`表中删除失败的记录：
   ```sql
   DELETE FROM schema_migrations WHERE version = X;
   ```
4. 重新运行migration

### Q: 如何回滚migration？

目前系统不支持自动回滚。如需回滚：

1. 手动编写回滚SQL（建议在migration文件注释中包含回滚SQL）
2. 手动执行回滚SQL
3. 从`schema_migrations`表中删除记录

### Q: 可以修改已执行的migration吗？

**不要修改已执行的migration**。如需变更：

1. 创建新的migration来应用变更
2. 这保证了migration历史的一致性

### Q: 开发环境vs生产环境

- **开发环境**: 可以使用`RESET_DATABASE_ON_STARTUP=true`重置数据库
- **生产环境**: **必须**设置`RESET_DATABASE_ON_STARTUP=false`，仅依赖migrations

## 环境变量配置

在`docker-compose.yml`或`.env`中：

```yaml
environment:
  # 开发环境：每次启动时重置数据库（会丢失所有数据）
  - RESET_DATABASE_ON_STARTUP=true

  # 生产环境：保留数据，仅运行新的migrations
  - RESET_DATABASE_ON_STARTUP=false
```

## 迁移到新系统

现有项目迁移步骤：

1. 确保当前数据库已经运行了所有手动SQL脚本
2. 新的migration系统会自动创建`schema_migrations`表
3. 首次运行时，系统会执行所有在`versions/`目录中的migrations
4. 已经手动执行过的migrations会再次执行，但由于使用了`IF NOT EXISTS`，不会有影响

## 示例工作流

### 添加新功能需要数据库变更

1. **创建migration**:
   ```bash
   cd backend/migrations
   ./create_migration.sh "add_notification_settings"
   ```

2. **编辑migration文件**:
   ```sql
   -- Migration: Add notification settings
   -- Version: 003

   CREATE TABLE IF NOT EXISTS notification_settings (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       email_enabled BOOLEAN DEFAULT true,
       sms_enabled BOOLEAN DEFAULT false,
       created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
   );
   ```

3. **本地测试**:
   ```bash
   python3 migrations/run_migrations.py --dry-run  # 预览
   python3 migrations/run_migrations.py             # 执行
   ```

4. **更新代码**: 添加使用新表的Python代码

5. **提交到Git**:
   ```bash
   git add backend/migrations/versions/003_add_notification_settings.sql
   git add backend/database/models.py  # 如果有模型变更
   git commit -m "Add notification settings table"
   ```

6. **部署**: 应用启动时会自动运行新的migration

## 总结

✅ Migration系统现在完全自动化
✅ 首次启动会自动执行所有pending migrations
✅ 使用版本号管理，按顺序执行
✅ 支持幂等性，可以安全地重复运行
✅ 记录执行历史，便于追踪

**记住**: 始终在migration中使用`IF NOT EXISTS`/`IF EXISTS`来保证幂等性！
