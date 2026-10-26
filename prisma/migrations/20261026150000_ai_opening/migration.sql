-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "aiOpeningEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiOpeningMaxChars" INTEGER NOT NULL DEFAULT 40,
ADD COLUMN     "aiOpeningTone" TEXT NOT NULL DEFAULT 'friendly';

-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN     "aiOpening" TEXT;

