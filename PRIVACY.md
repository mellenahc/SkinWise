# SkinWise privacy notice

**Operator:** Replace this line with the name and contact details of the person or organization operating this deployment before making the app available to users.

This notice describes the SkinWise MVP. Update it if the deployment, hosting, or data practices change. It is not a substitute for jurisdiction-specific legal review.

## Information stored

- Account email address and a salted scrypt password hash.
- Skin type, skin concerns, and products/periods saved in a user's routine.
- A hashed session token and its expiration date. The bearer token itself is kept by the app on the user's device.
- Product details required to associate a product with a routine.

The API uses request IP addresses transiently for rate limiting. Rate-limit counters and provider response caches are in-memory and expire; they are not intended as persistent analytics or activity history. Hosting providers may keep their own server, network, or database logs; check and disclose the actual retention settings for your deployment.

## How information is used and shared

Account and routine information is used to provide the profile and routine features. Product search terms are sent to The Beauty API. Scanned barcodes are sent to Open Beauty Facts to find matching product information. These providers have their own terms and privacy practices; review them before launch. SkinWise does not intentionally send account email, password, or saved routine data to those product providers.

## Retention and deletion

Account data is retained in the deployment database until the account is deleted or the operator removes it. Use **Delete account and data** in the profile screen, or call `DELETE /auth/account` with the account's bearer token, to delete the account, sessions, profile, and routines. Product records may remain because they are shared product data needed by routines; they do not contain account identifiers. Database backups and hosting logs may persist until their configured expiration.

## Security

Use HTTPS for all non-local traffic. Passwords are hashed; session tokens are stored hashed and expire after 30 days. These safeguards do not eliminate risk. Protect database backups and secrets, restrict production CORS origins, configure retention/access controls for infrastructure logs, and promptly apply security updates.

## Contact and user rights

Before release, provide the operator's real contact details above and add a process for privacy requests, complaints, and applicable access/correction requests. Explain any additional legal basis, international data transfers, or retention periods required by the laws applicable to your deployment.
