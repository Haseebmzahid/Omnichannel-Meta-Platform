import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as staffApi from '../../lib/api/staff';
import type { CreateStaffInput, StaffStatus } from '../../lib/api/types';

// No pagination/polling here, mirroring apps/api/src/staff/staff.service.ts's
// own "smallest useful shape for a per-clinic staff roster" reasoning — a
// plain query that refetches on window focus (TanStack Query's default) is
// enough for a list this size.

export const staffKeys = {
  list: () => ['staff', 'list'] as const,
};

export function useStaffList() {
  return useQuery({
    queryKey: staffKeys.list(),
    queryFn: staffApi.listStaff,
  });
}

export function useCreateStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStaffInput) => staffApi.createStaff(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: staffKeys.list() }),
  });
}

export function useUpdateStaffStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ staffId, status }: { staffId: string; status: StaffStatus }) => staffApi.updateStaffStatus(staffId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: staffKeys.list() }),
  });
}

export function useUpdateStaffPassword() {
  return useMutation({
    mutationFn: ({ staffId, password }: { staffId: string; password: string }) => staffApi.updateStaffPassword(staffId, password),
  });
}
