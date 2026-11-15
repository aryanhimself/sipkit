import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Softphone, type SoftphoneProps } from '@/softphone';
import { createPhone } from '@/test/utils';
import { registerLocale } from './locales';
import { createPseudoLocale } from './pseudo';

async function renderRegistered(props: Partial<SoftphoneProps> = {}, config = {}) {
  const phone = createPhone(config);
  const utils = render(<Softphone softphone={phone} toaster={false} {...props} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return { phone, ...utils };
}

const root = () => screen.getByRole('region', { name: 'SipKit' });

describe('<Softphone locale>', () => {
  it('renders the dialpad, tabs and status in Nepali', async () => {
    await renderRegistered({ locale: 'ne' });
    expect(root().getAttribute('lang')).toBe('ne');
    expect(root().getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: 'कल गर्नुहोस्' })).toBeTruthy();
    expect(screen.getByLabelText('डायल गर्ने नम्बर')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /इतिहास/ })).toBeTruthy();
    expect(screen.getByTestId('registration-pill').textContent).toBe('अनलाइन');
    // Dialed digits stay Latin.
    expect(screen.getByRole('button', { name: '5' })).toBeTruthy();
  });

  it('switches language live without remounting', async () => {
    const phone = createPhone();
    const { rerender } = render(<Softphone softphone={phone} toaster={false} />);
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
    expect(screen.getByRole('button', { name: 'Call' })).toBeTruthy();
    rerender(<Softphone softphone={phone} toaster={false} locale="ne-NP" />);
    expect(screen.getByRole('button', { name: 'कल गर्नुहोस्' })).toBeTruthy();
    expect(root().getAttribute('lang')).toBe('ne-NP');
    rerender(<Softphone softphone={phone} toaster={false} locale="en" />);
    expect(screen.getByRole('button', { name: 'Call' })).toBeTruthy();
  });

  it('follows config.language when no prop is given', async () => {
    const { phone } = await renderRegistered({}, { language: 'ne' });
    expect(screen.getByRole('button', { name: 'कल गर्नुहोस्' })).toBeTruthy();
    await act(() => phone.updateConfig({ language: 'en' }));
    expect(screen.getByRole('button', { name: 'Call' })).toBeTruthy();
  });

  it('shows the in-call screen in Nepali', async () => {
    const user = userEvent.setup();
    await renderRegistered({ locale: 'ne' });
    await user.type(screen.getByLabelText('डायल गर्ने नम्बर'), '1002');
    await user.click(screen.getByRole('button', { name: 'कल गर्नुहोस्' }));
    const callScreen = await screen.findByTestId('call-screen');
    await waitFor(() => expect(callScreen.dataset.callState).toBe('connected'));
    expect(callScreen.getAttribute('aria-label')).toBe('1002 सँग कल');
    const controls = within(screen.getByRole('toolbar', { name: 'कल नियन्त्रण' }));
    await user.click(controls.getByRole('button', { name: 'होल्ड' }));
    expect(screen.getByTestId('call-status').textContent).toMatch(/^होल्डमा · \d+:\d\d$/);
    expect(controls.getByRole('button', { name: 'होल्ड हटाउनुहोस्' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'कल काट्नुहोस्' })).toBeTruthy();
  });

  it('applies host message overrides', async () => {
    await renderRegistered({ locale: 'ne', messages: { 'tab.contacts': 'ग्राहक' } });
    expect(screen.getByRole('tab', { name: /ग्राहक/ })).toBeTruthy();
  });

  it('lets the user pick the language in settings', async () => {
    const user = userEvent.setup();
    await renderRegistered();
    await user.click(screen.getByRole('tab', { name: /settings/i }));
    await user.selectOptions(screen.getByLabelText('Language'), 'ne');
    expect(screen.getByLabelText('भाषा')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /सेटिङ/ })).toBeTruthy();
  });

  it('picks up locales registered at runtime', async () => {
    await renderRegistered({ locale: 'hi' });
    expect(screen.getByRole('button', { name: 'Call' })).toBeTruthy(); // unknown → English
    act(() => registerLocale({ code: 'hi', messages: { 'dialpad.call': 'कॉल करें' } }));
    expect(screen.getByRole('button', { name: 'कॉल करें' })).toBeTruthy();
  });

  it('lays out right-to-left for an RTL locale', async () => {
    registerLocale(createPseudoLocale({ rtl: true }));
    await renderRegistered({ locale: 'ar-XB' });
    expect(root().getAttribute('dir')).toBe('rtl');
    expect(screen.getByRole('button', { name: '[Çáļļ]' })).toBeTruthy();
    // The keypad and number field keep left-to-right order.
    expect(screen.getByRole('group', { name: '[Ķéýþáð]' }).getAttribute('dir')).toBe('ltr');
    expect(screen.getByLabelText('[Ñûɱƀéŕ ţö ðíáļ]').getAttribute('dir')).toBe('ltr');
  });
});
