/**
 * The Streamline mark: a play triangle trailing three streamlines.
 * Same geometry as scripts/make-icon.cjs — keep the two in step. In the app the
 * triangle follows the chosen accent; the generated icon uses the default.
 */
export function Logo({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role="img"
      aria-label="Streamline"
    >
      <rect width="256" height="256" rx="64" fill="#15171c" />
      <rect x="34" y="88" width="46" height="14" rx="7" fill="#eef0f4" opacity="0.5" />
      <rect x="22" y="121" width="70" height="14" rx="7" fill="#eef0f4" />
      <rect x="34" y="154" width="46" height="14" rx="7" fill="#eef0f4" opacity="0.5" />
      <path
        d="M104 64 L104 192 L212 128 Z"
        fill="var(--accent, #d7ff3d)"
        stroke="var(--accent, #d7ff3d)"
        strokeLinejoin="round"
        strokeWidth="10"
      />
    </svg>
  )
}
