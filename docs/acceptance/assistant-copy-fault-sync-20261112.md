# Assistant copy fault-stage synchronization

The copy recovery fixture now starts its existing recovery assertions after the
configured transport failure is observed. The three-file preparation preceding
the final view write is no longer charged to the five-second resume assertion.
Production code, timeout values, retry counts, and test scenarios are unchanged.

## Original failure evidence

- Candidate: `95b7a2635cef3195791b4057bd7dc6b12138249f`.
- Run: `work/template-followup/browser-template103-1794473936218`.
- Trace: `files/assistant-project-copy-sixteenth/artifacts/assistant-project-copy-six-c5607--saved-view-and-fixed-token/trace.zip`.
- Trace SHA-256: `d70353e9f36a3165316a5dd6abc92a979a3de3c0c1da512c2def0c6ff867d22a`.
- Failed case: `assistant copy complete view loss before acceptance retains exact full saved view and fixed token`.
- All ZIP trace/network records were read offline: 789 trace records, 200 network records, 62 API requests.
- The resume assertion began at monotonic `273722.408 ms` and failed at `278731.584 ms`.
- The intended final view PUT failed with `net::ERR_CONNECTION_RESET` at `2026-11-12T09:08:25.008Z`, after the target creation, three uploads and memberships, and target PATCH.
- Subsequent workspace, target, and all three material reads returned 200; the final material read completed at approximately `09:08:25.191Z`.
- Final frame snapshot at `278802.401 ms`, 70.817 ms after the failed assertion, contains the recovery resume button with no `disabled` attribute and status `尚未观察到原完整会话采用；可明确继续同一份完整原请求。`.

This trace demonstrates recovery returned to an enabled retry state just after
the assertion deadline. It does not demonstrate a persistent product busy lock.
The original failed run remains failed. The following 26 cases were not fully
observed; its 300-second per-file diagnostic ceiling was not a test timeout.

## Boundary used by the fixture

The listener is registered before the prepare click. It accepts only a real
`requestfailed` event with `net::ERR_CONNECTION_RESET`, a configured drop stage,
and the matching method and path below. Initial reads and unrelated HMR failures
cannot satisfy the predicate.

| Configured stage | Required request |
| --- | --- |
| targetCreate | POST `/api/v1/projects` |
| uploadCreate | POST to the actual created target's `/materials/uploads` |
| bytes / complete | PUT bytes / POST complete for an existing upload ID on that target |
| member | POST `/api/v1/m4/topics/copy-16-original-topic/materials` |
| patch | PATCH to the actual created target |
| view | PUT `/api/v1/m4/topics/copy-16-original-topic/view` |
| sourceBytes | GET an original batch material's exact download path |

Current `pending()` cases configure at most one drop. If multiple drops are
configured, the first matching failure actually reached is the boundary.
The original upload confirmation handshake runs only when that observed stage
is bytes/complete with an after-acceptance drop. Its four/three remaining real
confirmation responses and clock advancement remain unchanged. Cases without
configured drops retain their original path. No generic idle wait precedes the
resume assertion; a recovery busy lock still fails that assertion.

## Validation and limits

- TypeScript parse and transpile diagnostics: zero; this is not a full typecheck.
- Spec is byte-identical, SHA-256 `f31b077926a99a437f2f9e653c8526f6c105c911a058f0c85998bde4ec1b49a4`; every test title and assertion is retained.
- Fixture expectation expressions remain exactly equal, 46 before and 46 after.
- Offline execution of the new matcher against the trace's 62 API requests matches exactly the intended final view failure.
- Listener-before-click ordering and absence of added timeout/sleep calls were checked statically.
- No browser, Docker, service, build, or model call was launched for this change. Browser rerun is pending the shared resource window; no passing browser result or production verification is claimed.
