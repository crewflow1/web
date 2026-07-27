/**
 * CrewFlow logo mark. Shared across the marketing chrome and kept identical
 * to the homepage mark + app/icon.svg so the brand presents one consistent
 * symbol everywhere (favicon, OG image, header, footer).
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect width="32" height="32" rx="8" fill="#0F172A" />
      <path
        d="M8 11h16M8 16h12M8 21h8"
        stroke="#fbbf24"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
