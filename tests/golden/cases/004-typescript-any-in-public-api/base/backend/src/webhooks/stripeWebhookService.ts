import { logger } from "@/server/logger";
import { prisma } from "@/server/prisma";

/**
 * Discriminated union of the Stripe webhook events we currently care about.
 * Keep this narrow on purpose — adding a new event type must be an explicit
 * decision (new branch in `handleStripeWebhook`).
 */
export type StripeWebhookEvent =
  | {
      type: "payment_intent.succeeded";
      data: { object: { id: string; amount: number; currency: string } };
    }
  | {
      type: "charge.refunded";
      data: {
        object: {
          id: string;
          amount: number | null;
          amount_refunded: number;
          currency: string;
        };
      };
    };

export function isChargeRefunded(
  event: StripeWebhookEvent,
): event is Extract<StripeWebhookEvent, { type: "charge.refunded" }> {
  return event.type === "charge.refunded";
}

export function formatAmount(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export async function handleStripeWebhook(
  event: StripeWebhookEvent,
): Promise<void> {
  if (event.type === "payment_intent.succeeded") {
    const { id, amount, currency } = event.data.object;
    logger.info({ id, amount: formatAmount(amount, currency) }, "payment ok");
    await prisma.payment.update({
      where: { stripeId: id },
      data: { status: "succeeded", amountCents: amount },
    });
    return;
  }

  if (isChargeRefunded(event)) {
    const { id, amount_refunded, currency } = event.data.object;
    logger.info(
      { id, refunded: formatAmount(amount_refunded, currency) },
      "refund ok",
    );
    await prisma.payment.update({
      where: { stripeId: id },
      data: { status: "refunded", amountRefundedCents: amount_refunded },
    });
  }
}
