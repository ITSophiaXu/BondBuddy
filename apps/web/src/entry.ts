// The design preview is an explicit build mode. Ordinary builds retain the live app.
if (import.meta.env.MODE === 'project-design') {
  void import('./project-design/app');
} else {
  void import('./main');
}
export {};
