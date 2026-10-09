/** "Install app" button (Android/desktop Chrome) or iPhone instructions. Hidden once installed. */
import { useState } from 'react';
import { useInstall } from '../lib/pwa';

export function InstallButton({ compact = false }: { compact?: boolean }) {
  const { canPrompt, install, showIosHint } = useInstall();
  const [hintOpen, setHintOpen] = useState(false);

  if (canPrompt) {
    return (
      <button type="button" onClick={() => void install()} className={`rounded-lg bg-accent font-semibold text-white ${compact ? 'px-2.5 py-1 text-sm' : 'w-full px-3 py-2'}`}>
        ⤓ Install app
      </button>
    );
  }
  if (!showIosHint) return null;
  return (
    <div className="relative">
      <button type="button" onClick={() => setHintOpen((o) => !o)} aria-expanded={hintOpen} className={`rounded-lg border border-line font-medium text-ink ${compact ? 'px-2.5 py-1 text-sm' : 'w-full px-3 py-2'}`}>
        ⤓ Install
      </button>
      {hintOpen && (
        <div role="dialog" className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-line bg-surface p-3 text-sm text-ink shadow-lg">
          In Safari, tap <strong>Share</strong> <span aria-hidden="true">⎋</span> then <strong>Add to Home Screen</strong>. Solbot then opens full-screen like a normal app.
        </div>
      )}
    </div>
  );
}
