/**
 * Canonical dark wordmark for the redesign. Standardises the brand on ONE gold
 * (#EAB23C) and ONE navy (#0B1622), replacing the previous four-gold drift
 * across logo/OG/favicon/config. Mark + "CrewFlow" wordmark for the dark nav.
 */
export function WordmarkDark({ size = 30 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" fill="#0B1622" stroke="#24384C" />
        <path
          d="M8 11h16M8 16h12M8 21h8"
          stroke="#EAB23C"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-display text-[19px] font-bold leading-none tracking-tight text-ink">
        CrewFlow
      </span>
    </span>
  );
}
