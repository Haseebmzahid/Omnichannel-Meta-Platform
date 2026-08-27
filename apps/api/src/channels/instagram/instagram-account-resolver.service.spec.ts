import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { InstagramAccountResolverService } from './instagram-account-resolver.service';

describe('InstagramAccountResolverService', () => {
  it('1. resolves the configured account id to the configured clinicId', () => {
    const service = new InstagramAccountResolverService('ig-account-1', 'clinic-1');
    expect(service.resolveClinicId('ig-account-1')).toBe('clinic-1');
  });

  it('2. never trusts an unrecognized account id', () => {
    const service = new InstagramAccountResolverService('ig-account-1', 'clinic-1');
    expect(service.resolveClinicId('some-other-account')).toBeNull();
  });

  it('3. returns null (not a hardcoded clinic) when nothing is configured', () => {
    const service = new InstagramAccountResolverService(undefined, undefined);
    expect(service.resolveClinicId('ig-account-1')).toBeNull();
  });

  it('4. returns null when only one side of the mapping is configured', () => {
    expect(new InstagramAccountResolverService('ig-account-1', undefined).resolveClinicId('ig-account-1')).toBeNull();
    expect(new InstagramAccountResolverService(undefined, 'clinic-1').resolveClinicId('ig-account-1')).toBeNull();
  });
});
