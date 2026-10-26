-- AlterEnum
ALTER TYPE "DmStatus" ADD VALUE 'SKIPPED_AI_NO_MATCH';

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "aiMatchDescription" TEXT,
ADD COLUMN     "aiMatchEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiMatchThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8;

-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN     "aiDecision" JSONB,
ADD COLUMN     "matchSource" TEXT;

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "feature" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCache" (
    "key" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AiUsage_workspaceId_date_idx" ON "AiUsage"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_workspaceId_date_feature_key" ON "AiUsage"("workspaceId", "date", "feature");

-- CreateIndex
CREATE INDEX "AiCache_createdAt_idx" ON "AiCache"("createdAt");

