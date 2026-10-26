-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('AI', 'NEEDS_HUMAN', 'HUMAN');

-- CreateEnum
CREATE TYPE "ConversationMessageDirection" AS ENUM ('IN', 'OUT_AI', 'OUT_HUMAN');

-- CreateTable
CREATE TABLE "WorkspaceAiSettings" (
    "workspaceId" TEXT NOT NULL,
    "faqEnabled" BOOLEAN NOT NULL DEFAULT false,
    "knowledgeBase" TEXT NOT NULL DEFAULT '',
    "handoffMessage" TEXT NOT NULL DEFAULT '這個問題我幫你轉給本人回覆，請稍等一下 🙏',
    "hourlyLimitPerUser" INTEGER NOT NULL DEFAULT 3,
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "maxReplyChars" INTEGER NOT NULL DEFAULT 300,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceAiSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderName" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'AI',
    "aiReplyCount" INTEGER NOT NULL DEFAULT 0,
    "lastInboundAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "needsHumanAt" TIMESTAMP(3),
    "takenOverAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "ConversationMessageDirection" NOT NULL,
    "text" TEXT NOT NULL,
    "messageId" TEXT,
    "aiMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_idx" ON "Conversation"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastMessageAt_idx" ON "Conversation"("workspaceId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_instagramAccountId_senderId_key" ON "Conversation"("instagramAccountId", "senderId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessage_messageId_key" ON "ConversationMessage"("messageId");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_createdAt_idx" ON "ConversationMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkspaceAiSettings" ADD CONSTRAINT "WorkspaceAiSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

