import { describe, expect, it } from 'vitest';
import { buildMediaStorageKey } from './media-storage-key';

describe('buildMediaStorageKey', () => {
  it('is deterministic — the same input always produces the same key', () => {
    const input = { clinicId: 'clinic-1', messageId: 'msg-1', attachmentId: 'att-1' };
    expect(buildMediaStorageKey(input)).toBe(buildMediaStorageKey({ ...input }));
  });

  it('scopes the key by clinic, message, and attachment so none of them ever collide', () => {
    const base = { clinicId: 'clinic-1', messageId: 'msg-1', attachmentId: 'att-1' };
    const original = buildMediaStorageKey(base);

    expect(buildMediaStorageKey({ ...base, clinicId: 'clinic-2' })).not.toBe(original);
    expect(buildMediaStorageKey({ ...base, messageId: 'msg-2' })).not.toBe(original);
    expect(buildMediaStorageKey({ ...base, attachmentId: 'att-2' })).not.toBe(original);
  });

  it('embeds clinicId and messageId directly in the key path, not just the attachmentId', () => {
    const key = buildMediaStorageKey({ clinicId: 'clinic-abc', messageId: 'msg-xyz', attachmentId: 'att-123' });
    expect(key).toBe('clinics/clinic-abc/messages/msg-xyz/attachments/att-123');
  });
});
