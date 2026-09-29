# #14 local OCR v2 sample verification (incomplete)

**Result:** The standalone Python v2 probe and invocation process the nominated physical pages, but **neither audit PDF completed**. The 2024 sweep stopped after 70/74 successful pages at physical page 71; the 2025 sweep stopped after 66/70 at page 67. Both failures reproduce as a narrow ruled-cell crop error in the v1 extraction helper used by v2. This is a local algorithm finding, not an authorized platform `full_ocr` run, durable checkpoint, accuracy score, or #14 acceptance. Keep the PR Draft and #14 open.

## Inputs and runtime

The only source documents read were the already authorized `qx-202606-02` and `qx-202606-03` audit PDFs in `tests/samples/2026-09-25/`. `python3 tests/samples/verify.py` passed for all 15 originals (26,246,609 bytes). The manifest byte SHA-256 was `b191b6c8bf1ce62bf679b1bda33bd609629a2832119e4eedd5947feb9ab0a67d`. Each PDF's SHA-256 and size were independently checked before the probe, and both PDFium and pypdf agreed with its manifest physical page count:

| Manifest file ID | Source SHA-256 | Bytes | Physical pages |
| --- | --- | ---: | ---: |
| `qx-202606-02` | `f6ab6dae2d70f09390915ea9d3eeb7a755df51d3307f1eb204ae1243ed971844` | 6,960,431 | 74 |
| `qx-202606-03` | `82a95dcd65ad1d1595fb2f340fa1912f540fbaa6ddec41e28c56ae971002a891` | 7,227,129 | 70 |

Local macOS, Python 3.14.3 in a task-local virtualenv, Tesseract **5.5.0**, Python processor `bondbuddy-ocr-2.0.0`, PDFium **153.0.7999.0**, pypdf 6.19.0, Pillow 12.3.0, NumPy 2.5.3; PDF render at 250 DPI with 20,000,000-pixel/page bound. `chi_sim` came from the public Debian Bookworm `tesseract-ocr-chi-sim_4.1.0-2_all.deb` after verifying the `.deb` SHA-256 **`035f20a3e317343c1b88f6db546225eda9b5857078729c009662e0b3e0fb5d57`** against `python/OCR-HANDOFF.md`; the extracted file SHA-256 was `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730`. Only task-local copies of installed `eng` and `osd` were used; their hashes were respectively `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` and `9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff`. `TESSDATA_PREFIX` pointed to that temporary directory; no global install or document upload occurred.

The probe reported OCR configuration SHA-256 `2e25baac05262386301cca7ff79572cd9b129cbb1df2499f82eb9e324b2422dc` and rendering configuration SHA-256 `380323ce91a78f82060ce4e5f744edf0a630a994a948da13beb2ec7e46d7e59c`. These identify this **mixed macOS engine/Debian language-data** setup, not the separately tested Linux pinned worker image.

## Bounded observations

`tests/samples/ocr_v2_probe.py` verifies source bytes, asks the actual `ocr-identity-probe-v2` for its physical-page identity, invokes `ocr-invocation-v2`, validates each transient page checkpoint and PNG hash, and prints only codes/counts and runtime metadata. No text, raw OCR response, image, or derived result is committed or printed. It uses an **explicitly synthetic** `full_ocr` run context only to exercise the standalone CLI for pages beyond the five-page preflight limit; this cannot confer run authorization, persist a checkpoint, or test billing.

| Local invocation | Successful physical pages / total | Attempted pages in that invocation | Wall time | Sampled peak process-tree RSS | Sampled peak CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2024 selected p3 and p7 | 2/74 | 2 | 9.6 s | 424.8 MiB | not measured in first sampler |
| 2025 selected p7 | 1/70 | 1 | 3.9 s | 415.4 MiB | not measured in first sampler |
| 2024 one-page batches, stop on p71 | **70/74** | **71** (70 successes, one attempted failure) | **311.2 s** | **442.4 MiB** | **101.1%** |
| 2025 one-page batches, stop on p67 | **66/70** | **67** (66 successes, one attempted failure) | **294.9 s** | **448.5 MiB** | **101.1%** |

The selected calls and full sweeps are **separate attempts**, not additive coverage or metered platform consumption. For 2024, pages 72–74 were not attempted in the sweep; for 2025, pages 68–70 were not attempted. No result is a complete v2 aggregate or a durable checkpoint. The harness stops on first failed page, 180 seconds per batch, 1,200 seconds per document, or 512 MiB sampled process-tree RSS; outputs are transient unlinked local tempfiles. Sampling is not a guaranteed memory upper bound, and macOS CPU was **not throttled** to the Linux worker's 0.75-CPU cgroup. Thus these measurements do not establish target-image, 512-MiB, concurrent-worker, or production-VM acceptance.

For 2024 p3/p7 the 108 records had `ocr_requires_review` (108), `low_confidence` (86), `critical_value_requires_confirmation` (56), numeric `number` (27), and `unparsed` (81). For 2025 p7 the 104 records had those uncertainty counts 104/57/62 and numeric counts 51/53. The selected pages all returned `needs_confirmation`, `eligible_for_manuscript=false`, plus `layout_requires_review` and `cross_page_tables_not_joined`. Counts describe **classification/uncertainty signals only**, not agreement with the page or field accuracy.

Both first-failure pages report `OCR_PAGE_FAILED`. A local metadata-only direct-engine reproduction raises `ValueError` at `python/bondbuddy_ocr/engine.py:204` (`Image.crop`): the ruled-grid candidate cells are narrower or shorter than twice the fixed six-pixel crop inset. Physical 2024 p71 has three candidates at most 12 pixels wide (minimum width 9); physical 2025 p67 has six candidates at most 12 pixels tall (minimum height 9). v2 catches this as a failed attempted page with no success checkpoint. The engine's narrow-cell handling belongs to its algorithm owner; this verification slice does not change it or mislabel the incomplete sweep as success.

## Reproduction and remaining gates

Use a local Python 3.11+ environment with `python/requirements-dev.txt`, Tesseract, verified `chi_sim`, `eng`, and `osd`. Before using the Debian model, check the published `.deb` hash above and the extracted model hashes against `python/OCR-HANDOFF.md`; do not commit the package or models. Point `TESSDATA_PREFIX` to their temporary directory, then run from the repository root (substitute your task-local Python path):

```sh
python3 tests/samples/verify.py
TESSDATA_PREFIX="$TASK_DIR/tessdata" PYTHONPATH=python "$TASK_DIR/venv/bin/python" tests/samples/ocr_v2_probe.py --file-id qx-202606-02 --pages 3,7
TESSDATA_PREFIX="$TASK_DIR/tessdata" PYTHONPATH=python "$TASK_DIR/venv/bin/python" tests/samples/ocr_v2_probe.py --file-id qx-202606-03 --pages 7
TESSDATA_PREFIX="$TASK_DIR/tessdata" PYTHONPATH=python "$TASK_DIR/venv/bin/python" tests/samples/ocr_v2_probe.py --file-id qx-202606-02 --pages all --batch-size 1 --max-rss-mib 512 --max-batch-seconds 180 --max-total-seconds 1200
TESSDATA_PREFIX="$TASK_DIR/tessdata" PYTHONPATH=python "$TASK_DIR/venv/bin/python" tests/samples/ocr_v2_probe.py --file-id qx-202606-03 --pages all --batch-size 1 --max-rss-mib 512 --max-batch-seconds 180 --max-total-seconds 1200
```

The two full commands **exit nonzero at the documented pages** until the engine defect is fixed. The selected synthetic-only regressions ran with `BB_OCR_CHINESE_TEST=1`, `TESSDATA_PREFIX` set, and `PYTHONPATH=python`: `python -m unittest python.tests.test_ocr_v2 python.tests.test_ocr -v` passed **11/11, zero skips**. They cover explicit negative/zero/blank/dash/unit precision, synthetic year-column ordering and merged/blank table geometry, sparse 70/74-page identities, attempts/retry/reuse, corrupt checkpoints, source hash/encryption and the v1 execution boundary. They cannot supply field-level correctness or a customer gold label.

Remaining: repair the narrow-cell failure in the OCR algorithm and rerun both full materials, retain/checkpoint validated successful physical pages in an authorized worker run, verify CPU/memory under the pinned Linux image and production VM workload, and obtain per-cell financial labels/independent professional review. There is no authorized scanned historical prospectus here; neither audit PDF substitutes for one. No #17 scheduling, public v2 review/correction, #15/#76 consumer, financial accuracy, or professional acceptance was exercised.
