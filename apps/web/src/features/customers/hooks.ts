import { useMutation, useQuery } from '@tanstack/react-query';
import * as customersApi from '../../lib/api/customers';

export const customersKeys = {
  list: () => ['customers', 'list'] as const,
};

export function useCustomers() {
  return useQuery({
    queryKey: customersKeys.list(),
    queryFn: customersApi.listCustomers,
  });
}

export function useExportCustomersCsv() {
  return useMutation({
    mutationFn: customersApi.exportCustomersCsv,
  });
}
