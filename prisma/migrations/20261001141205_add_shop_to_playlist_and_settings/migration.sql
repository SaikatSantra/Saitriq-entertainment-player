/*
  Warnings:

  - Added the required column `shop` to the `AppSettings` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shop` to the `PlaylistMedia` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("id", "key", "updatedAt", "value") SELECT "id", "key", "updatedAt", "value" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
CREATE INDEX "AppSettings_shop_idx" ON "AppSettings"("shop");
CREATE UNIQUE INDEX "AppSettings_shop_key_key" ON "AppSettings"("shop", "key");
CREATE TABLE "new_PlaylistMedia" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PlaylistMedia" ("createdAt", "id", "isActive", "mediaType", "sortOrder", "sourceUrl", "thumbnailUrl", "title", "updatedAt") SELECT "createdAt", "id", "isActive", "mediaType", "sortOrder", "sourceUrl", "thumbnailUrl", "title", "updatedAt" FROM "PlaylistMedia";
DROP TABLE "PlaylistMedia";
ALTER TABLE "new_PlaylistMedia" RENAME TO "PlaylistMedia";
CREATE INDEX "PlaylistMedia_shop_isActive_sortOrder_idx" ON "PlaylistMedia"("shop", "isActive", "sortOrder");
CREATE UNIQUE INDEX "PlaylistMedia_shop_title_key" ON "PlaylistMedia"("shop", "title");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
