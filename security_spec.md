# GramaMitra Firestore Security Specification

## 1. Data Invariants
- Every `/users/{userId}` profile document belongs exclusively to `request.auth.uid == userId` with verified email (`request.auth.token.email_verified == true`), fixed role `'citizen'`, and server-enforced `createdAt` / `updatedAt` timestamps.
- Every `/users/{userId}/customers/{customerId}` record can only be read, created, updated, or deleted by its verified parent owner (`request.auth.uid == userId`), where the parent `/users/{userId}` profile exists, `ownerId == request.auth.uid`, and once `status == 'completed'` no further non-admin mutations are permitted.
- No unauthenticated or unverified account may read or write PII (`email`, `phone`, `village`, `fullName`).
- All string lengths, numeric ranges (`age` 1..120, `annualIncome` 0..10000000, `landAcres` 0..500), enums, and allowed keys (`hasOnly`) are strictly enforced on create and update.

## 2. Adversarial Payloads ("Dirty Dozen")
1. **Unauthenticated Customer Read**: `GET /users/uid1/customers/cust1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: `CREATE /users/uid1/customers/cust1` with `auth.token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Cross-User PII Read**: `GET /users/uid2/customers/cust1` by `uid1` -> `PERMISSION_DENIED`.
4. **Cross-User Customer List Scraping**: `LIST /users/uid2/customers` by `uid1` -> `PERMISSION_DENIED`.
5. **Identity Spoofing on Create**: `CREATE /users/uid1/customers/cust1` with `ownerId: "uid2"` -> `PERMISSION_DENIED`.
6. **Self-Assigned Admin/Privileged Role**: `CREATE /users/uid1` with `role: "admin"` -> `PERMISSION_DENIED`.
7. **Shadow / Ghost Field Injection**: `CREATE /users/uid1/customers/cust1` with extra key `isVerified: true` -> `PERMISSION_DENIED`.
8. **Invalid Document ID Poisoning**: `CREATE /users/uid1/customers/bad$id!!` -> `PERMISSION_DENIED`.
9. **String Oversize Attack**: `CREATE /users/uid1/customers/cust1` with `notes` > 400 chars -> `PERMISSION_DENIED`.
10. **Client Timestamp Forgery**: `CREATE /users/uid1/customers/cust1` with backdated `createdAt` != `request.time` -> `PERMISSION_DENIED`.
11. **Immutable Owner/CreatedAt Tampering**: `UPDATE /users/uid1/customers/cust1` modifying `ownerId` or `createdAt` -> `PERMISSION_DENIED`.
12. **Terminal State Violation**: `UPDATE /users/uid1/customers/cust1` after `existing().status == 'completed'` -> `PERMISSION_DENIED`.
