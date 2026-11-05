type Props = { size?: number; showWordmark?: boolean; dark?: boolean };

/** INKLINK brand mark + wordmark. Uses the public SVG symbol. */
export default function Logo({ size = 34, showWordmark = true, dark = false }: Props) {
  return (
    <a href="#hero" className="group flex items-center gap-3" aria-label="INKLINK home">
      <img
        src="/inklink-logo.svg"
        width={size}
        height={size}
        alt=""
        className="rounded-[9px] transition-transform duration-300 ease-cinema group-hover:scale-105"
        style={{ width: size, height: size }}
      />
      {showWordmark && (
        <span
          className={`text-[17px] font-semibold tracking-tightest ${
            dark ? 'text-paper' : 'text-ink'
          }`}
        >
          INKLINK
        </span>
      )}
    </a>
  );
}
