export function Logo({ big = false }: { big?: boolean }) {
  return (
    <span className={`logo ${big ? 'big' : ''}`} aria-label="Couchbeam">
      <svg viewBox="0 0 64 64" width={big ? 56 : 28} height={big ? 56 : 28} aria-hidden>
        <defs>
          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#f2b441" stopOpacity="0.95" />
            <stop offset="1" stopColor="#f2b441" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path d="M18 29 L60 10 L60 54 L18 35 Z" fill="url(#beam)" />
        <rect x="6" y="25" width="16" height="14" rx="4" fill="#f2b441" />
        <circle cx="14" cy="32" r="3.2" fill="#0e0c0a" />
      </svg>
      <b>couchbeam</b>
    </span>
  );
}
