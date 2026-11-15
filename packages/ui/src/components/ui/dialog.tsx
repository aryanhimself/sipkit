import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModalDefault, usePortalContainer } from '@/lib/portal';
import { useT } from '@/i18n/context';

export function Dialog({ modal, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const modalDefault = useModalDefault();
  return <DialogPrimitive.Root data-slot="dialog" modal={modal ?? modalDefault} {...props} />;
}

export function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

const overlayClass =
  'absolute inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0';

export function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn(overlayClass, className)} {...props} />;
}

/** The focused element, looking inside shadow roots (the widget may live in one). */
function deepActiveElement(): HTMLElement | null {
  let el: Element | null = typeof document === 'undefined' ? null : document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el instanceof HTMLElement && el !== el.ownerDocument.body ? el : null;
}

/**
 * Remembers what had focus while the dialog mounts. Runs during render, before
 * an `autoFocus` field inside the dialog takes focus in the commit.
 */
function RememberFocus({ target }: { target: React.MutableRefObject<HTMLElement | null> }) {
  if (!target.current) target.current = deepActiveElement();
  return null;
}

/**
 * Dialogs are positioned inside the softphone root (absolute), not the
 * viewport, so they work in the compact widget and in Shadow DOM.
 *
 * Focus moves into the dialog when it opens (Radix) and goes back to whatever
 * had focus before when it closes, also for dialogs opened from code (no
 * DialogTrigger), where Radix alone would drop focus on the page body.
 */
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  const container = usePortalContainer();
  const modal = useModalDefault();
  const t = useT();
  const returnFocus = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal container={container}>
      <RememberFocus target={returnFocus} />
      {/* Radix only renders Overlay for modal dialogs; draw our own otherwise. */}
      {modal ? <DialogOverlay /> : <div data-slot="dialog-overlay" data-state="open" className={overlayClass} />}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'absolute top-1/2 left-1/2 z-50 grid w-[calc(100%-1.5rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-popover p-5 text-popover-foreground shadow-xl duration-200 outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          const el = returnFocus.current;
          returnFocus.current = null;
          if (!e.defaultPrevented && el?.isConnected) {
            e.preventDefault();
            el.focus({ preventScroll: true });
          }
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3.5 end-3.5 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
          >
            <XIcon aria-hidden />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 pe-6', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-base leading-none font-semibold', className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
}
