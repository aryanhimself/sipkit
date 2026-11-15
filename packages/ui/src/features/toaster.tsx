import { toast } from 'sonner';
import { useSoftphone, useSoftphoneEvent } from 'sipkit-react';
import { Toaster } from '@/components/ui/sonner';
import { useI18n } from '@/i18n/context';

/** Renders sonner and shows a toast for every core `notification` event (respects `config.showToasts`). */
export function SoftphoneToaster({ theme, dir }: { theme?: 'light' | 'dark'; dir?: 'ltr' | 'rtl' }) {
  const api = useSoftphone();
  const i18n = useI18n();
  useSoftphoneEvent('notification', (n) => {
    if (!api.config.showToasts) return;
    const { title, message } = i18n.notification(n);
    const opts = message ? { description: message } : undefined;
    if (n.level === 'error') toast.error(title, opts);
    else if (n.level === 'warning') toast.warning(title, opts);
    else toast.info(title, opts);
  });
  return <Toaster theme={theme} dir={dir ?? i18n.dir} position="top-center" richColors closeButton duration={4000} />;
}
