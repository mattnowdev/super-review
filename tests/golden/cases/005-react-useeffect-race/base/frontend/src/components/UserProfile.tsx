import React from "react";

interface UserProfileProps {
  userId: string;
}

export function UserProfile({ userId }: UserProfileProps): React.ReactElement {
  return (
    <section className="user-profile">
      <h2>User profile</h2>
      <p>Loading profile for {userId}…</p>
    </section>
  );
}
