# Security Policy

## Sensitive Files

Do not commit:

- `.env`
- API keys
- bot tokens
- admin credentials
- SQLite database files
- user chat logs
- user uploads
- generated private images
- email verification codes
- production deployment paths

## Reporting Security Issues

If you find a security issue, please report it through GitHub Security Advisories or open an issue with limited technical detail.

Do not publicly disclose exploitable vulnerabilities before they are reviewed.

## Production Notice

This project is an open-source experimental AI companion framework.

Before using it in production, you should review and implement:

- authentication hardening
- rate limiting
- database backup and recovery
- admin access control
- safety moderation
- privacy compliance
- AI-generated content labeling
- log redaction
- secret management
