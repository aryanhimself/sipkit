import { definePlugin } from '../plugin';
import type { Unsubscribe } from '../types';

export interface Contact {
  id: string;
  name: string;
  number: string;
  email?: string;
  favorite?: boolean;
  notes?: string;
}

export type ContactInput = Omit<Contact, 'id'>;

/** Public API of the contacts plugin: `softphone.plugin<ContactsApi>('contacts')`. */
export interface ContactsApi {
  /** All contacts sorted by name. */
  list(): Contact[];
  get(id: string): Contact | undefined;
  add(input: ContactInput): Contact;
  update(id: string, patch: Partial<ContactInput>): Contact;
  remove(id: string): void;
  /** Case-insensitive match on name/email/notes; digit-only match on number. */
  search(query: string): Contact[];
  /** Exact number match ignoring separators (used for caller-ID lookup). */
  findByNumber(number: string): Contact | undefined;
  onChange(listener: (contacts: Contact[]) => void): Unsubscribe;
}

export interface ContactsOptions {
  /** Seed contacts used only when storage is empty. */
  initial?: ContactInput[];
}

const KEY = 'contacts';
const digits = (s: string) => s.replace(/[^\d+*#]/g, '');

function validate(input: Partial<ContactInput>, partial: boolean): void {
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new TypeError('Contact name is required');
  }
  if (!partial || input.number !== undefined) {
    if (typeof input.number !== 'string' || !digits(input.number)) throw new TypeError('Contact number is required');
  }
}

/** Address book persisted in plugin storage with CRUD + search. */
export function contactsPlugin(options: ContactsOptions = {}) {
  return definePlugin<ContactsApi>({
    id: 'contacts',
    setup({ storage }) {
      let seq = 0;
      const newId = () => `c-${Date.now().toString(36)}-${++seq}`;
      const stored = storage.get<Contact[]>(KEY);
      let contacts: Contact[] = Array.isArray(stored)
        ? stored
        : (options.initial ?? []).map((c) => ({ ...c, id: newId() }));
      const listeners = new Set<(contacts: Contact[]) => void>();
      const sorted = () => [...contacts].sort((a, b) => a.name.localeCompare(b.name));
      const commit = (next: Contact[]) => {
        contacts = next;
        storage.set(KEY, contacts);
        const view = sorted();
        for (const l of [...listeners]) l(view);
      };
      const get = (id: string) => contacts.find((c) => c.id === id);

      const api: ContactsApi = {
        list: sorted,
        get,
        add(input) {
          validate(input, false);
          const contact: Contact = { ...input, name: input.name.trim(), id: newId() };
          commit([...contacts, contact]);
          return contact;
        },
        update(id, patch) {
          const existing = get(id);
          if (!existing) throw new RangeError(`No contact with id "${id}"`);
          validate(patch, true);
          const updated: Contact = { ...existing, ...patch, id };
          commit(contacts.map((c) => (c.id === id ? updated : c)));
          return updated;
        },
        remove(id) {
          commit(contacts.filter((c) => c.id !== id));
        },
        search(query) {
          const q = query.trim().toLowerCase();
          if (!q) return sorted();
          const qDigits = digits(q);
          return sorted().filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.email?.toLowerCase().includes(q) ?? false) ||
              (c.notes?.toLowerCase().includes(q) ?? false) ||
              (qDigits.length > 0 && digits(c.number).includes(qDigits)),
          );
        },
        findByNumber(number) {
          const n = digits(number);
          return n ? contacts.find((c) => digits(c.number) === n) : undefined;
        },
        onChange(listener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      };
      return { api, dispose: () => listeners.clear() };
    },
  });
}
