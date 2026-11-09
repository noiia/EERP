// The BFF URL of a user's photo, only when Go says they have one (has_avatar).
export const avatarUrl = (userId: string, has?: boolean) =>
  has ? `/api/avatars/${encodeURIComponent(userId)}` : undefined
