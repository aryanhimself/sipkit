import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon,
  title,
  description,
  className,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && (
        <div aria-hidden className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium">{title}</div>
      {description && <p className="max-w-[16rem] text-xs text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}
