/** Small line icons drawn on a 16px grid; they take the current text colour. */
type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function SunIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </Svg>
  );
}

export function MoonIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8Z" />
    </Svg>
  );
}

export function SystemIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
      <path d="M6 13.75h4M8 11v2.75" />
    </Svg>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m3.5 8.5 3 3 6-6.5" />
    </Svg>
  );
}

export function GlobeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75Z" />
    </Svg>
  );
}

/** Two opposed arrows: exchanging one asset for another (trading). */
export function SwapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8" />
      <path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />
    </Svg>
  );
}

/** A drop with a plus: liquidity, topped up (LP Grant subsidises liquidity). */
export function LiquidityIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 1.75c2.4 2.9 4.25 5.3 4.25 7.7a4.25 4.25 0 0 1-8.5 0c0-2.4 1.85-4.8 4.25-7.7Z" />
      <path d="M8 7.6v3.6M6.2 9.4h3.6" />
    </Svg>
  );
}

/** A small rocket: launching a token. */
export function RocketIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 1.75c2.1 1.5 3.1 3.7 3.1 6.2V11H4.9V7.95c0-2.5 1-4.7 3.1-6.2Z" />
      <circle cx="8" cy="6.6" r="1.1" />
      <path d="M4.9 8.9 3 10.8V12.6h1.9M11.1 8.9 13 10.8V12.6h-1.9" />
      <path d="M7 13.2 8 14.5l1-1.3" />
    </Svg>
  );
}

