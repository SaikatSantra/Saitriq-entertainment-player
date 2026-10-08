import { useLoaderData, useFetcher, data } from "react-router";
import {
  Page,
  Layout,
  Card,
  Button,
  IndexTable,
  Text,
  Badge,
  Modal,
  FormLayout,
  TextField,
  EmptyState,
  InlineStack,
  BlockStack,
  Thumbnail,
  Divider,
  Toast,
  Box,
  Banner,
  DropZone,
  Spinner,
  ButtonGroup,
  useIndexResourceState,
  Icon,
} from "@shopify/polaris";
import { UploadIcon } from "@shopify/polaris-icons";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect } from "react";

// ─── GraphQL for Shopify Files upload ────────────────────────────────────────

const STAGED_UPLOADS_CREATE = `#graphql
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on Video {
          id fileStatus
          sources { url mimeType }
        }
      }
      userErrors { field message }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query fileStatus($id: ID!) {
    node(id: $id) {
      ... on Video {
        id fileStatus
        sources { url mimeType }
      }
    }
  }
`;

// ─── Server helpers ───────────────────────────────────────────────────────────

function classifyFile(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const videoMimeTypes = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  if (videoMimeTypes[ext])
    return { resource: "VIDEO", mimeType: videoMimeTypes[ext], contentType: "VIDEO" };
  throw new Error(`Unsupported file type: .${ext}. Only MP4, MOV, and WebM are supported.`);
}

function classifyThumbnailFile(file) {
  const imageMimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  const ext = file.name.split(".").pop().toLowerCase();
  const mimeType = imageMimeTypes[ext];
  if (!mimeType || (file.type && file.type !== mimeType)) {
    throw new Error("Thumbnail must be a JPEG, PNG, WebP, or GIF image.");
  }
  return { resource: "IMAGE", mimeType, contentType: "IMAGE" };
}

async function pollFileReady(admin, fileId) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await admin.graphql(FILE_STATUS_QUERY, { variables: { id: fileId } });
    const { node } = (await res.json()).data ?? {};
    if (!node) throw new Error("File node not found during polling");
    if (node.fileStatus === "READY") {
      const url =
        node.sources?.find((s) => s.mimeType?.includes("mp4"))?.url ??
        node.sources?.[0]?.url;
      return url;
    }
    if (node.fileStatus === "FAILED") throw new Error("Shopify file processing failed");
  }
  throw new Error("Timed out waiting for file to be ready (90 s)");
}

async function uploadShopifyFile(admin, file, { resource, mimeType, contentType }) {
  const filename = file.name;
  const stageRes = await admin.graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [{
        filename,
        mimeType,
        resource,
        fileSize: String(file.size),
        httpMethod: "POST",
      }],
    },
  });
  const stageJson = await stageRes.json();
  const stagedUpload = stageJson.data?.stagedUploadsCreate;
  const stageErrors = stagedUpload?.userErrors ?? [];
  if (stageErrors.length) throw new Error(stageErrors.map((error) => error.message).join(", "));
  if (!stagedUpload?.stagedTargets?.[0]) {
    throw new Error("Shopify did not return a staged upload target.");
  }

  const target = stagedUpload.stagedTargets[0];
  const uploadForm = new FormData();
  target.parameters.forEach(({ name, value }) => uploadForm.append(name, value));
  uploadForm.append("file", file);

  const uploadResponse = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadResponse.ok) {
    throw new Error(`Shopify file upload failed with HTTP ${uploadResponse.status}.`);
  }

  const createResponse = await admin.graphql(FILE_CREATE, {
    variables: {
      files: [{ filename, contentType, originalSource: target.resourceUrl }],
    },
  });
  const createJson = await createResponse.json();
  const createPayload = createJson.data?.fileCreate;
  const createErrors = createPayload?.userErrors ?? [];
  if (createErrors.length) throw new Error(createErrors.map((error) => error.message).join(", "));
  const createdFile = createPayload?.files?.[0];
  if (!createdFile) throw new Error("Shopify did not return the uploaded file.");

  return pollFileReady(admin, createdFile.id);
}

function readMediaFields(formData, sortOrderOverride) {
  const value = (name) => {
    const field = formData.get(name);
    return typeof field === "string" ? field.trim() : "";
  };
  const title = value("title");
  const sourceUrl = value("sourceUrl");
  const thumbnailUrl = value("thumbnailUrl");
  const isActive = value("isActive") === "true";
  const sortOrderValue = sortOrderOverride ?? Number(value("sortOrder"));

  if (!title || title.length > 120) {
    throw new Error("Title is required and must be 120 characters or fewer.");
  }
  let source;
  try {
    source = new URL(sourceUrl);
  } catch {
    throw new Error("Enter a valid source URL.");
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    throw new Error("Source URL must use HTTP or HTTPS.");
  }
  if (thumbnailUrl) {
    let thumbnail;
    try {
      thumbnail = new URL(thumbnailUrl);
    } catch {
      throw new Error("Enter a valid thumbnail URL.");
    }
    if (!["http:", "https:"].includes(thumbnail.protocol)) {
      throw new Error("Thumbnail URL must use HTTP or HTTPS.");
    }
  }
  if (!Number.isSafeInteger(sortOrderValue) || sortOrderValue < 0) {
    throw new Error("Sort order must be a non-negative integer.");
  }

  return {
    title,
    mediaType: "video",
    sourceUrl: source.toString(),
    thumbnailUrl: thumbnailUrl || null,
    isActive,
    sortOrder: sortOrderValue,
  };
}

function readMediaId(formData) {
  const id = Number(formData.get("id"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const mediaItems = await prisma.playlistMedia.findMany({
    where: { shop },
    orderBy: { sortOrder: "asc" },
  });
  return data({
    mediaItems,
    shop,
    maxVideos: 5,
  });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    // ── Upload file to Shopify Files ────────────────────────────────────────
    if (intent === "upload") {
      // Check 5-video limit before uploading
      const count = await prisma.playlistMedia.count({ where: { shop } });
      if (count >= 5) {
        return data(
          { success: false, limitReached: true, limit: 5 },
          { status: 403 },
        );
      }

      const file = formData.get("file");
      if (!file || typeof file === "string")
        return data({ success: false, error: "No file received" }, { status: 400 });

      const classification = classifyFile(file.name);
      const cdnUrl = await uploadShopifyFile(admin, file, classification);
      return data({ success: true, url: cdnUrl });
    }

    if (intent === "uploadThumbnail") {
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return data({ success: false, error: "No thumbnail image received." }, { status: 400 });
      }
      const classification = classifyThumbnailFile(file);
      const cdnUrl = await uploadShopifyFile(admin, file, classification);
      return data({ success: true, url: cdnUrl });
    }

    // ── CRUD operations ─────────────────────────────────────────────────────
    if (intent === "create") {
      // ── 5-video limit check ─────────────────────────────────────────────
      const count = await prisma.playlistMedia.count({ where: { shop } });
      if (count >= 5) {
        return data(
          { success: false, limitReached: true, limit: 5 },
          { status: 403 },
        );
      }
      const maxOrder = await prisma.playlistMedia.aggregate({
        where: { shop },
        _max: { sortOrder: true },
      });
      const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;
      const item = await prisma.playlistMedia.create({
        data: {
          shop,
          ...readMediaFields(formData, nextOrder),
        },
      });
      return data({ success: true, intent: "create", item });
    }

    if (intent === "update") {
      const id = readMediaId(formData);
      if (!id) return data({ success: false, error: "Invalid media item ID." }, { status: 400 });
      const item = await prisma.$transaction(async (tx) => {
        const ownedItem = await tx.playlistMedia.findFirst({
          where: { id, shop },
          select: { id: true },
        });
        if (!ownedItem) return null;
        return tx.playlistMedia.update({
          where: { id },
          data: readMediaFields(formData),
        });
      });
      if (!item) return data({ success: false, error: "Media item not found." }, { status: 404 });
      return data({ success: true, intent: "update", item });
    }

    if (intent === "delete") {
      const id = readMediaId(formData);
      if (!id) return data({ success: false, error: "Invalid media item ID." }, { status: 400 });
      const { count } = await prisma.playlistMedia.deleteMany({ where: { id, shop } });
      if (!count) return data({ success: false, error: "Media item not found." }, { status: 404 });
      return data({ success: true, intent: "delete" });
    }

    if (intent === "toggleActive") {
      const id = readMediaId(formData);
      if (!id) return data({ success: false, error: "Invalid media item ID." }, { status: 400 });
      const item = await prisma.$transaction(async (tx) => {
        const current = await tx.playlistMedia.findFirst({
          where: { id, shop },
          select: { isActive: true },
        });
        if (!current) return null;
        await tx.playlistMedia.updateMany({
          where: { id, shop, isActive: current.isActive },
          data: { isActive: !current.isActive },
        });
        return tx.playlistMedia.findFirst({ where: { id, shop } });
      });
      if (!item) return data({ success: false, error: "Media item not found." }, { status: 404 });
      return data({ success: true, intent: "toggleActive", item });
    }

    if (intent === "reorder") {
      const rawItems = formData.get("items");
      if (typeof rawItems !== "string") {
        return data({ success: false, error: "Invalid playlist order." }, { status: 400 });
      }
      const items = JSON.parse(rawItems);
      if (
        !Array.isArray(items) ||
        items.some((item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          !Number.isSafeInteger(item.id) ||
          item.id < 1 ||
          !Number.isSafeInteger(item.sortOrder) ||
          item.sortOrder < 0
        ) ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        new Set(items.map(({ sortOrder }) => sortOrder)).size !== items.length
      ) {
        return data({ success: false, error: "Invalid playlist order." }, { status: 400 });
      }
      const ownedItems = await prisma.playlistMedia.findMany({
        where: { shop },
        select: { id: true },
      });
      const ownedItemIds = new Set(ownedItems.map(({ id }) => id));
      if (
        ownedItems.length !== items.length ||
        items.some(({ id }) => !ownedItemIds.has(id))
      ) {
        return data({ success: false, error: "Playlist changed; reload and try again." }, { status: 409 });
      }
      await prisma.$transaction(
        items.map(({ id, sortOrder }) =>
          prisma.playlistMedia.updateMany({
            where: { id, shop },
            data: { sortOrder },
          }),
        ),
      );
      return data({ success: true, intent: "reorder" });
    }
  } catch (err) {
    console.error(`[playlist action:${intent}]`, err);
    return data({ success: false, error: err.message }, { status: 422 });
  }

  return data({ success: false, error: "Unknown intent" }, { status: 400 });
};

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  title: "", mediaType: "video", sourceUrl: "",
  thumbnailUrl: "", isActive: true, sortOrder: 0,
};

const FALLBACK_THUMB =
  "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";

const ACCEPTED_MIME = {
  video: "video/mp4,video/quicktime,video/webm",
};
const ACCEPTED_EXT = {
  video: ".mp4  .mov  .webm",
};

function SummaryCard({ label, value, tone = "default" }) {
  const toneMap = {
    default: "bg-surface-secondary",
    success: "bg-fill-success-secondary",
    info: "bg-fill-info-secondary",
    warning: "bg-fill-warning-secondary",
  };

  return (
    <Box
      background={toneMap[tone] || toneMap.default}
      borderRadius="200"
      paddingInline="300"
      paddingBlock="200"
    >
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <Text variant="headingMd" as="span" fontWeight="semibold">{value}</Text>
        <Text variant="bodySm" tone="subdued" as="span">{label}</Text>
      </InlineStack>
    </Box>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PlaylistAdmin() {
  // loader data — single source of truth
  const {
    mediaItems,
    maxVideos,
  } = useLoaderData();
  const atLimit = mediaItems.length >= maxVideos;

  // One fetcher for CRUD mutations, one dedicated fetcher for file upload
  const crudFetcher   = useFetcher({ key: "playlist-crud" });
  const uploadFetcher = useFetcher({ key: "playlist-upload" });
  const thumbnailUploadFetcher = useFetcher({ key: "playlist-thumbnail-upload" });

  // ── Modal state ───────────────────────────────────────────────────────────
  const [modalOpen,       setModalOpen]       = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [editingItem,     setEditingItem]     = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [form,            setForm]            = useState(EMPTY_FORM);
  const [sourceTab,       setSourceTab]       = useState(0); // 0=URL 1=Upload
  const [droppedFile,     setDroppedFile]     = useState(null);
  const [thumbnailFile,  setThumbnailFile]  = useState(null);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toastActive,  setToastActive]  = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastIsError, setToastIsError] = useState(false);

  const showToast = useCallback((msg, isError = false) => {
    setToastMessage(msg);
    setToastIsError(isError);
    setToastActive(true);
  }, []);

  // ── Upload state (derived from uploadFetcher) ─────────────────────────────
  const isUploading = uploadFetcher.state !== "idle";
  const uploadData  = uploadFetcher.data;
  const uploadDone  = uploadData?.success === true;
  const uploadError = uploadData?.success === false && !uploadData?.limitReached;
  const uploadLimitReached = uploadData?.limitReached === true;

  // When upload finishes successfully, store the CDN URL in form.sourceUrl
  useEffect(() => {
    if (uploadDone && uploadData?.url) {
      setForm((p) => ({ ...p, sourceUrl: uploadData.url }));
    }
  }, [uploadDone, uploadData?.url]);

  useEffect(() => {
    if (thumbnailUploadFetcher.data?.success && thumbnailUploadFetcher.data?.url) {
      setForm((p) => ({ ...p, thumbnailUrl: thumbnailUploadFetcher.data.url }));
    }
  }, [thumbnailUploadFetcher.data]);

  // When CRUD fetcher finishes, show feedback
  useEffect(() => {
    if (crudFetcher.state === "idle" && crudFetcher.data) {
      const d = crudFetcher.data;
      if (!d.success) {
        showToast(d.error || "Something went wrong", true);
      }
    }
  }, [crudFetcher.state, crudFetcher.data, showToast]);

  // ── useIndexResourceState ─────────────────────────────────────────────────
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(mediaItems, {
      resourceIDResolver: (item) => String(item.id),
    });

  // ── Modal helpers ─────────────────────────────────────────────────────────

  const resetUpload = useCallback(() => {
    setDroppedFile(null);
    setThumbnailFile(null);
    setSourceTab(0);
  }, []);

  const openCreate = useCallback(() => {
    setEditingItem(null);
    setForm({ ...EMPTY_FORM, sortOrder: mediaItems.length });
    resetUpload();
    setModalOpen(true);
  }, [mediaItems.length, resetUpload]);

  const openEdit = useCallback((item) => {
    setEditingItem(item);
    setForm({
      title: item.title, mediaType: item.mediaType,
      sourceUrl: item.sourceUrl, thumbnailUrl: item.thumbnailUrl ?? "",
      isActive: item.isActive, sortOrder: item.sortOrder,
    });
    resetUpload();
    setModalOpen(true);
  }, [resetUpload]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setEditingItem(null);
    resetUpload();
  }, [resetUpload]);

  // ── File drop ─────────────────────────────────────────────────────────────

  const handleDrop = useCallback((_all, accepted) => {
    const file = accepted[0];
    if (!file) return;
    setDroppedFile(file);
    setForm((p) => ({
      ...p,
      mediaType: "video",
      title: p.title || file.name.replace(/\.[^.]+$/, ""),
      sourceUrl: "", // clear previous URL
    }));
  }, []);

  const handleThumbnailDrop = useCallback((_all, accepted) => {
    setThumbnailFile(accepted[0] ?? null);
  }, []);

  // ── Upload to Shopify Files (via authenticated action) ────────────────────

  const handleUploadFile = useCallback(() => {
    if (!droppedFile) return;
    const fd = new FormData();
    fd.append("intent", "upload");
    fd.append("file", droppedFile);
    uploadFetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
  }, [droppedFile, uploadFetcher]);

  const handleUploadThumbnail = useCallback(() => {
    if (!thumbnailFile) return;
    const fd = new FormData();
    fd.append("intent", "uploadThumbnail");
    fd.append("file", thumbnailFile);
    thumbnailUploadFetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
  }, [thumbnailFile, thumbnailUploadFetcher]);

  // ── Save item (create / update) ───────────────────────────────────────────

  const handleSubmit = useCallback(() => {
    const finalUrl = form.sourceUrl.trim();
    if (!finalUrl) {
      showToast("Provide a URL or upload a file first.", true);
      return;
    }
    const fd = new FormData();
    fd.append("intent", editingItem ? "update" : "create");
    if (editingItem) {
      fd.append("id", String(editingItem.id));
      fd.append("sortOrder", String(form.sortOrder));
    }
    fd.append("title",        form.title);
    fd.append("mediaType",    form.mediaType);
    fd.append("sourceUrl",    finalUrl);
    fd.append("thumbnailUrl", form.thumbnailUrl);
    fd.append("isActive",     String(form.isActive));
    crudFetcher.submit(fd, { method: "POST" });
    closeModal();
    showToast(editingItem ? "Item updated." : "Item added to playlist.");
  }, [form, editingItem, crudFetcher, closeModal, showToast]);

  // ── Delete ────────────────────────────────────────────────────────────────

  const confirmDelete = useCallback((id) => {
    setPendingDeleteId(id);
    setDeleteModalOpen(true);
  }, []);

  const handleDelete = useCallback(() => {
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", String(pendingDeleteId));
    crudFetcher.submit(fd, { method: "POST" });
    setDeleteModalOpen(false);
    showToast("Item deleted.");
  }, [pendingDeleteId, crudFetcher, showToast]);

  // ── Toggle / Reorder ──────────────────────────────────────────────────────

  const handleToggleActive = useCallback((id) => {
    const fd = new FormData();
    fd.append("intent", "toggleActive");
    fd.append("id", String(id));
    crudFetcher.submit(fd, { method: "POST" });
  }, [crudFetcher]);

  const handleMove = useCallback((index, direction) => {
    const arr = [...mediaItems];
    const swapIdx = direction === "up" ? index - 1 : index + 1;
    if (swapIdx < 0 || swapIdx >= arr.length) return;
    [arr[index], arr[swapIdx]] = [arr[swapIdx], arr[index]];
    const reordered = arr.map((item, i) => ({ id: item.id, sortOrder: i }));
    const fd = new FormData();
    fd.append("intent", "reorder");
    fd.append("items", JSON.stringify(reordered));
    crudFetcher.submit(fd, { method: "POST" });
  }, [mediaItems, crudFetcher]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const isMutating = crudFetcher.state !== "idle";

  const canSave =
    form.title.trim() &&
    form.sourceUrl.trim() &&
    !isMutating &&
    !isUploading &&
    thumbnailUploadFetcher.state === "idle";

  const sourceTabs = [
    { id: "url",    content: "Paste URL"   },
    { id: "upload", content: "Upload file" },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Page
      title="Manage Playlist"
      subtitle={`${mediaItems.length} / ${maxVideos} video${mediaItems.length !== 1 ? "s" : ""} in your playlist`}
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <Layout>
        {atLimit && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={`You've reached the ${maxVideos} video limit`}
            >
              <Text variant="bodySm">
                Delete a video to add a new one. This private app allows a maximum of {maxVideos} videos.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <Box padding="300">
              <InlineStack gap="300" blockAlign="center" wrap={false}>
                <Text variant="headingSm" as="h2" fontWeight="semibold">Playlist overview</Text>
                <SummaryCard label="Total" value={mediaItems.length} />
                <SummaryCard
                  label="Active"
                  value={mediaItems.filter((item) => item.isActive).length}
                  tone="success"
                />
                <SummaryCard
                  label="Videos"
                  value={mediaItems.filter((item) => item.mediaType === "video").length}
                  tone="warning"
                />
              </InlineStack>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <BlockStack gap="050">
                  <Text variant="headingSm" as="h2" fontWeight="semibold">Video library</Text>
                  <Text variant="bodySm" tone="subdued">
                    Manage the MP4 videos shown in your storefront player.
                  </Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  <Badge tone="info">
                    {mediaItems.length} / {maxVideos}
                  </Badge>
                  {atLimit ? (
                    <Button variant="primary" disabled>Limit reached</Button>
                  ) : (
                    <Button variant="primary" onClick={openCreate}>Add video</Button>
                  )}
                </InlineStack>
              </InlineStack>
            </Box>
            {mediaItems.length === 0 ? (
              <EmptyState heading="Your playlist is empty" image={FALLBACK_THUMB}>
                <Text tone="subdued">
                  Upload MP4 files to Shopify Files, or paste direct MP4 URLs.
                </Text>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "video", plural: "videos" }}
                itemCount={mediaItems.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "Preview" },
                  { title: "Title" },
                  { title: "Status" },
                  { title: "Position" },
                  { title: "Actions" },
                ]}
                loading={isMutating}
              >
                {mediaItems.map((item, index) => (
                  <IndexTable.Row
                    id={String(item.id)}
                    key={item.id}
                    selected={selectedResources.includes(String(item.id))}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <Thumbnail
                        source={item.thumbnailUrl || FALLBACK_THUMB}
                        alt={item.title}
                        size="medium"
                      />
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text variant="bodyMd" fontWeight="semibold" as="span">
                          {item.title}
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="span">
                          {item.sourceUrl.length > 55
                            ? `${item.sourceUrl.slice(0, 55)}…`
                            : item.sourceUrl}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Badge tone={item.isActive ? "success" : "critical"}>
                        {item.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <ButtonGroup variant="segmented">
                        <Button
                          size="micro"
                          disabled={index === 0 || isMutating}
                          onClick={() => handleMove(index, "up")}
                          accessibilityLabel="Move up"
                        >↑</Button>
                        <Button
                          size="micro"
                          disabled={index === mediaItems.length - 1 || isMutating}
                          onClick={() => handleMove(index, "down")}
                          accessibilityLabel="Move down"
                        >↓</Button>
                      </ButtonGroup>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack gap="200" wrap={false}>
                        <Button
                          size="micro"
                          loading={isMutating}
                          onClick={() => handleToggleActive(item.id)}
                        >
                          {item.isActive ? "Disable" : "Enable"}
                        </Button>
                        <Button size="micro" onClick={() => openEdit(item)}>
                          Edit
                        </Button>
                        <Button
                          size="micro"
                          tone="critical"
                          onClick={() => confirmDelete(item.id)}
                        >
                          Delete
                        </Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info" title="Playlist order">
              Videos appear in the storefront widget in the order listed here.
              Use ↑↓ to reorder.
            </Banner>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">
                  Supported sources
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <Text variant="bodySm" fontWeight="medium">Paste a URL:</Text>
                  <InlineStack gap="150" wrap>
                    {[".mp4", ".mov", ".webm"].map((s) => (
                      <Box
                        key={s}
                        background="bg-fill-secondary"
                        borderRadius="200"
                        paddingInline="200"
                        paddingBlock="100"
                      >
                        <Text variant="bodySm" fontWeight="medium">{s}</Text>
                      </Box>
                    ))}
                  </InlineStack>
                  <Text variant="bodySm" fontWeight="medium">Or upload a file:</Text>
                  <InlineStack gap="150" wrap>
                    {[".mp4", ".mov", ".webm"].map((s) => (
                      <Box
                        key={s}
                        background="bg-fill-secondary"
                        borderRadius="200"
                        paddingInline="200"
                        paddingBlock="100"
                      >
                        <Text variant="bodySm" fontWeight="medium">{s}</Text>
                      </Box>
                    ))}
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* ── Add / Edit Modal ───────────────────────────────────────────────── */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingItem ? "Edit video" : "Add video"}
        primaryAction={{
          content: "Save",
          onAction: handleSubmit,
          disabled: !canSave,
          loading: isMutating,
        }}
        secondaryActions={[{ content: "Cancel", onAction: closeModal }]}
        size="large"
      >
        {/* Basic fields */}
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Title"
              value={form.title}
              onChange={(v) => setForm((p) => ({ ...p, title: v }))}
              autoComplete="off"
              placeholder="e.g. Product Demo Video"
              requiredIndicator
            />
          </FormLayout>
        </Modal.Section>

        {/* Source tabs */}
        <Modal.Section>
          <Tabs
            tabs={sourceTabs}
            selected={sourceTab}
            onSelect={(i) => {
              setSourceTab(i);
              setDroppedFile(null);
              setForm((p) => ({ ...p, sourceUrl: "" }));
            }}
          />
        </Modal.Section>

        <Modal.Section>
          {sourceTab === 0 ? (
            /* ── URL tab ─────────────────────────────────────────────── */
            <FormLayout>
              <TextField
                label="Source URL"
                value={form.sourceUrl}
                onChange={(v) => setForm((p) => ({ ...p, sourceUrl: v }))}
                autoComplete="off"
                placeholder="https://example.com/video.mp4"
                requiredIndicator
                helpText="A direct MP4, MOV, or WebM video URL."
              />
            </FormLayout>
          ) : (
            /* ── Upload tab ──────────────────────────────────────────── */
            <BlockStack gap="400">
              {/* Step A — pick file */}
              {!droppedFile ? (
                <DropZone
                  accept={ACCEPTED_MIME.video}
                  type="file"
                  onDrop={handleDrop}
                  variableHeight
                >
                  <DropZone.FileUpload
                    actionTitle="Choose video file"
                    actionHint={`Accepted: ${ACCEPTED_EXT.video}`}
                  />
                </DropZone>
              ) : (
                <Box background="bg-surface-secondary" borderRadius="200" padding="400">
                  <BlockStack gap="300">
                    {/* File info row */}
                    <InlineStack gap="300" blockAlign="center">
                      <Icon source={UploadIcon} tone="base" />
                      <BlockStack gap="050">
                        <Text variant="bodyMd" fontWeight="semibold">
                          {droppedFile.name}
                        </Text>
                        <Text variant="bodySm" tone="subdued">
                          {(droppedFile.size / 1024 / 1024).toFixed(2)} MB
                        </Text>
                      </BlockStack>
                      {!isUploading && !uploadDone && (
                        <Button
                          size="micro"
                          onClick={() => {
                            setDroppedFile(null);
                            setForm((p) => ({ ...p, sourceUrl: "" }));
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </InlineStack>

                    {/* Step B — upload button (shows until upload starts) */}
                    {!isUploading && !uploadDone && !uploadError && (
                      <Button variant="primary" onClick={handleUploadFile}>
                        Upload to Shopify Files
                      </Button>
                    )}

                    {/* Uploading progress */}
                    {isUploading && (
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Spinner size="small" />
                          <Text variant="bodySm" tone="subdued">
                            Uploading to Shopify Files…
                          </Text>
                        </InlineStack>
                        <ProgressBar progress={50} size="small" />
                        <Text variant="bodySm" tone="subdued">
                          Large files may take up to 90 seconds to process.
                        </Text>
                      </BlockStack>
                    )}

                    {/* Success */}
                    {uploadDone && (
                      <Banner tone="success">
                        ✓ Uploaded successfully. Click <strong>Save</strong> to
                        add it to your playlist.
                      </Banner>
                    )}

                    {/* Error */}
                    {uploadError && (
                      <Banner tone="critical">
                        <BlockStack gap="200">
                          <Text variant="bodySm" fontWeight="medium">
                            Upload failed
                          </Text>
                          <Text variant="bodySm">
                            {uploadData?.error || "Something went wrong"}
                          </Text>
                          <Button size="small" onClick={handleUploadFile}>
                            Try again
                          </Button>
                        </BlockStack>
                      </Banner>
                    )}

                    {/* Limit reached */}
                    {uploadLimitReached && (
                      <Banner tone="warning">
                        <Text variant="bodySm">
                          You've reached the {maxVideos} video limit. Delete a video to add a new one.
                        </Text>
                      </Banner>
                    )}
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          )}
        </Modal.Section>

        {/* Thumbnail */}
        <Modal.Section>
          <BlockStack gap="300">
            <Text variant="headingSm" fontWeight="semibold">Thumbnail (optional)</Text>
            {!thumbnailFile ? (
              <DropZone
                accept="image/jpeg,image/png,image/webp,image/gif"
                type="file"
                onDrop={handleThumbnailDrop}
                variableHeight
              >
                <DropZone.FileUpload
                  actionTitle="Choose thumbnail image"
                  actionHint="Accepted: .jpg, .png, .webp, .gif"
                />
              </DropZone>
            ) : (
              <Box background="bg-surface-secondary" borderRadius="200" padding="400">
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center">
                    <Icon source={UploadIcon} tone="base" />
                    <BlockStack gap="050">
                      <Text variant="bodyMd" fontWeight="semibold">
                        {thumbnailFile.name}
                      </Text>
                      <Text variant="bodySm" tone="subdued">
                        {(thumbnailFile.size / 1024 / 1024).toFixed(2)} MB
                      </Text>
                    </BlockStack>
                    <Button
                      size="micro"
                      onClick={() => setThumbnailFile(null)}
                    >
                      Remove
                    </Button>
                  </InlineStack>

                  {thumbnailUploadFetcher.state !== "idle" && (
                    <InlineStack gap="200" blockAlign="center">
                      <Spinner size="small" />
                      <Text variant="bodySm" tone="subdued">
                        Uploading thumbnail…
                      </Text>
                    </InlineStack>
                  )}

                  {thumbnailUploadFetcher.data?.success && (
                    <Banner tone="success">
                      ✓ Thumbnail uploaded successfully
                    </Banner>
                  )}

                  {thumbnailUploadFetcher.data?.success === false && (
                    <Banner tone="critical">
                      <BlockStack gap="200">
                        <Text variant="bodySm" fontWeight="medium">
                          Thumbnail upload failed
                        </Text>
                        <Button size="small" onClick={handleUploadThumbnail}>
                          Try again
                        </Button>
                      </BlockStack>
                    </Banner>
                  )}
                </BlockStack>
              </Box>
            )}
          </BlockStack>
        </Modal.Section>

        {/* Active toggle */}
        <Modal.Section>
          <Checkbox
            label="Active"
            checked={form.isActive}
            onChange={(v) => setForm((p) => ({ ...p, isActive: v }))}
            helpText="Only active videos appear in the storefront widget."
          />
        </Modal.Section>
      </Modal>

      {/* ── Delete confirmation modal ───────────────────────────────────────── */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete video?"
        primaryAction={{
          content: "Delete",
          onAction: handleDelete,
          tone: "critical",
          loading: isMutating,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeleteModalOpen(false) }]}
      >
        <Modal.Section>
          <Text>Are you sure you want to delete this video? This action cannot be undone.</Text>
        </Modal.Section>
      </Modal>

      {/* ── Toast ─────────────────────────────────────────────────────────────── */}
      {toastActive && (
        <Toast
          content={toastMessage}
          onDismiss={() => setToastActive(false)}
          error={toastIsError}
        />
      )}
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
