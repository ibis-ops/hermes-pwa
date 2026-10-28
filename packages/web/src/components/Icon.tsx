import type { SVGProps } from 'react';

export type IconName =
  | 'menu'
  | 'home'
  | 'chat'
  | 'check'
  | 'sessions'
  | 'profiles'
  | 'kanban'
  | 'cron'
  | 'agents'
  | 'robot'
  | 'system'
  | 'settings'
  | 'skills'
  | 'messaging'
  | 'search'
  | 'globe'
  | 'note'
  | 'file'
  | 'plus'
  | 'mic'
  | 'wave'
  | 'arrowUp'
  | 'bolt'
  | 'chevR'
  | 'chevD'
  | 'close'
  | 'branch'
  | 'play'
  | 'pause'
  | 'edit'
  | 'trash'
  | 'refresh'
  | 'shield'
  | 'terminal'
  | 'alert'
  | 'sparkle'
  | 'archive'
  | 'logout'
  | 'download'
  | 'copy'
  | 'image'
  | 'camera'
  | 'paperclip'
  | 'more'
  | 'sun'
  | 'speaker'
  | 'stopSquare'
  | 'compose';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  name: IconName;
  size?: number;
}

type IconPart = string | readonly [string, Record<string, string | number>];

const ICONS: Record<IconName, IconPart[]> = {
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  home: ['M3 10.6 12 3l9 7.6', 'M5.4 9.4V20h13.2V9.4'],
  chat: ['M3 5.5a1.5 1.5 0 0 1 1.5-1.5h15A1.5 1.5 0 0 1 21 5.5v9A1.5 1.5 0 0 1 19.5 16H9l-5 4z'],
  check: [['circle', { cx: 12, cy: 12, r: 9 }], 'M8.3 12.3l2.4 2.4 4.8-5.2'],
  sessions: ['M12 3 3 7.5l9 4.5 9-4.5z', 'M3 12l9 4.5 9-4.5', 'M3 16.5l9 4.5 9-4.5'],
  profiles: [
    ['circle', { cx: 9, cy: 8, r: 3 }],
    'M3.5 19c.8-3.4 2.9-5 5.5-5s4.7 1.6 5.5 5',
    ['circle', { cx: 17, cy: 9, r: 2.3 }],
    'M14.5 14.2c2.7.3 4.6 1.8 5.2 4.8',
  ],
  kanban: [
    ['rect', { x: 4, y: 4, width: 4, height: 16, rx: 1 }],
    ['rect', { x: 10, y: 4, width: 4, height: 10, rx: 1 }],
    ['rect', { x: 16, y: 4, width: 4, height: 7, rx: 1 }],
  ],
  cron: [['circle', { cx: 12, cy: 12, r: 9 }], 'M12 7.5V12l3 2'],
  agents: [
    ['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.5 }],
    'M9 1.8V4',
    'M15 1.8V4',
    'M9 20v2.2',
    'M15 20v2.2',
    'M1.8 9H4',
    'M1.8 15H4',
    'M20 9h2.2',
    'M20 15h2.2',
  ],
  robot: [
    ['rect', { x: 4, y: 8, width: 16, height: 11, rx: 3 }],
    'M12 4v4',
    'M8.5 13h.01',
    'M15.5 13h.01',
    ['circle', { cx: 12, cy: 3.5, r: 1.4 }],
  ],
  system: [
    ['rect', { x: 3, y: 4, width: 18, height: 7, rx: 1.6 }],
    ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 1.6 }],
    'M6.5 7.5h.01',
    'M6.5 16.5h.01',
  ],
  settings: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    'M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.2 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  ],
  skills: ['M14.6 6.3a4 4 0 0 0-5.5 5.5L3 18v3h3l6.2-6.1a4 4 0 0 0 5.5-5.5l-2.6 2.6-2.4-2.4z'],
  messaging: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], 'M21 21l-4.4-4.4'],
  globe: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    'M12 3c-2.5 3.5-3 7-3 9s.5 5.5 3 9c2.5-3.5 3-7 3-9s-.5-5.5-3-9z',
    'M3 12h18',
  ],
  note: ['M6.5 3h8l4 4v14h-12z', 'M14.5 3v4h4', 'M9.5 12h5', 'M9.5 16h5'],
  file: [
    ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
    'M14 2v6h6',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  wave: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2'],
  arrowUp: ['M12 19V6', 'M6 12l6-6 6 6'],
  bolt: ['M13 2 4 14h6l-1 8 9-12h-6z'],
  chevR: ['M9 5l7 7-7 7'],
  chevD: ['M5 9l7 7 7-7'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  branch: [
    ['circle', { cx: 6, cy: 6, r: 2.4 }],
    ['circle', { cx: 6, cy: 18, r: 2.4 }],
    ['circle', { cx: 18, cy: 8, r: 2.4 }],
    'M6 8.4v7.2',
    'M18 10.4c0 4-4 2.8-6 4.6',
  ],
  play: ['M7 5l12 7-12 7z'],
  pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
  edit: ['M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 3 21l.5-4.5L17 3z'],
  trash: ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.3', 'M21 3v5h-5'],
  shield: ['M12 2.5 4.5 5.5v6c0 4.8 3.3 8.3 7.5 10.5 4.2-2.2 7.5-5.7 7.5-10.5v-6z'],
  terminal: ['M5 6l5 5-5 5', 'M12 18h7'],
  alert: ['M12 3 2.5 20h19z', 'M12 10v4', 'M12 16.5h.01'],
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2'],
  copy: [
    ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    'M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5',
  ],
  image: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }],
    ['circle', { cx: 8.5, cy: 9.5, r: 1.6 }],
    'M21 16l-5-5-9 9',
  ],
  camera: [
    'M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
    ['circle', { cx: 12, cy: 13, r: 3.2 }],
  ],
  paperclip: ['M21 11.5 12.3 20.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.4 7.5'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
  more: [['circle', { cx: 6, cy: 12, r: 1.3 }], ['circle', { cx: 12, cy: 12, r: 1.3 }], ['circle', { cx: 18, cy: 12, r: 1.3 }]],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    'M12 2.5v2.2', 'M12 19.3v2.2', 'M2.5 12h2.2', 'M19.3 12h2.2',
    'M5.3 5.3l1.6 1.6', 'M17.1 17.1l1.6 1.6', 'M5.3 18.7l1.6-1.6', 'M17.1 6.9l1.6-1.6',
  ],
  archive: [
    ['rect', { x: 3, y: 4, width: 18, height: 5, rx: 1.2 }],
    'M5 9v10h14V9',
    'M10 13h4',
  ],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  speaker: ['M4 9.5h3.2L12 5.5v13l-4.8-4H4z', 'M15.5 9.2a4 4 0 0 1 0 5.6', 'M18.2 6.6a7.6 7.6 0 0 1 0 10.8'],
  stopSquare: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.2 }]],
  // A square with a pencil over its corner: write a new note, as in Notes.
  compose: ['M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5', 'M18.4 3.6a2 2 0 0 1 2.8 2.8L12 15.6l-3.6.8.8-3.6z'],
};

function renderPart(part: IconPart, index: number) {
  if (typeof part === 'string') {
    return <path key={index} d={part} />;
  }
  const [tag, attrs] = part;
  if (tag === 'circle') return <circle key={index} {...attrs} />;
  if (tag === 'rect') return <rect key={index} {...attrs} />;
  if (tag === 'path') return <path key={index} {...attrs} />;
  return null;
}

export function Icon({ name, size = 20, className, ...rest }: IconProps) {
  const parts = ICONS[name] ?? [];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {parts.map(renderPart)}
    </svg>
  );
}
