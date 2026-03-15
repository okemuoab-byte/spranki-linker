const _ico = (paths: string, size = 12): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS: Record<string, string> = {
  chevronDown:   _ico(`<path d="m6 9 6 6 6-6"/>`, 14),
  chevronRight:  _ico(`<path d="m9 18 6-6-6-6"/>`, 14),
  x:             _ico(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, 13),
  arrowLeft:     _ico(`<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`),
  check:         _ico(`<path d="M20 6 9 17l-5-5"/>`),
  checkCircle:   _ico(`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  externalLink:  _ico(`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`),
  link:          _ico(`<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>`),
  clock:         _ico(`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`),
  alertTriangle: _ico(`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`),
  trash:         _ico(`<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`),
  plusCircle:    _ico(`<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>`),
  search:        _ico(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`),
  history:       _ico(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`),
  bookOpen:      _ico(`<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`),
  xCircle:       _ico(`<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`),
  sparkles:      _ico(`<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>`),
  rotateCcw:     _ico(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`),
};
