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
  Select,
  Checkbox,
  EmptyState,
  ButtonGroup,
  InlineStack,
  BlockStack,
  Thumbnail,
  Divider,
  Toast,
  Box,
  Banner,
  DropZone,
  Spinner,
  Tabs,
  ProgressBar,
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
        ... on GenericFile {
          id fileStatus url
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
      ... on GenericFile {
        id fileStatus url
      }
    }
  }
`;

// ─── Server helpers ───────────────────────────────────────────────────────────

function classifyFile(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (["mp4", "mov", "webm"].includes(ext))
    return { resource: "VIDEO", mimeType: "video/mp4", contentType: "VIDEO" };
  if (ext === "mp3")
    return { resource: "FILE", mimeType: "audio/mpeg", contentType: "FILE" };
  if (ext === "wav")
    return { resource: "FILE", mimeType: "audio/wav", contentType: "FILE" };
  if (ext === "ogg")
    return { resource: "FILE", mimeType: "audio/ogg", contentType: "FILE" };
  throw new Error(`Unsupported file type: .${ext}`);
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
        node.sources?.[0]?.url ??
        node.url;
      return url;
    }
    if (node.fileStatus === "FAILED") throw new Error("Shopify file processing failed");
  }
  throw new Error("Timed out waiting for file to be ready (90 s)");
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const mediaItems = await prisma.playlistMedia.findMany({
    where: { shop },
    orderBy: { sortOrder: "asc" },
  });
  return data({ mediaItems, shop });
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
      const file = formData.get("file");
      if (!file || typeof file === "string")
        return data({ success: false, error: "No file received" }, { status: 400 });

      const filename = file.name;
      const fileSize = String(file.size);
      const { resource, mimeType, contentType } = classifyFile(filename);

      // Step 1 — get staged upload target
      const stageRes = await admin.graphql(STAGED_UPLOADS_CREATE, {
        variables: { input: [{ filename, mimeType, resource, fileSize, httpMethod: "POST" }] },
      });
      const stageJson = await stageRes.json();
      const stageErrors = stageJson.data?.stagedUploadsCreate?.userErrors ?? [];
      if (stageErrors.length) throw new Error(stageErrors.map((e) => e.message).join(", "));

      const target = stageJson.data.stagedUploadsCreate.stagedTargets[0];
      if (!target) throw new Error("No staged target returned from Shopify");

      const { url: uploadUrl, resourceUrl, parameters } = target;

      // Step 2 — PUT file bytes to CDN staging area
      const uploadForm = new FormData();
      parameters.forEach(({ name, value }) => uploadForm.append(name, value));
      uploadForm.append("file", file); // must be last for S3

      const putRes = await fetch(uploadUrl, { method: "POST", body: uploadForm });
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => "");
        throw new Error(`CDN upload failed (HTTP ${putRes.status}): ${body.slice(0, 300)}`);
      }

      // Step 3 — register in Shopify Files
      const createRes = await admin.graphql(FILE_CREATE, {
        variables: { files: [{ filename, contentType, originalSource: resourceUrl }] },
      });
      const createJson = await createRes.json();
      const createErrors = createJson.data?.fileCreate?.userErrors ?? [];
      if (createErrors.length) throw new Error(createErrors.map((e) => e.message).join(", "));

      const createdFile = createJson.data.fileCreate.files[0];
      if (!createdFile) throw new Error("fileCreate returned no file");

      // Step 4 — poll until READY
      const cdnUrl = await pollFileReady(admin, createdFile.id);
      return data({ success: true, url: cdnUrl });
    }

    // ── CRUD operations ─────────────────────────────────────────────────────
    if (intent === "create") {
      const maxOrder = await prisma.playlistMedia.aggregate({
        where: { shop },
        _max: { sortOrder: true },
      });
      const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;
      const item = await prisma.playlistMedia.create({
        data: {
          shop,
          title: formData.get("title"),
          mediaType: formData.get("mediaType"),
          sourceUrl: formData.get("sourceUrl"),
          thumbnailUrl: formData.get("thumbnailUrl") || null,
          isActive: formData.get("isActive") === "true",
          sortOrder: nextOrder,
        },
      });
      return data({ success: true, intent: "create", item });
    }

    if (intent === "update") {
      const item = await prisma.playlistMedia.update({
        where: { id: Number(formData.get("id")) },
        data: {
          title: formData.get("title"),
          mediaType: formData.get("mediaType"),
          sourceUrl: formData.get("sourceUrl"),
          thumbnailUrl: formData.get("thumbnailUrl") || null,
          isActive: formData.get("isActive") === "true",
          sortOrder: Number(formData.get("sortOrder") ?? 0),
        },
      });
      return data({ success: true, intent: "update", item });
    }

    if (intent === "delete") {
      await prisma.playlistMedia.delete({ where: { id: Number(formData.get("id")) } });
      return data({ success: true, intent: "delete" });
    }

    if (intent === "toggleActive") {
      const current = await prisma.playlistMedia.findUnique({
        where: { id: Number(formData.get("id")) },
        select: { isActive: true },
      });
      const item = await prisma.playlistMedia.update({
        where: { id: Number(formData.get("id")) },
        data: { isActive: !current.isActive },
      });
      return data({ success: true, intent: "toggleActive", item });
    }

    if (intent === "reorder") {
      const items = JSON.parse(formData.get("items"));
      await Promise.all(
        items.map(({ id, sortOrder }) =>
          prisma.playlistMedia.update({ where: { id }, data: { sortOrder } }),
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

const MEDIA_TYPE_OPTIONS = [
  { label: "Video — YouTube, TikTok, .mp4", value: "video" },
  { label: "Audio — .mp3 / .wav / stream URL", value: "audio" },
];

const FALLBACK_THUMB =
  "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";

const ACCEPTED_MIME = {
  video: "video/mp4,video/quicktime,video/webm",
  audio: "audio/mpeg,audio/mp3,audio/wav,audio/ogg",
};
const ACCEPTED_EXT = {
  video: ".mp4  .mov  .webm",
  audio: ".mp3  .wav  .ogg",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function PlaylistAdmin() {
  // loader data — single source of truth
  const { mediaItems } = useLoaderData();

  // One fetcher for CRUD mutations, one dedicated fetcher for file upload
  const crudFetcher   = useFetcher({ key: "playlist-crud" });
  const uploadFetcher = useFetcher({ key: "playlist-upload" });

  // ── Modal state ───────────────────────────────────────────────────────────
  const [modalOpen,       setModalOpen]       = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [editingItem,     setEditingItem]     = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [form,            setForm]            = useState(EMPTY_FORM);
  const [sourceTab,       setSourceTab]       = useState(0); // 0=URL 1=Upload
  const [droppedFile,     setDroppedFile]     = useState(null);

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
  const uploadError = uploadData?.success === false;

  // When upload finishes successfully, store the CDN URL in form.sourceUrl
  useEffect(() => {
    if (uploadDone && uploadData?.url) {
      setForm((p) => ({ ...p, sourceUrl: uploadData.url }));
    }
  }, [uploadDone, uploadData?.url]);

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
    const isAudio = file.type.startsWith("audio/");
    setForm((p) => ({
      ...p,
      mediaType: isAudio ? "audio" : "video",
      title: p.title || file.name.replace(/\.[^.]+$/, ""),
      sourceUrl: "", // clear previous URL
    }));
  }, []);

  // ── Upload to Shopify Files (via authenticated action) ────────────────────

  const handleUploadFile = useCallback(() => {
    if (!droppedFile) return;
    const fd = new FormData();
    fd.append("intent", "upload");
    fd.append("file", droppedFile);
    // encType multipart/form-data is automatic when FormData contains a File
    uploadFetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
  }, [droppedFile, uploadFetcher]);

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
    !isUploading;

  const sourceTabs = [
    { id: "url",    content: "Paste URL"   },
    { id: "upload", content: "Upload file" },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Page
      title="Manage Playlist"
      subtitle={`${mediaItems.length} item${mediaItems.length !== 1 ? "s" : ""} in your playlist`}
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={
        <Button variant="primary" onClick={openCreate}>
          Add media item
        </Button>
      }
    >
      <Layout>
        {/* ── Table / empty state ───────────────────────────────────────── */}
        <Layout.Section>
          {mediaItems.length === 0 ? (
            <Card>
              <EmptyState
                heading="Your playlist is empty"
                action={{ content: "Add media item", onAction: openCreate }}
                image={FALLBACK_THUMB}
              >
                <Text tone="subdued">
                  Upload .mp4 / .mp3 files to Shopify Files, or paste YouTube,
                  TikTok, or direct media URLs.
                </Text>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <IndexTable
                resourceName={{ singular: "media item", plural: "media items" }}
                itemCount={mediaItems.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "" },
                  { title: "Title" },
                  { title: "Type" },
                  { title: "Status" },
                  { title: "Order" },
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
                        size="small"
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
                      <Badge tone={item.mediaType === "audio" ? "info" : "warning"}>
                        {item.mediaType === "audio" ? "Audio" : "Video"}
                      </Badge>
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
            </Card>
          )}
        </Layout.Section>

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Banner tone="info" title="Playlist order">
              Items appear in the storefront widget in the order listed here.
              Use ↑↓ to reorder.
            </Banner>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">
                  Supported sources
                </Text>
                <Divider />
                <BlockStack gap="100">
                  <Text variant="bodySm" fontWeight="medium">Upload directly:</Text>
                  <Text variant="bodySm" tone="subdued">.mp4, .mov, .webm — stored in Shopify Files</Text>
                  <Text variant="bodySm" tone="subdued">.mp3, .wav, .ogg — stored in Shopify Files</Text>
                  <Divider />
                  <Text variant="bodySm" fontWeight="medium">Or paste a URL:</Text>
                  <Text variant="bodySm" tone="subdued">YouTube, TikTok, direct .mp4 / .mp3</Text>
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
        title={editingItem ? "Edit media item" : "Add media item"}
        primaryAction={{
          content: "Save",
          onAction: handleSubmit,
          disabled: !canSave,
          loading: isMutating,
        }}
        secondaryActions={[{ content: "Cancel", onAction: closeModal }]}
        large
      >
        {/* Basic fields */}
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Title"
              value={form.title}
              onChange={(v) => setForm((p) => ({ ...p, title: v }))}
              autoComplete="off"
              placeholder="e.g. Summer Vibes Mix"
              requiredIndicator
            />
            <Select
              label="Media type"
              options={MEDIA_TYPE_OPTIONS}
              value={form.mediaType}
              onChange={(v) => setForm((p) => ({ ...p, mediaType: v, sourceUrl: "" }))}
            />
          </FormLayout>
        </Modal.Section>

        {/* Source tabs */}
        <Modal.Section flush>
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
                placeholder={
                  form.mediaType === "video"
                    ? "https://youtube.com/watch?v=... or .mp4 URL"
                    : "https://example.com/track.mp3"
                }
                requiredIndicator
                helpText={
                  form.mediaType === "video"
                    ? "YouTube, TikTok, or a direct .mp4 / .mov URL."
                    : "A direct .mp3, .wav, or audio stream URL."
                }
              />
            </FormLayout>
          ) : (
            /* ── Upload tab ──────────────────────────────────────────── */
            <BlockStack gap="400">
              {/* Step A — pick file */}
              {!droppedFile ? (
                <DropZone
                  accept={ACCEPTED_MIME[form.mediaType]}
                  type="file"
                  onDrop={handleDrop}
                  variableHeight
                >
                  <DropZone.FileUpload
                    actionTitle={`Choose ${form.mediaType} file`}
                    actionHint={`Accepted: ${ACCEPTED_EXT[form.mediaType]}`}
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
                        <ProgressBar progress={50} size="small" animated />
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
                          <Text>{uploadData?.error || "Upload failed — please try again."}</Text>
                          <Button
                            variant="plain"
                            onClick={() => {
                              setDroppedFile(null);
                              setForm((p) => ({ ...p, sourceUrl: "" }));
                            }}
                          >
                            Try again
                          </Button>
                        </BlockStack>
                      </Banner>
                    )}
                  </BlockStack>
                </Box>
              )}

              <Text variant="bodySm" tone="subdued">
                Files are stored permanently in your Shopify Files library and
                served via Shopify's global CDN.
              </Text>
            </BlockStack>
          )}
        </Modal.Section>

        {/* Thumbnail + active */}
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Custom thumbnail URL (optional)"
              value={form.thumbnailUrl}
              onChange={(v) => setForm((p) => ({ ...p, thumbnailUrl: v }))}
              autoComplete="off"
              placeholder="https://example.com/cover.jpg"
              helpText="Leave blank to use the auto-generated thumbnail."
            />
            <Checkbox
              label="Active — visible in the storefront widget"
              checked={form.isActive}
              onChange={(v) => setForm((p) => ({ ...p, isActive: v }))}
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* ── Delete confirmation ────────────────────────────────────────────── */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete media item?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: handleDelete,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <Text>
            This removes the item from your playlist. The file in Shopify Files
            will not be deleted.
          </Text>
        </Modal.Section>
      </Modal>

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toastActive && (
        <Toast
          content={toastMessage}
          error={toastIsError}
          onDismiss={() => setToastActive(false)}
          duration={4000}
        />
      )}
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
