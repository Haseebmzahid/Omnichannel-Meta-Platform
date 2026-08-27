import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';

describe('WhatsAppAccountResolverService', () => {
  it('1. resolves the configured phone_number_id to the configured clinicId', () => {
    const service = new WhatsAppAccountResolverService('1234567890', 'clinic-1');
    expect(service.resolveClinicId('1234567890')).toBe('clinic-1');
  });

  it('2. never trusts an unrecognized phone_number_id', () => {
    const service = new WhatsAppAccountResolverService('1234567890', 'clinic-1');
    expect(service.resolveClinicId('some-other-number')).toBeNull();
  });

  it('3. returns null (not a hardcoded clinic) when nothing is configured', () => {
    const service = new WhatsAppAccountResolverService(undefined, undefined);
    expect(service.resolveClinicId('1234567890')).toBeNull();
  });

  it('4. returns null when only one side of the mapping is configured', () => {
    expect(new WhatsAppAccountResolverService('1234567890', undefined).resolveClinicId('1234567890')).toBeNull();
    expect(new WhatsAppAccountResolverService(undefined, 'clinic-1').resolveClinicId('1234567890')).toBeNull();
  });
});
