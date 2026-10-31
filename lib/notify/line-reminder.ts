/**
 * Later LINE alerts: one hour after a handoff, and again a day after it, if
 * the owner still has not replied (no human message since, and the thread
 * is still waiting on him). A person who sent photos and was handed over
 * otherwise waits in silence; the owner asked to hear about it after a day.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue, LINE_REMIND_JOB_NAME, type LineRemindJob } from "@/lib/queue/client";
import { pushLineMessage } from "./line";

export const LINE_REMIND_DELAY_MS = 60 * 60 * 1000;
export const LINE_REMIND_DAY_MS = 24 * 60 * 60 * 1000;

export async function scheduleLineReminder(conversationId: string, text: string, now = new Date()): Promise<void> {
  const reminders: { after: "1h" | "1d"; delay: number }[] = [
    { after: "1h", delay: LINE_REMIND_DELAY_MS },
    { after: "1d", delay: LINE_REMIND_DAY_MS },
  ];
  for (const { after, delay } of reminders) {
    const job: LineRemindJob = { conversationId, handoffAt: now.toISOString(), text, after };
    await getDMQueue()
      .add(LINE_REMIND_JOB_NAME, job, {
        delay,
        jobId: `line_remind_${conversationId}_${now.getTime()}${after === "1d" ? "_1d" : ""}`,
      })
      .catch((error: unknown) => {
        console.error("[LINE] reminder schedule failed:", error instanceof Error ? error.message : error);
      });
  }
}

/** Pure, exposed for tests. */
export function reminderText(job: Pick<LineRemindJob, "text" | "after">): string {
  return job.after === "1d" ? `已經超過一天沒人回覆：${job.text}` : `提醒：${job.text}`;
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
  return pushLineMessage(reminderText(job));
}
