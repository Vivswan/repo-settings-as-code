/** The one normalizer shared by two sections: collaborators and teams. */

/**
 * Collaborator/team GET responses report role_name in the read vocabulary
 * (read/write); the declared PUT vocabulary is pull/push. Map a declared
 * permission to the role name GET reports, so check mode compares like
 * with like. Custom org role names pass through untouched.
 */
export function roleForPermission(permission: string): string {
  const roles: Record<string, string> = { push: "write", pull: "read" };
  return roles[permission] ?? permission;
}
