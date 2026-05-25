#!/usr/bin/env python3
"""
Security check and repair script
Check common security configuration issues and provide repair suggestions
"""

import os
import sys
import secrets
import hashlib
from pathlib import Path

# Add parent directory to path
sys.path.append(str(Path(__file__).parent.parent))

from config import settings

def generate_secure_jwt_key():
    """Generate secure JWT key"""
    return secrets.token_urlsafe(64)

def generate_secure_password(length=16):
    """Generate secure random password"""
    import string
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def check_jwt_security():
    """Check JWT configuration security"""
    issues = []
    
    # Check JWT key length and complexity
    if len(settings.jwt_secret_key) < 32:
        issues.append({
            'level': 'HIGH',
            'category': 'JWT',
            'issue': 'JWT key length is too short',
            'description': f'The current JWT key length is {len(settings.jwt_secret_key)} characters, it is recommended to be at least 64 characters',
            'fix': f'建议使用: {generate_secure_jwt_key()}'
        })
    
    # Check if using default key
    weak_keys = [
        'openguardrails-jwt-secret-key-2024',
        'your-secret-key',
        'secret',
        'jwt-secret'
    ]
    
    if settings.jwt_secret_key in weak_keys:
        issues.append({
            'level': 'CRITICAL',
            'category': 'JWT',
            'issue': 'Using default or weak JWT key',
            'description': 'The current key is default or known weak key',
            'fix': f'Please replace with secure key: {generate_secure_jwt_key()}'
        })
    
    return issues

def check_admin_security():
    """Check admin account security"""
    issues = []
    
    # Check default admin password
    weak_passwords = [
        'admin',
        'password',
        '123456',
        'openguardrails@2024',
        'admin123'
    ]
    
    if settings.super_admin_password in weak_passwords:
        issues.append({
            'level': 'CRITICAL',
            'category': 'Admin',
            'issue': 'Using default or weak admin password',
            'description': 'The current admin password is too simple and容易被破解',
            'fix': f'Suggest replacing with strong password: {generate_secure_password()}'
        })
    
    # Check admin username
    if settings.super_admin_username == 'admin':
        issues.append({
            'level': 'MEDIUM',
            'category': 'Admin',
            'issue': 'Using default admin username',
            'description': 'Using default username increases the risk of attack',
            'fix': 'Suggest replacing with custom email address'
        })
    
    return issues

def check_database_security():
    """Check database security"""
    issues = []
    
    # Check database URL if it contains weak password
    db_url = settings.database_url
    if 'password' in db_url.lower() or '123456' in db_url:
        issues.append({
            'level': 'HIGH',
            'category': 'Database',
            'issue': 'Database password may be too simple',
            'description': 'Database connection string may contain weak password',
            'fix': 'Use strong password and consider using environment variables'
        })
    
    return issues

def check_cors_security():
    """Check CORS configuration security"""
    issues = []
    
    if settings.cors_origins == "*":
        issues.append({
            'level': 'MEDIUM',
            'category': 'CORS',
            'issue': 'CORS configuration is too宽松',
            'description': 'Allowing all sources to access may带来安全风险',
            'fix': 'Suggest configuring specific domains, such as: https://yourdomain.com'
        })
    
    return issues

def check_debug_mode():
    """Check debug mode"""
    issues = []
    
    if settings.debug:
        issues.append({
            'level': 'MEDIUM',
            'category': 'Debug',
            'issue': 'Production environment开启了调试模式',
            'description': 'Debug mode may泄露敏感信息',
            'fix': 'Production environment请设置 DEBUG=false'
        })
    
    return issues

def check_smtp_security():
    """Check SMTP configuration security"""
    issues = []
    
    if settings.smtp_password and settings.smtp_password in ['your-email-password', 'password']:
        issues.append({
            'level': 'HIGH',
            'category': 'SMTP',
            'issue': 'Using default SMTP password',
            'description': 'SMTP password is not correctly configured',
            'fix': 'Configure correct email password'
        })
    
    return issues

def check_file_permissions():
    """Check critical file permissions"""
    issues = []
    
    # Check .env file permissions
    env_file = Path(__file__).parent.parent / '.env'
    if env_file.exists():
        stat_info = env_file.stat()
        # Check if it is readable by other users
        if stat_info.st_mode & 0o044:  # Other users or groups can read
            issues.append({
                'level': 'HIGH',
                'category': 'File Permissions',
                'issue': '.env file permissions are too宽松',
                'description': '.env file contains sensitive information, it should not be readable by other users',
                'fix': f'Run: chmod 600 {env_file}'
            })
    
    return issues

def check_api_key_security():
    """Check API key security"""
    issues = []
    
    if settings.guardrails_model_api_key == 'your-model-api-key':
        issues.append({
            'level': 'MEDIUM',
            'category': 'API Key',
            'issue': 'Model API key is not configured',
            'description': 'Using default placeholder may cause service to not work properly',
            'fix': 'Configure correct model API key'
        })
    
    return issues

def generate_security_report():
    """Generate security check report"""
    print("=" * 60)
    print("OpenGuardrails Platform - Security check report")
    print("=" * 60)
    
    all_issues = []
    
    # Perform各项检查
    checks = [
        ('JWT security', check_jwt_security),
        ('Admin account security', check_admin_security),
        ('Database security', check_database_security),
        ('CORS configuration', check_cors_security),
        ('Debug mode', check_debug_mode),
        ('SMTP configuration', check_smtp_security),
        ('File permissions', check_file_permissions),
        ('API key security', check_api_key_security),
    ]
    
    for check_name, check_func in checks:
        print(f"\n📋 Check: {check_name}")
        issues = check_func()
        
        if not issues:
            print("✅ No security issues found")
        else:
            for issue in issues:
                all_issues.append(issue)
                level_emoji = {'CRITICAL': '🔴', 'HIGH': '🟠', 'MEDIUM': '🟡', 'LOW': '🟢'}
                print(f"{level_emoji.get(issue['level'], '⚪')} {issue['level']}: {issue['issue']}")
                print(f"   Description: {issue['description']}")
                print(f"   Fix suggestion: {issue['fix']}")
                print()
    
    # Generate report
    print("\n" + "=" * 60)
    print("Security check summary")
    print("=" * 60)
    
    if not all_issues:
        print("🎉 Congratulations! No security issues found.")
        return True
    
    critical_count = len([i for i in all_issues if i['level'] == 'CRITICAL'])
    high_count = len([i for i in all_issues if i['level'] == 'HIGH'])
    medium_count = len([i for i in all_issues if i['level'] == 'MEDIUM'])
    low_count = len([i for i in all_issues if i['level'] == 'LOW'])
    
    print(f"🔴 Critical issues: {critical_count}")
    print(f"🟠 High risk issues: {high_count}")
    print(f"🟡 Medium risk issues: {medium_count}")
    print(f"🟢 Low risk issues: {low_count}")
    print(f"📊 Total: {len(all_issues)} issues")
    
    if critical_count > 0:
        print("\n⚠️  Warning: Critical security issues found, please fix immediately!")
        return False
    elif high_count > 0:
        print("\n⚠️  Warning: High risk security issues found, please fix as soon as possible.")
        return False
    else:
        print("\n✅ No critical security issues found, but it is recommended to fix medium and low risk issues to improve security.")
        return True

def generate_secure_env_template():
    """Generate secure .env template"""
    print("\n" + "=" * 60)
    print("Generate secure configuration template")
    print("=" * 60)
    
    template = f"""# Application configuration
APP_NAME=OpenGuardrails
APP_VERSION=1.0.0
DEBUG=false

# Super admin configuration
# ⚠️ Please make sure to change the default admin username and password!
SUPER_ADMIN_USERNAME=admin@yourdomain.com
SUPER_ADMIN_PASSWORD={generate_secure_password(20)}

# Data directory configuration
DATA_DIR=~/openguardrails-data

# Database configuration
# ⚠️ Please use a strong password
DATABASE_URL=postgresql://openguardrails:YOUR_SECURE_DB_PASSWORD@localhost:54321/openguardrails

# Model configuration
GUARDRAILS_MODEL_API_URL=http://localhost:58002/v1
GUARDRAILS_MODEL_API_KEY=your-actual-model-api-key
GUARDRAILS_MODEL_NAME=OpenGuardrails-Text

# API configuration
# ⚠️ In production environment, please configure specific domains
CORS_ORIGINS=https://yourdomain.com

# Logging configuration
LOG_LEVEL=INFO

# JWT configuration
# ⚠️ Use a secure random key
JWT_SECRET_KEY={generate_secure_jwt_key()}
JWT_ALGORITHM=HS256
JWT_ACCESS_TOKEN_EXPIRE_MINUTES=1440

# Email configuration
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-email@gmail.com
SMTP_PASSWORD=your-secure-email-password
SMTP_USE_TLS=true
SMTP_USE_SSL=false

# Server configuration
UVICORN_WORKERS=4
MAX_CONCURRENT_REQUESTS=100
"""
    
    print("🔐 Secure .env configuration template:")
    print(template)
    
    # Save to file
    template_file = Path(__file__).parent.parent / '.env.secure.template'
    with open(template_file, 'w') as f:
        f.write(template)
    
    print(f"✅ Template saved to: {template_file}")
    print("📋 Please update your .env file according to the template")

def main():
    print("🛡️  OpenGuardrails Platform - Security check tool")
    print("This tool will check common security configuration issues and provide repair suggestions\n")
    
    # Generate security check report
    is_secure = generate_security_report()
    
    # Generate secure configuration template
    generate_secure_env_template()
    
    print("\n" + "=" * 60)
    print("Security recommendations")
    print("=" * 60)
    print("1. 🔐 Update JWT key and admin password regularly")
    print("2. 🔒 Deploy production environment using HTTPS")
    print("3. 🌐 Configure firewall to limit unnecessary port access")
    print("4. 📊 Enable access log monitoring")
    print("5. 🔄 Backup database regularly")
    print("6. 📱 Consider enabling two-factor authentication (2FA)")
    print("7. 🛡️  Run this security check tool regularly")
    
    if not is_secure:
        print("\n❌ Security check failed, please fix the issues and run again.")
        sys.exit(1)
    else:
        print("\n✅ Security check passed!")
        sys.exit(0)

if __name__ == "__main__":
    main()