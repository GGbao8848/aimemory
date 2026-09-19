import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

const base = (props: IconProps) => ({
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  ...props,
});

export const MemoriesIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4 6h8M4 8.5h5M4 11h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const KeysIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="5.5" cy="10.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 8 13.5 2.5M11 5l2 2M12.5 3.5l1.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SessionsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 2.5v11M8 5.5h4M8 8h4M8 10.5h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const OpsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2.5 3h11M2.5 8h11M2.5 13h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="12.5" cy="3" r="1.3" fill="currentColor" />
    <circle cx="11" cy="13" r="1.3" fill="currentColor" />
  </svg>
);

export const L3Icon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 1.8 14 5v6L8 14.2 2 11V5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M8 8.2 14 5M8 8.2 2 5M8 8.2v6" stroke="currentColor" strokeWidth="1.2" opacity=".6" />
  </svg>
);

export const GuideIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 2.5h7a2 2 0 0 1 2 2V13a1.5 1.5 0 0 0-1.5-1.5H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M10 4.5v6.5" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const SunIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const MoonIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

export const LogoutIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13H6M10 5l3 3-3 3M13 8H6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 记忆空状态的档案图形 */
export const EmptyArchiveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M6 3h9l4 4v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4.5A1.5 1.5 0 0 1 6.5 3z" strokeLinejoin="round" />
    <path d="M14 3v5h5M8.5 12h7M8.5 15.5h7M8.5 19h4" strokeLinecap="round" />
  </svg>
);
