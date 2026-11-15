import { describe, expect, it } from 'vitest';
import { withListAlias } from '@/lib/core2/routes';

describe('Core 2 list replies match the Riya app', () => {
  it('keeps {items} and adds the resource name the app reads', () => {
    const body = withListAlias({ items: [{ id: 'a' }] }, 'contacts');
    expect(body.items).toEqual([{ id: 'a' }]);
    expect(body.contacts).toBe(body.items);
  });
});
