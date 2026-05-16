import { db } from "@/lib/db";

export default async function PostsPage() {
  const posts = await db.post.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, title: true, authorId: true },
  });

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Posts</h1>
      <ul className="space-y-2">
        {posts.map((post) => (
          <li key={post.id} className="border rounded p-3">
            <span className="font-medium">{post.title}</span>
            <span className="text-sm text-gray-500 ml-2">#{post.id}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
