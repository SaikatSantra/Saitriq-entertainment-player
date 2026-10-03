-- CreateTable
CREATE TABLE "MetaConnection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "tokenExpiry" DATETIME NOT NULL,
    "fbUserId" TEXT NOT NULL,
    "fbName" TEXT,
    "fbProfilePic" TEXT,
    "igUserId" TEXT,
    "igUsername" TEXT,
    "pageId" TEXT,
    "pageName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_shop_key" ON "MetaConnection"("shop");
