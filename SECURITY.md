# OpenGuardrails Platform - Security Guide

## 🛡️ Security Overview

The OpenGuardrails Platform employs multi-layered security measures to ensure system reliability and safety.  
This document provides detailed guidance for secure configuration and deployment.

## 🔐 Security Features

### 1. User Authentication
- **UUID User ID**: Uses UUIDs instead of sequential numeric IDs to prevent user enumeration attacks  
- **JWT Authentication**: Uses JSON Web Tokens for user identity verification  
- **Password Hashing**: Securely hashes passwords with bcrypt  
- **Brute-Force Protection**: Implements IP and email-based login rate limiting  

### 2. API Security
- **API Key Authentication**: Supports service-level authentication via API keys  
- **Rate Limiting**: Prevents API abuse and DOS attacks  
- **CORS Configuration**: Configurable Cross-Origin Resource Sharing policies  

### 3. Data Security
- **Database Encryption**: Encrypts sensitive data at rest  
- **Transport Encryption**: Supports HTTPS for encrypted data transmission  
- **Audit Logging**: Provides comprehensive operation tracking  

## ⚙️ Security Configuration

### 1. Basic Security Settings

#### JWT Secret Configuration
```bash
# Generate a secure JWT secret
openssl rand -base64 64

# Set it in your .env file
JWT_SECRET_KEY=YOUR_GENERATED_SECURE_KEY_HERE
````

#### Administrator Account Configuration

```bash
# Change the default admin credentials
SUPER_ADMIN_USERNAME=admin@yourdomain.com
SUPER_ADMIN_PASSWORD=YourSecurePassword123!
```

#### Database Security Configuration

```bash
# Use a strong password
DATABASE_URL=postgresql://username:secure_password@localhost:5432/database
```

### 2. Login Security Configuration

Default brute-force protection:

* **Time Window**: 15 minutes
* **Max Attempts**: 5
* **Rate Limit Scope**: IP address + Email address

Adjustable parameters in code:

```python
# In utils/user.py, within the check_login_rate_limit function
time_window_minutes=15,  # Time window
max_attempts=5           # Maximum attempts
```

### 3. CORS Security Configuration

Specify allowed domains for production:

```bash
# Development environment
CORS_ORIGINS=*

# Production environment
CORS_ORIGINS=https://yourdomain.com,https://api.yourdomain.com
```

## 🚀 Secure Deployment Guide

### 1. Production Deployment Checklist

#### 🔒 Configuration Security

* [ ] Change default admin username and password
* [ ] Generate a secure JWT secret
* [ ] Set a strong database password
* [ ] Specify production CORS origins
* [ ] Disable debug mode (DEBUG=false)
* [ ] Configure proper SMTP settings

#### 🌐 Network Security

* [ ] Enable HTTPS (recommended: Let’s Encrypt)
* [ ] Configure firewall rules
* [ ] Restrict database port access
* [ ] Set up a reverse proxy (Nginx/Apache)

#### 📁 File Permissions

* [ ] Set `.env` file permissions to 600
* [ ] Ensure correct log directory permissions
* [ ] Limit application user privileges

#### 🔍 Monitoring and Auditing

* [ ] Enable access logging
* [ ] Configure error log monitoring
* [ ] Set up abnormal login alerts
* [ ] Conduct regular security reviews

### 2. Security Check Tool

Run the built-in security check tool:

```bash
cd backend
python scripts/security_check.py
```

The tool checks:

* JWT secret strength
* Admin account configuration
* Database security settings
* CORS configuration
* File permissions
* Debug mode status

### 3. Database Migration

If upgrading from an older version, run the UUID migration:

```bash
# Backup the database
cp data/guardrails.db data/guardrails.db.backup

# Run migration script
python migrations/migrate_to_uuid.py
```

**Note:** The script automatically backs up your database, but manual backups of critical data are strongly recommended.

## 🛠️ Security Maintenance

### 1. Regular Security Tasks

#### Weekly

* [ ] Check for system updates
* [ ] Review access logs
* [ ] Inspect for abnormal login attempts

#### Monthly

* [ ] Run the security check tool
* [ ] Clean old login attempt records
* [ ] Update dependency packages

#### Quarterly

* [ ] Rotate JWT secret keys
* [ ] Audit user permissions
* [ ] Test backup and recovery

### 2. Incident Response

If a security issue is discovered:

1. **Immediate Response**: Record issue details
2. **Isolate Threat**: Suspend affected services
3. **Impact Analysis**: Assess data breach risks
4. **Patch Vulnerabilities**: Apply security fixes
5. **Restore Services**: Verify that patches work correctly
6. **Postmortem Review**: Improve future security controls

## 📞 Security Contact

If you discover vulnerabilities or have security concerns, please contact:

* **Email**: [thomas@openguardrails.com](mailto:thomas@openguardrails.com)
* **Project**: [https://github.com/openguardrails/openguardrails](https://github.com/openguardrails/openguardrails)

## 📚 Security Best Practices

### 1. Password Security

* Use strong passwords (min. 12 characters, including uppercase, lowercase, numbers, and symbols)
* Change passwords regularly
* Avoid password reuse
* Consider using a password manager

### 2. Access Control

* Follow the principle of least privilege
* Periodically review user permissions
* Remove inactive users promptly
* Enable two-factor authentication (if available)

### 3. System Maintenance

* Keep the system and dependencies updated
* Regularly back up important data
* Monitor resource usage
* Configure log rotation

### 4. Network Security

* Use HTTPS for secure transmission
* Apply appropriate firewall rules
* Utilize CDN and DDoS protection
* Perform regular security scans

## 🔄 Secure Version Updates

When upgrading the system:

1. Review release notes for security-related updates
2. Test updates in a staging environment
3. Back up production data
4. Verify configuration against the security checklist
5. Run the security check tool

## 📋 Security Compliance

The platform adheres to the following security standards and best practices:

* OWASP Top 10 Web Application Security Risks
* ISO 27001 Information Security Management Standard

---

**Disclaimer:**
This guide provides recommended security practices but does not guarantee absolute security.
Users should tailor security policies to their specific environments and stay informed of emerging security threats.
