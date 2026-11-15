import { describe, expect, it } from 'vitest';
import { DEFAULT_HOTKEYS, displayAccelerator, normalizeAccelerator, planHotkeys } from './hotkeys';

describe('normalizeAccelerator', () => {
  it.each([
    ['ctrl+shift+a', 'Control+Shift+A'],
    ['CmdOrCtrl+Shift+H', 'CommandOrControl+Shift+H'],
    ['shift+cmdorctrl+h', 'CommandOrControl+Shift+H'],
    ['Alt+F9', 'Alt+F9'],
    ['option+space', 'Alt+Space'],
    ['Ctrl++', 'Control+Plus'],
    ['Control+num5', 'Control+num5'],
    ['Super+Enter', 'Super+Return'],
    ['F13', 'F13'],
    ['MediaPlayPause', 'MediaPlayPause'],
    ['Ctrl+/', 'Control+/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAccelerator(input)).toEqual({ ok: true, accelerator: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['Ctrl+Shift', 'noKey'],
    ['A', 'needsModifier'],
    ['F5', 'needsModifier'],
    ['Ctrl+A+B', 'tooManyKeys'],
    ['Ctrl+Hyper', 'unknownKey'],
    ['Ctrl+Ctrl+A', 'duplicateModifier'],
    ['Ctrl+ +A', 'unknownKey'],
  ])('%s → %s', (input, error) => {
    expect(normalizeAccelerator(input)).toEqual({ ok: false, error });
  });
});

describe('planHotkeys', () => {
  it('maps the defaults to answer + hangup', () => {
    expect(planHotkeys(DEFAULT_HOTKEYS)).toEqual({
      bindings: [
        { action: 'answer', accelerator: 'CommandOrControl+Shift+A' },
        { action: 'hangup', accelerator: 'CommandOrControl+Shift+H' },
      ],
      problems: [],
    });
  });

  it('reports invalid and duplicate accelerators, first one wins', () => {
    const plan = planHotkeys({ answer: 'Ctrl+Shift+A', hangup: 'control+shift+a', toggleMute: 'Q', toggleDnd: 'Alt+D' });
    expect(plan.bindings).toEqual([
      { action: 'answer', accelerator: 'Control+Shift+A' },
      { action: 'toggleDnd', accelerator: 'Alt+D' },
    ]);
    expect(plan.problems).toEqual([
      { action: 'hangup', accelerator: 'control+shift+a', error: 'duplicate' },
      { action: 'toggleMute', accelerator: 'Q', error: 'needsModifier' },
    ]);
  });

  it('treats CommandOrControl and Control as the same key on Windows/Linux', () => {
    const plan = planHotkeys({ answer: 'CommandOrControl+K', hangup: 'Control+K' });
    expect(plan.problems).toEqual([{ action: 'hangup', accelerator: 'Control+K', error: 'duplicate' }]);
  });

  it('skips unbound actions', () => {
    expect(planHotkeys({ answer: '' }).bindings).toEqual([]);
  });
});

describe('displayAccelerator', () => {
  it('uses symbols on macOS and words elsewhere', () => {
    expect(displayAccelerator('CommandOrControl+Shift+A', 'darwin')).toBe('⌘⇧A');
    expect(displayAccelerator('CommandOrControl+Shift+A', 'win32')).toBe('Ctrl+Shift+A');
    expect(displayAccelerator('Alt+F9', 'linux')).toBe('Alt+F9');
  });
});
