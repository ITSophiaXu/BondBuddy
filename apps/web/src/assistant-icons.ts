/** A single stroke language for the floating assistant; no font-dependent glyphs. */
const paths = {
  buddy: '<path d="M13.5 4.5H7a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h1v3l4-3h5a3 3 0 0 0 3-3v-4"/><path d="M8 10h4m-4 4h8M18 2l1.1 3.4L22.5 6.5l-3.4 1.1L18 11l-1.1-3.4L13.5 6.5l3.4-1.1Z"/>',
  new: '<path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6M16 4l4 4M10 14l1-5 7-7 4 4-7 7Z"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7m2-4v5l3 2"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  contract: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  minus: '<path d="M5 12h14"/>',
  collapse: '<path d="m5 6 6 6-6 6m8-12 6 6-6 6"/>',
  folder: '<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  paperclip: '<path d="m8 13 6.8-6.8a2.8 2.8 0 0 1 4 4L9.2 19.8a4.5 4.5 0 0 1-6.4-6.4L13 3.2"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  update: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7M13 3v5h5M13 3l5 5M8 12h4m-4 4h2m4 1 5-5 3 3-5 5-4 1Z"/>',
  review: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M14 3v5h5M14 3l5 5M8 12h3m-3 4h2"/><circle cx="17" cy="16" r="4"/><path d="m20 19 2 2"/>',
  generation: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9M14 3v6h6M14 3l6 6M9 13h7m-7 4h4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  loading: '<path d="M21 12a9 9 0 1 1-9-9"/>',
} as const;

export const assistantIcon = (name: keyof typeof paths) => `<svg class="ba-icon${name === 'loading' ? ' ba-spinning' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
