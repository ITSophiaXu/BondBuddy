# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: review-editor-recovery.spec.ts >> same SHA with a different input_hash wrapper refuses recovery and preserves the original cache
- Location: apps\web\tests\review-editor-recovery.spec.ts:104:12

# Error details

```
Error: browserType.launch: Executable doesn't exist at C:\Users\lezhai\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```