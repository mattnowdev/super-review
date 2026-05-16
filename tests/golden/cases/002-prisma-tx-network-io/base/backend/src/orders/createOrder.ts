import { prisma } from "@/db";

export async function createOrder(input: { userId: string; total: number; source: string }) {
  const order = await prisma.order.create({
    data: { userId: input.userId, total: input.total, status: "pending" },
  });
  return order;
}
