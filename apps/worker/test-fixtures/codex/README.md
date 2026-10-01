# Synthetic Codex JSONL fixtures (#16)

SYNTHETIC. Hand-written to match the event and usage shapes recorded in the CTO live
compatibility comment on #16 (BB-M1-11-LIVE, codex-cli 0.154.0, provider `deepseek`,
`wire_api=responses`). Token numbers are copied from that anonymized sample; thread ids and
text are invented. No real provider output or customer material is stored here.

`fake-codex.mjs` stands in for `codex`: it reads the prompt from stdin, picks the fixture named
by a `SCENARIO:<name>` marker (or `REASK_SCENARIO:<name>` when the adapter re-asks), and replays
it. Lines of the form `{"fake":...}` are directives for the fake itself (sleep, hang, exit,
raw text, simulated side effect) and are never emitted.

`probe_echo.jsonl` answers the fixed platform probe template (`bb_probe_json_echo_v1`). The probe
prompt carries no `SCENARIO:` marker, so its tests pass `--fake-scenario=<name>` as the first
argument after the fake script.
