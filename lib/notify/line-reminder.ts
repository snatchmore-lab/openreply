/**
 * Second LINE alert: one hour after a handoff, if the owner still has not
 * replied (no human message since, and the thread is still waiting on him),
 * remind him once.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue, LINE_REMIND_JOB_NAME, type LineRemindJob } from "@/lib/queue/client";
import { pushLineMessage } from "./line";

export const LINE_REMIND_DELAY_MS = 60 * 60 * 1000;

export async function scheduleLineReminder(conversationId: string, text: string, now = new Date()): Promise<void> {
  const job: LineRemindJob = { conversationId, handoffAt: now.toISOString(), text };
  await getDMQueue()
    .add(LINE_REMIND_JOB_NAME, job, {
      delay: LINE_REMIND_DELAY_MS,
      jobId: `line_remind_${conversationId}_${now.getTime()}`,
    })
    .catch((error: unknown) => {
      console.error("[LINE] reminder schedule failed:", error instanceof Error ? error.message : error);
    });
}

/** Pure decision, exposed for tests. */
export function shouldRemind(
  conversation: { status: string; messages: { direction: string; createdAt: Date }[] },
  handoffAt: Date
): boolean {
  // Handed back to the bot or taken over from the dashboard: handled.
  if (conversation.status !== "NEEDS_HUMAN") return false;
  return !conversation.messages.some(
    (m) => m.direction === "OUT_HUMAN" && m.createdAt.getTime() >= handoffAt.getTime()
  );
}

export async function handleLineReminder(job: LineRemindJob): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: job.conversationId },
    select: { status: true, messages: { select: { direction: true, createdAt: true } } },
  });
  if (!conversation || !shouldRemind(conversation, new Date(job.handoffAt))) return false;
  return pushLineMessage(`提醒：${job.text}`);
}
