import { useMutation } from '@tanstack/react-query';
import * as customersApi from '../../lib/api/customers';

export function useExportCustomersCsv() {
  return useMutation({
    mutationFn: customersApi.exportCustomersCsv,
  });
}
