import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog/client';
import { cn } from './cn';

interface CoverageLedgerProps {
  types: CatalogObjectTypeDef[];
  selected?: string;
  onSelect: (name: string) => void;
}

/**
 * One tick per object type: filled when a human has named it, hollow when its
 * name is still a guess made by a regex.
 *
 * A count would say "13 of 58". The ledger shows *which* 58, that the named
 * ones cluster in the groups people actually work in, and that the long hollow
 * tail is the work remaining.
 */
export function CoverageLedger({ types, selected, onSelect }: CoverageLedgerProps) {
  const named = types.filter((t) => t.enriched).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-[3px]">
        {types.map((type, index) => (
          <button
            key={type.name}
            type="button"
            onClick={() => onSelect(type.name)}
            title={`${type.displayName} — ${type.enriched ? 'named' : 'not yet named'}`}
            aria-label={`${type.displayName}, ${type.enriched ? 'named' : 'not yet named'}`}
            style={{ animationDelay: `${Math.min(index * 12, 600)}ms` }}
            className={cn(
              'h-7 w-[7px] rounded-[1px] transition-all duration-150',
              'hover:h-9 focus-visible:h-9 focus-visible:outline-2',
              'focus-visible:outline-offset-2 focus-visible:outline-violet-500',
              type.enriched
                ? 'bg-emerald-500/85 hover:bg-emerald-500'
                : 'bg-amber-400/55 hover:bg-amber-400/90',
              selected === type.name && 'h-10 bg-violet-600 hover:bg-violet-600',
            )}
          />
        ))}
      </div>
      <p className="font-mono text-[11px] tracking-tight text-zinc-400 dark:text-zinc-500">
        <span className="text-zinc-950 dark:text-zinc-50">{named}</span> of {types.length} object
        types carry a name a person chose. The rest still answer to whatever the class was called.
      </p>
    </div>
  );
}
