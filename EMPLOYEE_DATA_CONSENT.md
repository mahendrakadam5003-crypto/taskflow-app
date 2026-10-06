# Employee Attendance and Data Notice

**Template for employer review.** Complete the bracketed fields and have an Indian privacy/legal adviser and accountant review this notice before giving it to employees. This template is not legal advice or a determination of compliance with the Digital Personal Data Protection Act, 2023 or other applicable law.

## Organization and contact

- Employer / organization: `[legal entity name]`
- Purpose-specific contact: `[name, email, phone]`
- Data-protection or grievance contact: `[name and contact details]`
- Effective date / notice version: `[date and version]`

## What TaskFlow records

TaskFlow is used for attendance and work management. Depending on the features enabled, it records:

- Account details such as name, username, department, and role.
- Attendance punch-in and punch-out times.
- Device-reported GPS latitude and longitude at attendance punches, during live attendance tracking, and at task check-in/check-out when enabled. The address displayed for a coordinate is derived from that coordinate.
- Device and browser details, including phone/laptop category, a device name chosen during registration, and a derived browser/model label. The app requests browser model and platform-version client hints; it stores a derived device label rather than the complete raw User-Agent string.
- For native app sign-in, the device manufacturer/model and a SHA-256 hash of the platform device identifier. The original native identifier is not stored; this binding is used to limit each account to one registered app device until an administrator resets it. Browser login permission is controlled separately by the employer.
- Work records such as task comments, task history, reimbursement claims, receipts, and administrative activity records when those features are used.
- If an administrator requires attendance verification, the mobile app requests biometric confirmation and the server verifies a re-entered TaskFlow password before employee punch-in/out. The password is checked transiently and is not written to the attendance record.

GPS is **indicative only**. A user or mock-location tool can spoof it. It is not proof of physical presence and should not be the sole basis for disciplinary, payroll, or other consequential decisions.

Phone/laptop classification is inferred from browser-provided information and can be spoofed. The browser-generated device ID can also be copied; device registration is a policy check, not strong device authentication.

## Where data is stored and sent

- The configured database is stored in Turso when cloud database credentials are configured; a local SQLite database is used as a fallback.
- Attendance location points are sent as Telegram location messages when Telegram storage is configured. Receipt and comment attachments may also be stored in the configured Telegram channel.
- GPS coordinates are sent to OpenStreetMap Nominatim's reverse-geocoding service to obtain a readable location name.
- Administrators and employees explicitly granted tracking access can view live attendance locations and selected employees' location timelines. Individual timeline views are recorded in the activity log with the viewer, employee, and date.
- Tailscale or Render may provide network hosting/proxy services depending on the deployment.

Turso, Telegram, OpenStreetMap Nominatim, Render, and Tailscale are separate providers. Their processing and storage regions depend on the account, service plan, and configuration and may be outside India. The employer must confirm the actual regions, contractual terms, access controls, and any transfer requirements, then update this notice before use.

## Retention

Current application defaults are:

| Data | Retention |
| --- | --- |
| Exact attendance GPS points and Telegram location messages | 60 days. The app deletes Telegram messages where possible, then removes local points. If Telegram deletion fails, local coordinates are erased and a coordinate-free marker remains so deletion can be retried. |
| Exact punch-in/out and task check-in/out coordinates and location names | 60 days. Punch/check-in timestamps remain after coordinates are cleared. |
| Attendance and native app device/model details | 60 days for attendance device details. Native app model and device-binding hash remain while the app registration is active and are removed when an administrator resets the device or the account is deleted. |
| Reimbursement receipts, comment images, and other attachments | No automatic deletion by default (`0` days). An administrator may configure a finite period after review with the accountant. If configured, comment attachments are aged from comment creation and receipts from the expense date; references and metadata are cleared after file deletion succeeds. |
| Attendance punch times, activity log, task history, and comment text | No automatic expiry. They remain until removed through the employer's separate records-management process or as part of deletion of their parent records. |

The employer should review these periods regularly. Tax, accounting, employment, and privacy requirements may require a different period; obtain professional advice before changing retention settings or deleting records.

## Consent and employee acknowledgement

Please complete and retain this section with the employer's attendance/privacy records.

- [ ] I received and read this notice, including the listed purposes, data types, storage providers, and retention periods.
- [ ] I understand that reported GPS can be inaccurate or spoofed and is not proof of physical presence.
- [ ] I consent to the collection and use of my device-reported location for the attendance and task check-in features described above.
- [ ] I understand that data may be processed by the listed providers and that the employer must confirm their applicable storage/processing regions.

Employee name: `[name]`

Employee ID / username: `[identifier]`

Signature: `________________________________`

Date: `[date]`

Employer representative: `[name and role]`

Signature: `________________________________`

Date: `[date]`

Questions, access/correction requests, or withdrawal of consent: contact `[privacy or grievance contact]`. The employer should document how requests are handled and provide an appropriate alternative attendance process where required by law or policy.
