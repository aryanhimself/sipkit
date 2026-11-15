import { UserIcon, UsersIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';

export function CallAvatar({
  name,
  conference,
  ringing,
  size = 'lg',
  className,
}: {
  name?: string;
  conference?: boolean;
  ringing?: boolean;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const label = name ? initials(name) : '#';
  return (
    <div
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary/90 to-primary/60 font-semibold text-primary-foreground shadow-lg ring-4 ring-background',
        size === 'lg' ? 'size-20 text-2xl [&_svg]:size-8' : 'size-10 text-sm [&_svg]:size-5',
        ringing && 'animate-ring-pulse',
        className,
      )}
    >
      {conference ? <UsersIcon aria-hidden /> : label === '#' ? <UserIcon aria-hidden /> : label}
    </div>
  );
}
