import { useAuth } from '../contexts/AuthContext';

/**
 * Hook that returns whether the current user can edit configurations.
 * Returns true for owner, admin, and super_admin roles.
 * Returns false for member (read-only) role.
 */
export function useCanEdit(): boolean {
  const { canEdit } = useAuth();
  return canEdit;
}
