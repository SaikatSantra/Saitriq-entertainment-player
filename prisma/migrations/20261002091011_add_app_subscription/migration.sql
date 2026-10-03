-- CreateTable
CREATE TABLE "AppSubscription" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "planId" TEXT NOT NULL DEFAULT 'FREE',
    "shopifySubscriptionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AppSubscription_shop_key" ON "AppSubscription"("shop");
