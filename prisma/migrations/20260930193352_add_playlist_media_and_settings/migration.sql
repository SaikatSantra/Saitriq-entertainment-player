-- CreateTable
CREATE TABLE "PlaylistMedia" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistMedia_title_key" ON "PlaylistMedia"("title");

-- CreateIndex
CREATE INDEX "PlaylistMedia_isActive_sortOrder_idx" ON "PlaylistMedia"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_key_key" ON "AppSettings"("key");
