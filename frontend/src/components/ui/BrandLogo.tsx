export function BrandLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect
        x="2"
        y="3"
        width="20"
        height="18"
        rx="4"
        fill="#1E2130"
        stroke="#7C6CF6"
        strokeWidth="1.6"
      />
      <path
        d="M6.5 16L10.5 8L14 14L17.5 10"
        stroke="#C4BCFF"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="17.5" cy="10" r="1.8" fill="#7C6CF6" />
      <circle cx="6.5" cy="16" r="1.4" fill="#98A0B2" />
    </svg>
  );
}
