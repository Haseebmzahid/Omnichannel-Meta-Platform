-- CreateTable
CREATE TABLE "channel_credentials" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "channelKey" "ChannelKey" NOT NULL,
    "accountRef" TEXT NOT NULL,
    "accountName" TEXT,
    "accessToken" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_credentials_clinicId_channelKey_key" ON "channel_credentials"("clinicId", "channelKey");

-- CreateIndex
CREATE INDEX "channel_credentials_clinicId_idx" ON "channel_credentials"("clinicId");

-- AddForeignKey
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
