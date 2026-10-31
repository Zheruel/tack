import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export function Selection({ kind, name, label, description, selected, recommended, shortcut, disabled, onSelect }: {
  kind: 'radio' | 'checkbox'; name: string; label: string; description?: string;
  selected: boolean; recommended?: boolean; shortcut?: number; disabled?: boolean; onSelect: () => void;
}) {
  return <label className={`nx-option ${selected ? 'is-selected' : ''}`}>
    <input type={kind} name={name} checked={selected} disabled={disabled} onChange={onSelect} aria-label={label} />
    <span className={`nx-mark ${kind}`} aria-hidden="true">{selected && (kind === 'checkbox' ? <Check size={11} strokeWidth={2.6} /> : <span />)}</span>
    <span className="nx-option-copy"><span className="nx-option-label">{label}{recommended && <span className="nx-recommendation">Recommended</span>}</span>{description && <span className="nx-option-detail">{description}</span>}</span>
    {shortcut && <kbd className="nx-option-key" aria-hidden="true">{shortcut}</kbd>}
  </label>;
}

export function Key({ children }: { children: ReactNode }) { return <kbd className="nx-key" aria-hidden="true">{children}</kbd>; }
