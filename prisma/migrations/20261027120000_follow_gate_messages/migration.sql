-- Optional follow-gate messages: one while the follow is re-checked, one when it is still missing.
ALTER TABLE "Automation" ADD COLUMN "followCheckingMessage" TEXT;
ALTER TABLE "Automation" ADD COLUMN "followNotYetMessage" TEXT;
