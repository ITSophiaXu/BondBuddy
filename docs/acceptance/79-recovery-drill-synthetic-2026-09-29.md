# #79 isolated recovery drill: synthetic evidence

Tested code commit: `3b1eee90957d0c6064a82f73292e085c7f2bc28f` (based on `develop` `33e9988bcb828a498d155a61f6745da31c6ee4a2`). The command `BB_DRILL_EXPECTED_SHA=3b1eee90957d0c6064a82f73292e085c7f2bc28f BB_DRILL_LOCAL_ONLY=1 bash deploy/m1/scripts/run-log-recovery-drill.sh` passed in disposable PostgreSQL 16 and Azurite containers: 1 test passed, 0 failed, 0 skipped. `BB_DRILL_LOCAL_ONLY=1` was used only for this isolated local rehearsal. The application database and pre-release deployment were not accessed.

Synthetic parse job ID: `ab36d637-983f-4860-9d6f-db224b77a39c`.

| Phase | State | Attempts | Job events | Observability outbox pending | Delivery receipts | Terminal events | Gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Before fault | queued | 0 | 1 | 1 | 0 | 0 | open |
| Parse claimant killed after checkpoint | running | 1 | 3 | 3 | 0 | 0 | open |
| Before transaction fault, after lease recovery | running | 2 | 4 | 4 | 0 | 0 | open |
| During terminal transaction fault | running | 2 | 4 | 4 | 0 | 0 | paused |
| After connection and terminal recovery | succeeded | 2 | 5 | 5 | 0 | 1 | open |
| During unsafe sink permissions | succeeded | 2 | 5 | 5 (`sink_unavailable`: 5) | 0 | 1 | open |
| After sink replay | succeeded | 2 | 5 | 0 | 5 | 1 | open |

The checkpoint stored before the process kill was present on the second claim. The failed terminal transaction left both the job event IDs and outbox IDs unchanged. Repeating the successful terminal transition was rejected. The final job event IDs were `13f6e9f0-f6f8-4fb4-9bdb-0f7ecb2cba13`, `dbea932f-7314-4f94-985a-7016d12953c1`, `a35ca9ed-deaf-4c69-a9d8-704e1a6bcf44`, `9c245273-4835-4354-8bc9-5a826c82d55f`, `2b3844e1-0000-4516-ab36-e30d35cddfaf`.

The final parse observability outbox IDs were `2faa2059-4ddb-4fac-9671-cac25e0844a6`, `366406a1-8167-4269-948d-9f88eb8db15d`, `4ce1f3ec-e3b4-48ee-82ef-2b54a4c74bd6`, `774b9ac7-9d18-46f0-858c-3c6a4547cb65`, `e15ed9ef-fb65-4f1f-b27b-e95f065706ac`. All five had matching delivery receipts. The sink file had five lines and five unique delivery keys; a further forward pass delivered zero.

The isolated synthetic call attempt `synthetic79_6e195e6c-2614-47c3-a9bb-2765be0c20a4` produced three outbox IDs, each with a matching receipt: `4d943e5c-5db0-4f31-adc3-52183326c983`, `6e95b602-c300-4ece-8c95-1c33a1e9a9cc`, `b6beb5e8-96e0-41c1-9283-b84a7f5dae1e`. One exact source replay and a second source left two raw observations and one effective attempt: input 7, output 3, cached input 2, reasoning output 1. These numbers are synthetic and do not represent supplier usage.

The wrapper removed both disposable containers; the test helper dropped its cloned database. The temporary sink and synthetic Blob object were removed. A separate guard check with one `running` nonsynthetic job returned `active_real_jobs=1` and exited before container creation.

This evidence proves only the isolated rehearsal. Running the procedure against a guarded pre-release deployment and recording its real operational state remain separate acceptance work.
