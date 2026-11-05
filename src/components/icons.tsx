// Small stroke icons. Decorative: every icon is aria-hidden and sits next to a text label or inside
// a button that carries an accessible name.
import type { ReactNode } from 'react';

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconPlay = () => <Svg><path d="M7 4.5v15l12-7.5z" fill="currentColor" /></Svg>;
export const IconPause = () => <Svg><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></Svg>;
export const IconStop = () => <Svg><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></Svg>;
export const IconPlus = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const IconEdit = () => <Svg><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Svg>;
export const IconTrash = () => <Svg><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>;
export const IconClose = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconChevron = ({ open }: { open: boolean }) => <Svg><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></Svg>;
export const IconEyeOff = () => <Svg><path d="M3 3l18 18M10.6 6.2A9.8 9.8 0 0112 6c5 0 8.5 4 9.5 6a14 14 0 01-3 3.7M6.5 7.6A14.4 14.4 0 002.5 12c1 2 4.5 6 9.5 6a9 9 0 003.6-.8M9.9 9.9a3 3 0 004.2 4.2" /></Svg>;
export const IconEye = () => <Svg><path d="M2.5 12c1-2 4.5-6 9.5-6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const IconDownload = () => <Svg><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></Svg>;
export const IconInfo = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></Svg>;
export const IconWarn = () => <Svg><path d="M12 4l9.5 16h-19zM12 10v4.5M12 17.5v.5" /></Svg>;
export const IconArchive = () => <Svg><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8M10 12h4" /></Svg>;
export const IconRestore = () => <Svg><path d="M4 12a8 8 0 108-8H7M7 4L4 7l3 3" /></Svg>;
export const IconBack = () => <Svg><path d="M10 6l-6 6 6 6M4 12h16" /></Svg>;
export const IconCheck = () => <Svg><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const IconTag = () => <Svg><path d="M3.5 12.5V4.5h8l8.5 8.5-8 8z" /><circle cx="7.8" cy="8.8" r="1.1" fill="currentColor" /></Svg>;
export const IconClock = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const IconFolder = () => <Svg><path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" /></Svg>;
export const IconRefresh = () => <Svg><path d="M20 11a8 8 0 00-14-4M4 5v4h4M4 13a8 8 0 0014 4M20 19v-4h-4" /></Svg>;
