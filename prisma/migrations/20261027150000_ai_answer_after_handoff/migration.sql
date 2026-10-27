-- FAQ bot: optionally keep answering knowledge-base questions after a handoff.
ALTER TABLE "WorkspaceAiSettings" ADD COLUMN "answerAfterHandoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InstagramAccountAiSettings" ADD COLUMN "answerAfterHandoff" BOOLEAN NOT NULL DEFAULT false;
