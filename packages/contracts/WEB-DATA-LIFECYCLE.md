# Web material data lifecycle: product copy template and release decisions

**Template status:** review draft for product/security and affected maintainers. It is not a currently deployed policy. Replace every `[release decision]` with an approved value and implementation evidence before publishing to users. The M1 API skeleton has no upload or deletion behavior.

## Suggested user-facing copy

> When you upload a file to BondBuddy Web, an account-isolated copy is stored on our servers in private cloud storage. Your browser copy is not the only copy. We process the uploaded file in the cloud to check its type and integrity, parse content, perform OCR where needed, and run the task you request. Some necessary content may be sent from our server to the selected model provider to complete that task; we will identify the provider and relevant processing terms in the published privacy notice. We do not put model credentials in your browser or add your private materials to a shared reference library by default.
>
> We encrypt material in transit and at rest, limit access by account and service role, and log authorized access. A file is saved only after our server verifies its bytes and hash; an upload progress bar reaching 100% does not mean the file is saved. Closing the page does not cancel a submitted server task. After logging in again, you can view that task and any checked deliverable you are authorized to download.
>
> Your project files and results are retained for **[release decision: active-project and post-deletion duration]**. You can request deletion through **[release decision: UI/action and support path]**. We remove active copies and dependent diagnostic copies under **[release decision: deletion service-level objective]**. Encrypted backups expire or are purged within **[release decision: backup maximum lifetime and purge method]**; deletion markers are reapplied after restore. We will disclose any legal retention exception and its scope. Temporary provider-side retention follows **[release decision: approved provider terms and region]**. You can obtain the current retention and deletion details in **[release decision: policy link]**.

## Implementation and release checklist

- Choose storage region, private container, encryption and key management; verify account owner checks on metadata, object association, download, logs and deletion. Do not claim encryption or deletion as live until tested on deployed infrastructure.
- Approve retention separately for original materials, parsed/OCR derivatives, generated Word, project data, prompt snapshots, operations/call metadata, temporary export URLs and backups. Spec 16.9 offers diagnostic defaults (prompt 30 days, structured logs 180 days, aggregates 365 days, backups at most 30 days, export links 24 hours), but these are design defaults and do not settle production durations for every material class.
- Define deletion behavior for a file still pinned by an immutable active run: remove the current draft reference immediately, then purge physical bytes only after the run and mandatory retention constraints permit. Record status and deadlines visibly; never silently mutate a running snapshot.
- Verify upload abort/retry, server save, retention expiry, backup restore plus deletion replay, account closure and controlled provider processing with authorized synthetic or consented samples. Keep evidence with the release issue, not in public client code.
