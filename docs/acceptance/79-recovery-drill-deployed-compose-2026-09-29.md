# #79 existing-service recovery rehearsal: synthetic Compose evidence

Code and image commit: `5a8e4bc3fcb2077bdb79beb0353540ff78d028b1`. Base `develop`: `33e9988bcb828a498d155a61f6745da31c6ee4a2`. This ran against an already started, disposable Compose stack with the API, background worker, ops scheduler, PostgreSQL 16 and Azurite 3.35 (`--skipApiVersionCheck`); the named API/worker/ops images reported the exact code commit. It is **not** a pre-release deployment result or supplier verification. No external model was called. The earlier isolated usage deduplication result remains separate in `79-recovery-drill-synthetic-2026-09-29.md`.

Preflight: 75 applied migrations, latest `0075_m1_generation_issuer_bindings.sql`; original evidence gate `open` at sequence 0; managed parse staging directories 0; other active jobs and external call attempts 0.

Only this run created user `74fce0b0-ebed-49e8-9507-5368bbc70b9f` and project `8796d61a-e0fd-4c1f-a6f6-4a3c9e6f040f`. D2 material `632d24ff-ee79-4197-87af-b0ea3440578a`; D3 material `dec720f7-1c5e-415a-b081-5d19b318e035`. All were synthetic text uploaded through the real API.

## D1: deployed scheduler backlog and replay

| Phase | Pending | Receipts | Unique sink keys |
| --- | ---: | ---: | ---: |
| `d1_before` | 0 | 0 | 0 |
| `d1_during` | 2 | 0 | 0 |
| `d1_after` | 0 | 2 | 2 |

Outbox IDs during and after: `5ad7dd5c-9d65-4a43-b29b-f0666f5ac54d`, `a6b45971-5dc5-434c-ad9d-ff3de0a6c063`. The same two IDs became receipts after the actual `ops` scheduler was resumed. Each corresponding key occurs once in the configured sink:

- `5ad7dd5c-9d65-4a43-b29b-f0666f5ac54d` → `5ee38e4e6367a7a005a99e9c00c87a812d499e2d63cbc9951b9129fdc40e9430` (sink count 1)
- `a6b45971-5dc5-434c-ad9d-ff3de0a6c063` → `bd72b8ac259725096f2afc26cc617c1a3ac16958d44e074cd7ee9604ddfe6321` (sink count 1)

One more scheduler interval left 2 receipts and 2 unique keys.

## D2: deployed parse worker crash and lease recovery

Job `a4e3ff61-76b1-4e6d-8baa-d115cd660d79`. The named worker container was killed once after this job reached `running`; its lease was recovered by the normal deployed worker. A trigger held only this material's snapshot insert long enough to observe the claimed job, then was removed.

| Phase | State | Attempts | Terminal events | Job outbox | Log outbox | Delivered log keys |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `d2_before` | `queued` | 0 | 0 | 1 | 1 | 0 |
| `d2_during` | `running` | 1 | 0 | 2 | 2 | 0 |
| `d2_after` | `succeeded` | 2 | 1 | 6 | 5 | 2 |
| `d2_logs_after` | `succeeded` | 2 | 1 | 6 | 5 | 5 |

`d2_before` job event IDs: `805d9d55-3abf-4213-978b-7e686adbfc8b`.
`d2_before` job outbox IDs: `1a6b2bb0-ca8e-4362-8377-3b178308d48b`.

`d2_during` job event IDs: `805d9d55-3abf-4213-978b-7e686adbfc8b`, `b534f34e-5187-4f8b-b19c-159202eb6aa3`.
`d2_during` job outbox IDs: `1a6b2bb0-ca8e-4362-8377-3b178308d48b`, `d7eacbbe-2954-47d5-84b5-db73cbdd2fe0`.

`d2_after` job event IDs: `805d9d55-3abf-4213-978b-7e686adbfc8b`, `b534f34e-5187-4f8b-b19c-159202eb6aa3`, `eda8efe4-dca9-4b7e-8fb0-3d844b027bae`, `5c52118f-91ff-4ea2-88b2-cd3312a31d5c`, `48231d2d-f211-4911-aa3f-2de4b92dc53c`.
`d2_after` job outbox IDs: `1a6b2bb0-ca8e-4362-8377-3b178308d48b`, `3262c687-649f-45f5-9ee4-1dbd8fdc58a7`, `386945dd-6352-49bc-baad-bb138c4e7705`, `81bafe1b-611f-42c2-993e-45fd796754b3`, `8d53ed82-b7e1-4b08-85c4-a3f6d2b45cb0`, `d7eacbbe-2954-47d5-84b5-db73cbdd2fe0`.

Final log outbox → delivery key (every key appears once in the deployed sink):

- `02520437-521f-41d7-86db-0e0046e3b762` → `a67d4c2d15f0f93064f69bb93766637d7839740c2e0c55298488ae778a2be505`
- `4b01782e-d510-40e4-a25a-b9f1edd837a5` → `e83f3bc8347747b9bfb3e8f98d880121b3206aa7ad14e12319cc8c6021eac436`
- `6cf1c3b9-6098-4d76-8370-f3bec8513ee1` → `2749d93fbbace5d0cbd9c02961bcd12fbbb8ae2beb51f80a645fd05d4b6877a8`
- `74653043-561b-433d-9ecc-731f7d1fe66b` → `f1c87a9dbf1e715a1c22ba4d5f023e6950898b9067b9366015d6eeb153ffb562`
- `cf03184b-12d3-4500-b573-b110f57000c4` → `21d1b1e118d5d1c05535a37f08af929be235fcb2508293e04fa580ac06bb463e`

The recorded crash left one managed staging directory; the existing safe sweeper removed that exact directory after the job reached a terminal state (1 → 0).

## D3: scoped transaction abort and normal retry

Job `dcfae4e8-f9a2-4a1e-8d41-c06dbce3fccf`. Trigger `bb_drill79_a0cb99a4197b` matched only this job's `material_parse.succeeded` outbox insert. It aborted the first two terminal transactions, with a bounded six-second wait on the second so the nonterminal state could be captured; its removal was recorded before the successful retry.

| Phase | State | Attempts | Terminal events | Job outbox | Log outbox | Delivered log keys |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `d3_before` | `queued` | 0 | 0 | 1 | 1 | 0 |
| `d3_during` | `running` | 2 | 0 | 6 | 6 | 0 |
| `d3_after` | `succeeded` | 3 | 1 | 9 | 10 | 0 |
| `d3_logs_after` | `succeeded` | 3 | 1 | 9 | 10 | 10 |

`d3_before` job event IDs: `36a4ddb8-cbac-4328-8634-85a32fd7ea36`.
`d3_before` job outbox IDs: `73a443b6-8471-42b1-bc63-8ab3d223352f`.

`d3_during` job event IDs: `36a4ddb8-cbac-4328-8634-85a32fd7ea36`, `e6328ac0-6ef0-4883-8dd3-a0fd1f7b1571`, `13bbb682-5855-4e2d-a730-a0d405cad736`, `6638df06-e156-46da-908b-25b430911a14`, `0f80b96c-93b2-4335-b5e5-5ade252a2cbf`.
`d3_during` job outbox IDs: `0c945e12-23bc-4e8f-bab5-299accc59aeb`, `0f33f565-50cc-4e6e-a354-d19e7df70018`, `408449f3-65c4-4f35-a6c6-2e038adf2f41`, `73a443b6-8471-42b1-bc63-8ab3d223352f`, `f5703205-55ed-4973-a3bb-52cde07114b9`, `fbd9ade4-409c-4a75-8bbf-7ca16e6a08a0`.

`d3_after` job event IDs: `36a4ddb8-cbac-4328-8634-85a32fd7ea36`, `e6328ac0-6ef0-4883-8dd3-a0fd1f7b1571`, `13bbb682-5855-4e2d-a730-a0d405cad736`, `6638df06-e156-46da-908b-25b430911a14`, `0f80b96c-93b2-4335-b5e5-5ade252a2cbf`, `5ff8df9b-adda-4d8f-88e6-33dad8eab619`, `d930911c-3710-455c-9212-cf28b98ed0b7`, `64d3537b-339e-4f37-8e47-14bb846b4844`.
`d3_after` job outbox IDs: `0c945e12-23bc-4e8f-bab5-299accc59aeb`, `0f33f565-50cc-4e6e-a354-d19e7df70018`, `10a30e46-edbc-4a0e-94af-92dc92961ccd`, `408449f3-65c4-4f35-a6c6-2e038adf2f41`, `73a443b6-8471-42b1-bc63-8ab3d223352f`, `a6804ac9-5234-4b49-b6ac-4597752d3e21`, `eefd6dd5-71a5-42d4-b556-75643d28b216`, `f5703205-55ed-4973-a3bb-52cde07114b9`, `fbd9ade4-409c-4a75-8bbf-7ca16e6a08a0`.

Final log outbox → delivery key (every key appears once in the deployed sink):

- `1ff2cbb2-9359-4064-b655-6043892d12d9` → `019bc16151d244f57270670809661cac02ac5065636ad9512241dd41596dce26`
- `23af508a-1ec4-43d8-8762-1c9211721bf9` → `9dcf3d3d0d5ca70cd861c29963da0d5047a604577bf192069404ee095be65505`
- `24885be7-6ff0-416f-aa77-2d21c53d5e2d` → `e1a5f96bd1edd0612d115b97d5caabbbfec7064734759866d67d7d3581eb0213`
- `335a06c9-9d47-4343-916e-402a496a16bf` → `1ad67befdd10e00db01a9108d0935edb1c2feb48ad1ddfc51f93510793ee02e5`
- `5cb89785-0fc4-40e8-8cac-edd24bba3245` → `e428bd1c53cab7f9c74ede94765d0ef5ee697b735d6657af400443d7a449ec8c`
- `a9e63323-6f82-4d98-a98f-347bb7267d57` → `99abad159b19892b5840d898ec6e8c87eeb9addd53bcc77883ee2395e01a8a85`
- `c5c497c9-b700-42f5-9382-ff0e807ae388` → `2bb940b74d92547a340a560130b4546908959a55cf516149ff90dfb9da399326`
- `ca910753-f458-4f3d-a990-1fed329d0f3a` → `aa0e5d2ab7ebf31a5402a17475413e397ff02c524b258bfe573756656b391220`
- `e1ea7adf-ff60-4ef1-b583-8be5fea232f0` → `c3cd71c78a48928b6b4172e79c337b96279d4d20319830c7488398380ffda84d`
- `fde65d24-9db0-49b7-b831-ae854bd5520d` → `e98bdc934aedbf570a185f85a2ae1245e947eda9831e96fd3dac512e569a6d8f`

## Recovery and limits

Gate remained `open` → `open` at sequence 0 → 0. Restore reported zero errors; independent database checks found zero drill triggers, one terminal event for each job, a closed synthetic account, and zero managed staging directories. The private state file was removed after success. The synthetic account and project used the supported closure/soft-deletion flow; append-only evidence was retained until disposable Compose volumes were removed.

A prior repeat rehearsal on the same disposable volume failed D2 at three attempts with `DATA_UNAVAILABLE` because two process-crash staging directories consumed the 1 GiB reservation budget. This run began with a fresh staging volume; the kit now checks for an empty staging area before D2 and sweeps only its recorded orphan after terminal recovery. This is a local operational limit, not evidence of a supplier problem.

Verification command: `timeout --signal=TERM --kill-after=30s 480s node deploy/m1/scripts/deployed-recovery-drill.mjs run` with private `BB_DRILL_*` inputs pointing to the already started Compose services; exit 0. `node --check deploy/m1/scripts/deployed-recovery-drill.mjs` and `git diff --check` also passed. Target pre-release execution after deployment remains required for #79 acceptance.
