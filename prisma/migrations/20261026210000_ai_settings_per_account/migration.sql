-- CreateTable
CREATE TABLE "InstagramAccountAiSettings" (
    "instagramAccountId" TEXT NOT NULL,
    "faqEnabled" BOOLEAN NOT NULL DEFAULT false,
    "knowledgeBase" TEXT NOT NULL DEFAULT '',
    "handoffMessage" TEXT NOT NULL DEFAULT '這個問題我幫你轉給本人回覆，請稍等一下 🙏',
    "hourlyLimitPerUser" INTEGER NOT NULL DEFAULT 3,
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "maxReplyChars" INTEGER NOT NULL DEFAULT 300,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramAccountAiSettings_pkey" PRIMARY KEY ("instagramAccountId")
);

-- AddForeignKey
ALTER TABLE "InstagramAccountAiSettings" ADD CONSTRAINT "InstagramAccountAiSettings_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

