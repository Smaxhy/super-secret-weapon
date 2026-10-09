/** X / Telegram / website links, as labelled buttons (opened in a new tab). */
export function SocialLinks({ twitter, telegram, website, size = 'sm' }: { twitter?: string | null; telegram?: string | null; website?: string | null; size?: 'sm' | 'md' }) {
  const links = [
    ['𝕏', 'X', twitter],
    ['✈', 'Telegram', telegram],
    ['🌐', 'Website', website],
  ].filter(([, , url]) => !!url) as Array<[string, string, string]>;
  if (!links.length) return size === 'md' ? <span className="text-sm text-muted">No socials linked</span> : null;
  const href = (u: string) => (u.startsWith('http') ? u : `https://${u}`);
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {links.map(([icon, label, url]) => (
        <a
          key={label}
          href={href(url)}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          aria-label={`${label}: ${url}`}
          title={url}
          className={`inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 text-ink hover:border-accent ${size === 'md' ? 'px-3 py-1 text-sm' : 'px-1.5 py-0.5 text-xs'}`}
        >
          <span aria-hidden="true">{icon}</span>
          {size === 'md' && label}
        </a>
      ))}
    </span>
  );
}
