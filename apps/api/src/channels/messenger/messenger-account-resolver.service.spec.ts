import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MessengerAccountResolverService } from './messenger-account-resolver.service';

describe('MessengerAccountResolverService', () => {
  it('1. resolves the configured Page id to the configured clinicId', () => {
    const service = new MessengerAccountResolverService('msgr-page-1', 'clinic-1');
    expect(service.resolveClinicId('msgr-page-1')).toBe('clinic-1');
  });

  it('2. never trusts an unrecognized Page id', () => {
    const service = new MessengerAccountResolverService('msgr-page-1', 'clinic-1');
    expect(service.resolveClinicId('some-other-page')).toBeNull();
  });

  it('3. returns null (not a hardcoded clinic) when nothing is configured', () => {
    const service = new MessengerAccountResolverService(undefined, undefined);
    expect(service.resolveClinicId('msgr-page-1')).toBeNull();
  });

  it('4. returns null when only one side of the mapping is configured', () => {
    expect(new MessengerAccountResolverService('msgr-page-1', undefined).resolveClinicId('msgr-page-1')).toBeNull();
    expect(new MessengerAccountResolverService(undefined, 'clinic-1').resolveClinicId('msgr-page-1')).toBeNull();
  });
});
