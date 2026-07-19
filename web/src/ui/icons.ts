/** Inline SVG icon glyphs (ports of the desktop app's vector icons). */

function svg(inner: string, viewBox = "0 0 24 24"): string {
  return `<svg viewBox="${viewBox}" aria-hidden="true">${inner}</svg>`;
}

export const ICONS: Record<string, string> = {
  play: svg('<path class="fill" d="M8 5.5 L8 18.5 L19 12 Z"/>'),
  pause: svg('<rect class="fill" x="7" y="5.5" width="3.4" height="13"/>' +
             '<rect class="fill" x="13.6" y="5.5" width="3.4" height="13"/>'),
  step: svg('<path class="fill" d="M6 6 L6 18 L14 12 Z"/>' +
            '<rect class="fill" x="15.5" y="6" width="2.6" height="12"/>'),
  step_back: svg('<path class="fill" d="M18 6 L18 18 L10 12 Z"/>' +
                 '<rect class="fill" x="5.9" y="6" width="2.6" height="12"/>'),
  reset: svg('<path d="M18.4 9.2 A7 7 0 1 0 19 12" fill="none"/>' +
             '<path class="fill" d="M20.5 4.5 L20 10.3 L14.8 8 Z"/>'),
  undo: svg('<path d="M9 6.5 L4.5 10 L9 13.5 M4.5 10 H15 a4.5 4.5 0 0 1 0 9 H8" fill="none"/>'),
  redo: svg('<path d="M15 6.5 L19.5 10 L15 13.5 M19.5 10 H9 a4.5 4.5 0 0 0 0 9 H16" fill="none"/>'),
  select: svg('<path class="fill" d="M6 3.5 L6 17.5 L9.6 14.4 L12 19.5 L14.4 18.4 L12 13.4 L16.5 12.8 Z"/>'),
  pan: svg('<path d="M12 3 V21 M3 12 H21 M12 3 L9.5 5.5 M12 3 L14.5 5.5 M12 21 L9.5 18.5 M12 21 L14.5 18.5 ' +
           'M3 12 L5.5 9.5 M3 12 L5.5 14.5 M21 12 L18.5 9.5 M21 12 L18.5 14.5" fill="none"/>'),
  body: svg('<circle cx="12" cy="12" r="7.5" fill="none"/><circle class="fill" cx="12" cy="12" r="2"/>'),
  anchor: svg('<circle cx="12" cy="5" r="1.9" fill="none"/>' +
              '<path d="M12 6.9 V19.2 M8.6 9.6 H15.4" fill="none"/>' +
              '<path d="M12 19.2 C9 19 6.4 16.8 5.7 13.7 L4 15 M5.7 13.7 L7.5 14.8" fill="none"/>' +
              '<path d="M12 19.2 C15 19 17.6 16.8 18.3 13.7 L20 15 M18.3 13.7 L16.5 14.8" fill="none"/>'),
  wall: svg('<path d="M4 17 L20 7" stroke-width="3.4"/>'),
  rod: svg('<path d="M7 17 L17 7"/><circle class="fill" cx="6" cy="18" r="2.4"/>' +
           '<circle class="fill" cx="18" cy="6" r="2.4"/>'),
  rope: svg('<path d="M4.5 14 Q8 9 11 13 T18.5 11" fill="none"/>' +
            '<circle class="fill" cx="4.5" cy="14" r="2.2"/><circle class="fill" cx="18.5" cy="11" r="2.2"/>'),
  spring: svg('<path d="M3.5 12 H6 L8 7.5 L10.5 16.5 L13 7.5 L15.5 16.5 L17.5 12 H20.5" fill="none"/>'),
  eraser: svg('<path d="M5 5 L19 19 M5 19 L19 5" stroke-width="2.6"/>'),
  library: svg('<rect x="4.5" y="4.5" width="6.4" height="6.4" rx="1.4" fill="none"/>' +
               '<rect x="13.1" y="4.5" width="6.4" height="6.4" rx="1.4" fill="none"/>' +
               '<rect x="4.5" y="13.1" width="6.4" height="6.4" rx="1.4" fill="none"/>' +
               '<rect x="13.1" y="13.1" width="6.4" height="6.4" rx="1.4" fill="none"/>'),
  help: svg('<path d="M9 9.2 a3 3 0 1 1 4.6 2.6 c-1.1 0.7 -1.6 1.3 -1.6 2.6" fill="none"/>' +
            '<circle class="fill" cx="12" cy="17.8" r="1.4"/>'),
  trash: svg('<path d="M6.5 8 V19 a1.5 1.5 0 0 0 1.5 1.5 H16 a1.5 1.5 0 0 0 1.5 -1.5 V8 M4.5 8 H19.5 ' +
             'M9.5 8 V5.8 a1.3 1.3 0 0 1 1.3 -1.3 h2.4 a1.3 1.3 0 0 1 1.3 1.3 V8" fill="none"/>'),
  plus: svg('<path d="M12 5 V19 M5 12 H19"/>'),
  close: svg('<path d="M6 6 L18 18 M6 18 L18 6"/>'),
  fit: svg('<path d="M4 9 V5.5 a1.5 1.5 0 0 1 1.5 -1.5 H9 M15 4 h3.5 A1.5 1.5 0 0 1 20 5.5 V9 ' +
           'M20 15 v3.5 a1.5 1.5 0 0 1 -1.5 1.5 H15 M9 20 H5.5 A1.5 1.5 0 0 1 4 18.5 V15" fill="none"/>'),
  autofit: svg('<path d="M4 9 V5.5 a1.5 1.5 0 0 1 1.5 -1.5 H9 M15 4 h3.5 A1.5 1.5 0 0 1 20 5.5 V9 ' +
               'M20 15 v3.5 a1.5 1.5 0 0 1 -1.5 1.5 H15 M9 20 H5.5 A1.5 1.5 0 0 1 4 18.5 V15" fill="none"/>' +
               '<circle class="fill" cx="12" cy="12" r="2.4"/>'),
  chev_left: svg('<path d="M14.5 6 L9 12 L14.5 18" fill="none"/>'),
  chev_right: svg('<path d="M9.5 6 L15 12 L9.5 18" fill="none"/>'),
  save: svg('<path d="M5 5.5 A1.5 1.5 0 0 1 6.5 4 H16 L20 8 V18.5 A1.5 1.5 0 0 1 18.5 20 H6.5 ' +
            'A1.5 1.5 0 0 1 5 18.5 Z M8 4 V9 H15.5 V4 M8 20 V14 H16 V20" fill="none"/>'),
  download: svg('<path d="M12 4 V15 M7.5 11 L12 15.5 L16.5 11 M5 19.5 H19" fill="none"/>'),
  upload: svg('<path d="M12 15.5 V4.5 M7.5 8.5 L12 4 L16.5 8.5 M5 19.5 H19" fill="none"/>'),
  panel: svg('<rect x="4" y="5" width="16" height="14" rx="1.5" fill="none"/><path d="M14.5 5 V19"/>'),
  rename: svg('<path d="M14.5 5.5 L18.5 9.5 L9 19 H5 V15 Z M12.5 7.5 L16.5 11.5" fill="none"/>'),
  gear: svg('<path class="fill" fill-rule="evenodd" d="M21.45 13.67 ' +
            'L21.45 10.33 L18.92 10.02 L18.3 8.51 L19.86 6.49 L17.51 4.14 ' +
            'L15.49 5.7 L13.98 5.08 L13.67 2.55 L10.33 2.55 L10.02 5.08 ' +
            'L8.51 5.7 L6.49 4.14 L4.14 6.49 L5.7 8.51 L5.08 10.02 ' +
            'L2.55 10.33 L2.55 13.67 L5.08 13.98 L5.7 15.49 L4.14 17.51 ' +
            'L6.49 19.86 L8.51 18.3 L10.02 18.92 L10.33 21.45 L13.67 21.45 ' +
            'L13.98 18.92 L15.49 18.3 L17.51 19.86 L19.86 17.51 L18.3 15.49 ' +
            'L18.92 13.98 Z M15.3 12 A3.3 3.3 0 1 0 8.7 12 ' +
            'A3.3 3.3 0 1 0 15.3 12 Z"/>'),
  describe: svg('<path d="M5 6 H19 M5 10 H19 M5 14 H13 M5 18 H10" fill="none"/>'),
};
