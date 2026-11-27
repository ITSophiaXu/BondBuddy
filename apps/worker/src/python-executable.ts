/** Resolve one Python executable for every host-side Python helper. */
export function resolvePythonExecutable(preferred?: string | null): string {
  const value = [preferred, process.env.BONDBUDDY_WORD_PYTHON, process.env.BONDBUDDY_TEST_PYTHON,
    process.env.BB_PYTHON, process.env.BB_PYTHON_BIN].map(item => item?.trim()).find(Boolean);
  return value || (process.platform === 'win32' ? 'python' : 'python3');
}
