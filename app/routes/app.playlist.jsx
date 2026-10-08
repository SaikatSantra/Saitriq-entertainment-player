
import {
  useLoaderData,
  useFetcher,
  useRouteError,
  data,
} from "react-router";

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
  Tabs,
  ProgressBar,
  Checkbox,
} from "@shopify/polaris";

import { UploadIcon } from "@shopify/polaris-icons";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect } from "react";

// ==================================================
// SHOPIFY GRAPHQL
// ==================================================

const STAGED_UPLOADS_CREATE = `#graphql
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
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
          sources {
            url
            mimeType
          }
        }
        ... on MediaImage {
          image {
            url
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query fileStatus($id: ID!) {
    node(id: $id) {
      ... on Video {
        id
        fileStatus
        sources {
          url
          mimeType
        }
      }
      ... on MediaImage {
        id
        fileStatus
        image {
          url
        }
      }
    }
  }
`;

// ==================================================
// SERVER HELPERS
// ==================================================

function classifyFile(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();

  const videoMimeTypes = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };

  if (!ext || !videoMimeTypes[ext]) {
    throw new Error(
      "Unsupported video format. Use MP4, MOV, or WebM."
    );
  }

  return {
    resource: "VIDEO",
    mimeType: videoMimeTypes[ext],
    contentType: "VIDEO",
  };
}

function classifyThumbnailFile(file) {
  const ext = file.name.split(".").pop()?.toLowerCase();

  const imageMimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };

  const mimeType = imageMimeTypes[ext];

  if (
    !mimeType ||
    (file.type && file.type !== mimeType)
  ) {
    throw new Error(
      "Thumbnail must be JPEG, PNG, WebP, or GIF."
    );
  }

  return {
    resource: "IMAGE",
    mimeType,
    contentType: "IMAGE",
  };
}

async function pollFileReady(admin, fileId, resource) {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );

    const response = await admin.graphql(
      FILE_STATUS_QUERY,
      {
        variables: { id: fileId },
      }
    );

    const result = await response.json();

    if (result.errors?.length) {
      throw new Error(
        result.errors.map((error) => error.message).join(", ")
      );
    }

    const node = result.data?.node;

    if (!node) {
      throw new Error(
        "Shopify file was not found during processing."
      );
    }

    if (node.fileStatus === "READY") {
      if (resource === "VIDEO") {
        const videoUrl =
          node.sources?.find((source) =>
            source.mimeType?.includes("mp4")
          )?.url ?? node.sources?.[0]?.url;

        if (!videoUrl) {
          throw new Error(
            "Shopify processed the video but returned no video URL."
          );
        }

        return videoUrl;
      }

      const imageUrl = node.image?.url;

      if (!imageUrl) {
        throw new Error(
          "Shopify processed the image but returned no image URL."
        );
      }

      return imageUrl;
    }

    if (node.fileStatus === "FAILED") {
      throw new Error("Shopify file processing failed.");
    }
  }

  throw new Error(
    "Timed out waiting for Shopify file processing (90 seconds)."
  );
}

async function uploadShopifyFile(admin, file, classification) {
  const { resource, mimeType, contentType } = classification;

  const stageResponse = await admin.graphql(
    STAGED_UPLOADS_CREATE,
    {
      variables: {
        input: [
          {
            filename: file.name,
            mimeType,
            resource,
            fileSize: String(file.size),
            httpMethod: "POST",
          },
        ],
      },
    }
  );

  const stageJson = await stageResponse.json();

  if (stageJson.errors?.length) {
    throw new Error(
      stageJson.errors.map((error) => error.message).join(", ")
    );
  }

  const stagePayload = stageJson.data?.stagedUploadsCreate;

  if (stagePayload?.userErrors?.length) {
    throw new Error(
      stagePayload.userErrors
        .map((error) => error.message)
        .join(", ")
    );
  }

  const target = stagePayload?.stagedTargets?.[0];

  if (!target) {
    throw new Error(
      "Shopify did not return a staged upload target."
    );
  }

  const uploadForm = new FormData();

  target.parameters.forEach(({ name, value }) => {
    uploadForm.append(name, value);
  });

  uploadForm.append("file", file);

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });

  if (!uploadResponse.ok) {
    throw new Error(
      `Shopify upload failed with HTTP ${uploadResponse.status}.`
    );
  }

  const createResponse = await admin.graphql(FILE_CREATE, {
    variables: {
      files: [
        {
          filename: file.name,
          contentType,
          originalSource: target.resourceUrl,
        },
      ],
    },
  });

  const createJson = await createResponse.json();

  if (createJson.errors?.length) {
    throw new Error(
      createJson.errors.map((error) => error.message).join(", ")
    );
  }

  const createPayload = createJson.data?.fileCreate;

  if (createPayload?.userErrors?.length) {
    throw new Error(
      createPayload.userErrors
        .map((error) => error.message)
        .join(", ")
    );
  }

  const createdFile = createPayload?.files?.[0];

  if (!createdFile?.id) {
    throw new Error(
      "Shopify did not return the created file."
    );
  }

  return pollFileReady(
    admin,
    createdFile.id,
    resource
  );
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

  const rawSortOrder = value("sortOrder");

  const sortOrder =
    sortOrderOverride !== undefined
      ? sortOrderOverride
      : rawSortOrder === ""
        ? 0
        : Number(rawSortOrder);

  if (!title || title.length > 120) {
    throw new Error(
      "Title is required and must be 120 characters or fewer."
    );
  }

  let source;

  try {
    source = new URL(sourceUrl);
  } catch {
    throw new Error("Enter a valid source URL.");
  }

  if (!["http:", "https:"].includes(source.protocol)) {
    throw new Error(
      "Source URL must use HTTP or HTTPS."
    );
  }

  if (thumbnailUrl) {
    let thumbnail;

    try {
      thumbnail = new URL(thumbnailUrl);
    } catch {
      throw new Error("Enter a valid thumbnail URL.");
    }

    if (
      !["http:", "https:"].includes(thumbnail.protocol)
    ) {
      throw new Error(
        "Thumbnail URL must use HTTP or HTTPS."
      );
    }
  }

  if (
    !Number.isSafeInteger(sortOrder) ||
    sortOrder < 0
  ) {
    throw new Error(
      "Sort order must be a non-negative integer."
    );
  }

  return {
    title,
    mediaType: "video",
    sourceUrl: source.toString(),
    thumbnailUrl: thumbnailUrl || null,
    isActive,
    sortOrder,
  };
}

function readMediaId(formData) {
  const id = Number(formData.get("id"));

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

// ==================================================
// LOADER
// ==================================================

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const mediaItems = await prisma.playlistMedia.findMany({
    where: { shop },
    orderBy: [
      { sortOrder: "asc" },
      { id: "asc" },
    ],
  });

  return data({
    mediaItems,
    maxVideos: 5,
  });
}

// ==================================================
// ACTION
// ==================================================

export async function action({ request }) {
  let intent = null;

  try {
    const { session, admin } =
      await authenticate.admin(request);

    const shop = session.shop;
    const formData = await request.formData();

    intent = formData.get("intent");

    // Upload video to Shopify Files
    if (intent === "upload") {
      const count = await prisma.playlistMedia.count({
        where: { shop },
      });

      if (count >= 5) {
        return data(
          {
            success: false,
            limitReached: true,
            limit: 5,
          },
          { status: 403 }
        );
      }

      const file = formData.get("file");

      if (!file || typeof file === "string") {
        return data(
          {
            success: false,
            error: "No video file received.",
          },
          { status: 400 }
        );
      }

      const url = await uploadShopifyFile(
        admin,
        file,
        classifyFile(file.name)
      );

      return data({
        success: true,
        url,
      });
    }

    // Upload thumbnail image to Shopify Files
    if (intent === "uploadThumbnail") {
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        return data(
          {
            success: false,
            error: "No thumbnail image received.",
          },
          { status: 400 }
        );
      }

      const url = await uploadShopifyFile(
        admin,
        file,
        classifyThumbnailFile(file)
      );

      return data({
        success: true,
        url,
      });
    }

    // Create video
    if (intent === "create") {
      const count = await prisma.playlistMedia.count({
        where: { shop },
      });

      if (count >= 5) {
        return data(
          {
            success: false,
            limitReached: true,
            limit: 5,
          },
          { status: 403 }
        );
      }

      const maxOrder = await prisma.playlistMedia.aggregate({
        where: { shop },
        _max: { sortOrder: true },
      });

      const nextOrder =
        (maxOrder._max.sortOrder ?? -1) + 1;

      const item = await prisma.playlistMedia.create({
        data: {
          shop,
          ...readMediaFields(formData, nextOrder),
        },
      });

      return data({
        success: true,
        intent,
        item,
      });
    }

    // Update video
    if (intent === "update") {
      const id = readMediaId(formData);

      if (!id) {
        return data(
          {
            success: false,
            error: "Invalid media item ID.",
          },
          { status: 400 }
        );
      }

      const item = await prisma.$transaction(async (tx) => {
        const existing = await tx.playlistMedia.findFirst({
          where: { id, shop },
          select: { id: true },
        });

        if (!existing) return null;

        return tx.playlistMedia.update({
          where: { id },
          data: readMediaFields(formData),
        });
      });

      if (!item) {
        return data(
          {
            success: false,
            error: "Media item not found.",
          },
          { status: 404 }
        );
      }

      return data({
        success: true,
        intent,
        item,
      });
    }

    // Delete video
    if (intent === "delete") {
      const id = readMediaId(formData);

      if (!id) {
        return data(
          {
            success: false,
            error: "Invalid media item ID.",
          },
          { status: 400 }
        );
      }

      const result = await prisma.playlistMedia.deleteMany({
        where: { id, shop },
      });

      if (!result.count) {
        return data(
          {
            success: false,
            error: "Media item not found.",
          },
          { status: 404 }
        );
      }

      return data({
        success: true,
        intent,
      });
    }

    // Enable / disable video
    if (intent === "toggleActive") {
      const id = readMediaId(formData);

      if (!id) {
        return data(
          {
            success: false,
            error: "Invalid media item ID.",
          },
          { status: 400 }
        );
      }

      const item = await prisma.$transaction(async (tx) => {
        const current = await tx.playlistMedia.findFirst({
          where: { id, shop },
          select: { isActive: true },
        });

        if (!current) return null;

        await tx.playlistMedia.updateMany({
          where: {
            id,
            shop,
            isActive: current.isActive,
          },
          data: {
            isActive: !current.isActive,
          },
        });

        return tx.playlistMedia.findFirst({
          where: { id, shop },
        });
      });

      if (!item) {
        return data(
          {
            success: false,
            error: "Media item not found.",
          },
          { status: 404 }
        );
      }

      return data({
        success: true,
        intent,
        item,
      });
    }

    // Reorder playlist
    if (intent === "reorder") {
      const rawItems = formData.get("items");

      if (typeof rawItems !== "string") {
        return data(
          {
            success: false,
            error: "Invalid playlist order.",
          },
          { status: 400 }
        );
      }

      let items;

      try {
        items = JSON.parse(rawItems);
      } catch {
        return data(
          {
            success: false,
            error: "Invalid playlist order.",
          },
          { status: 400 }
        );
      }

      if (
        !Array.isArray(items) ||
        items.some(
          (item) =>
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            !Number.isSafeInteger(item.id) ||
            item.id < 1 ||
            !Number.isSafeInteger(item.sortOrder) ||
            item.sortOrder < 0
        ) ||
        new Set(items.map((item) => item.id)).size !==
          items.length ||
        new Set(items.map((item) => item.sortOrder)).size !==
          items.length
      ) {
        return data(
          {
            success: false,
            error: "Invalid playlist order.",
          },
          { status: 400 }
        );
      }

      const ownedItems = await prisma.playlistMedia.findMany({
        where: { shop },
        select: { id: true },
      });

      const ownedIds = new Set(
        ownedItems.map((item) => item.id)
      );

      if (
        ownedItems.length !== items.length ||
        items.some((item) => !ownedIds.has(item.id))
      ) {
        return data(
          {
            success: false,
            error: "Playlist changed. Reload and try again.",
          },
          { status: 409 }
        );
      }

      await prisma.$transaction(
        items.map((item) =>
          prisma.playlistMedia.updateMany({
            where: {
              id: item.id,
              shop,
            },
            data: {
              sortOrder: item.sortOrder,
            },
          })
        )
      );

      return data({
        success: true,
        intent,
      });
    }

    return data(
      {
        success: false,
        error: "Unknown intent.",
      },
      { status: 400 }
    );
  } catch (error) {
    console.error(
      `[playlist action: ${intent || "unknown"}]`,
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : "An unexpected server error occurred.";

    return data(
      {
        success: false,
        error: message,
      },
      { status: 422 }
    );
  }
}

// ==================================================
// CONSTANTS
// ==================================================

const EMPTY_FORM = {
  title: "",
  mediaType: "video",
  sourceUrl: "",
  thumbnailUrl: "",
  isActive: true,
  sortOrder: 0,
};

const FALLBACK_THUMB =
  "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";

const ACCEPTED_MIME = {
  video: "video/mp4,video/quicktime,video/webm",
};

const ACCEPTED_EXT = {
  video: ".mp4, .mov, .webm",
};

// ==================================================
// SUMMARY CARD
// ==================================================

function SummaryCard({ label, value, tone = "default" }) {
  const backgrounds = {
    default: "bg-surface-secondary",
    success: "bg-fill-success-secondary",
    info: "bg-fill-info-secondary",
    warning: "bg-fill-warning-secondary",
  };

  return (
    <Box
      background={backgrounds[tone] || backgrounds.default}
      borderRadius="200"
      padding="300"
    >
      <BlockStack gap="100">
        <Text variant="headingMd" as="p">
          {value}
        </Text>

        <Text variant="bodySm" tone="subdued" as="p">
          {label}
        </Text>
      </BlockStack>
    </Box>
  );
}

// ==================================================
// MAIN COMPONENT
// ==================================================

export default function PlaylistAdmin() {
  const { mediaItems, maxVideos } = useLoaderData();

  const atLimit = mediaItems.length >= maxVideos;

  const crudFetcher = useFetcher({
    key: "playlist-crud",
  });

  const uploadFetcher = useFetcher({
    key: "playlist-upload",
  });

  const thumbnailUploadFetcher = useFetcher({
    key: "playlist-thumbnail-upload",
  });

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  // Form state
  const [form, setForm] = useState(EMPTY_FORM);
  const [sourceTab, setSourceTab] = useState(0);
  const [droppedFile, setDroppedFile] = useState(null);
  const [thumbnailFile, setThumbnailFile] = useState(null);

  // Toast state
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);

  const showToast = useCallback(
    (message, isError = false) => {
      setToastMessage(message);
      setToastError(isError);
      setToastActive(true);
    },
    []
  );

  // Upload state
  const isUploading = uploadFetcher.state !== "idle";

  const isThumbnailUploading =
    thumbnailUploadFetcher.state !== "idle";

  const isMutating = crudFetcher.state !== "idle";

  const uploadData = uploadFetcher.data;

  const uploadDone =
    uploadData?.success === true &&
    Boolean(uploadData?.url);

  const uploadError =
    uploadData?.success === false &&
    !uploadData?.limitReached;

  // Set video URL after successful upload
  useEffect(() => {
    if (uploadDone && uploadData?.url) {
      setForm((previous) => ({
        ...previous,
        sourceUrl: uploadData.url,
      }));
    }
  }, [uploadDone, uploadData?.url]);

  // Set thumbnail URL after successful upload
  useEffect(() => {
    const result = thumbnailUploadFetcher.data;

    if (result?.success && result.url) {
      setForm((previous) => ({
        ...previous,
        thumbnailUrl: result.url,
      }));

      showToast("Thumbnail uploaded successfully.");
    } else if (result?.success === false) {
      showToast(
        result.error || "Thumbnail upload failed.",
        true
      );
    }
  }, [thumbnailUploadFetcher.data, showToast]);

  // CRUD feedback
  useEffect(() => {
    if (
      crudFetcher.state !== "idle" ||
      !crudFetcher.data
    ) {
      return;
    }

    const result = crudFetcher.data;

    if (!result.success) {
      showToast(
        result.error || "Something went wrong.",
        true
      );
      return;
    }

    const messages = {
      create: "Video added to playlist.",
      update: "Video updated.",
      delete: "Video deleted.",
      toggleActive: "Video status updated.",
      reorder: "Playlist order updated.",
    };

    showToast(
      messages[result.intent] || "Operation completed."
    );
  }, [crudFetcher.state, crudFetcher.data, showToast]);

  // Polaris selection state
  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
  } = useIndexResourceState(mediaItems, {
    resourceIDResolver: (item) => String(item.id),
  });

  // Modal helpers
  const resetUpload = useCallback(() => {
    setDroppedFile(null);
    setThumbnailFile(null);
    setSourceTab(0);
  }, []);

  const openCreate = useCallback(() => {
    setEditingItem(null);

    setForm({
      ...EMPTY_FORM,
      sortOrder: mediaItems.length,
    });

    resetUpload();
    setModalOpen(true);
  }, [mediaItems.length, resetUpload]);

  const openEdit = useCallback(
    (item) => {
      setEditingItem(item);

      setForm({
        title: item.title,
        mediaType: item.mediaType,
        sourceUrl: item.sourceUrl,
        thumbnailUrl: item.thumbnailUrl || "",
        isActive: item.isActive,
        sortOrder: item.sortOrder,
      });

      resetUpload();
      setModalOpen(true);
    },
    [resetUpload]
  );

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setEditingItem(null);
    resetUpload();
  }, [resetUpload]);

  // Video file drop
  const handleDrop = useCallback(
    (_files, acceptedFiles) => {
      const file = acceptedFiles[0];

      if (!file) return;

      setDroppedFile(file);

      setForm((previous) => ({
        ...previous,
        mediaType: "video",
        title:
          previous.title ||
          file.name.replace(/\.[^.]+$/, ""),
        sourceUrl: "",
      }));
    },
    []
  );

  // Thumbnail drop
  const handleThumbnailDrop = useCallback(
    (_files, acceptedFiles) => {
      setThumbnailFile(acceptedFiles[0] || null);
    },
    []
  );

  // Upload video
  const handleUploadFile = useCallback(() => {
    if (!droppedFile) return;

    const formData = new FormData();

    formData.append("intent", "upload");
    formData.append("file", droppedFile);

    uploadFetcher.submit(formData, {
      method: "POST",
      encType: "multipart/form-data",
    });
  }, [droppedFile, uploadFetcher]);

  // Upload thumbnail
  const handleUploadThumbnail = useCallback(() => {
    if (!thumbnailFile) return;

    const formData = new FormData();

    formData.append("intent", "uploadThumbnail");
    formData.append("file", thumbnailFile);

    thumbnailUploadFetcher.submit(formData, {
      method: "POST",
      encType: "multipart/form-data",
    });
  }, [thumbnailFile, thumbnailUploadFetcher]);

  // Save video
  const handleSubmit = useCallback(() => {
    if (!form.title.trim()) {
      showToast("Enter a video title.", true);
      return;
    }

    if (!form.sourceUrl.trim()) {
      showToast(
        "Provide a video URL or upload a video first.",
        true
      );
      return;
    }

    const formData = new FormData();

    formData.append(
      "intent",
      editingItem ? "update" : "create"
    );

    if (editingItem) {
      formData.append("id", String(editingItem.id));
      formData.append(
        "sortOrder",
        String(form.sortOrder)
      );
    }

    formData.append("title", form.title);
    formData.append("mediaType", "video");
    formData.append("sourceUrl", form.sourceUrl.trim());
    formData.append("thumbnailUrl", form.thumbnailUrl);
    formData.append("isActive", String(form.isActive));

    crudFetcher.submit(formData, {
      method: "POST",
    });

    closeModal();
  }, [
    form,
    editingItem,
    crudFetcher,
    closeModal,
    showToast,
  ]);

  // Delete video
  const handleDelete = useCallback(() => {
    if (!pendingDeleteId) return;

    const formData = new FormData();

    formData.append("intent", "delete");
    formData.append("id", String(pendingDeleteId));

    crudFetcher.submit(formData, {
      method: "POST",
    });

    setDeleteModalOpen(false);
    setPendingDeleteId(null);
  }, [pendingDeleteId, crudFetcher]);

  // Toggle active state
  const handleToggleActive = useCallback(
    (id) => {
      const formData = new FormData();

      formData.append("intent", "toggleActive");
      formData.append("id", String(id));

      crudFetcher.submit(formData, {
        method: "POST",
      });
    },
    [crudFetcher]
  );

  // Reorder playlist
  const handleMove = useCallback(
    (index, direction) => {
      const items = [...mediaItems];

      const targetIndex =
        direction === "up" ? index - 1 : index + 1;

      if (
        targetIndex < 0 ||
        targetIndex >= items.length
      ) {
        return;
      }

      [items[index], items[targetIndex]] = [
        items[targetIndex],
        items[index],
      ];

      const reordered = items.map((item, position) => ({
        id: item.id,
        sortOrder: position,
      }));

      const formData = new FormData();

      formData.append("intent", "reorder");
      formData.append("items", JSON.stringify(reordered));

      crudFetcher.submit(formData, {
        method: "POST",
      });
    },
    [mediaItems, crudFetcher]
  );

  const canSave =
    Boolean(form.title.trim()) &&
    Boolean(form.sourceUrl.trim()) &&
    !isMutating &&
    !isUploading &&
    !isThumbnailUploading;

  const sourceTabs = [
    { id: "url", content: "Paste URL" },
    { id: "upload", content: "Upload file" },
  ];

  // ==================================================
  // RENDER
  // ==================================================

  return (
    <Page
      title="Manage Playlist"
      subtitle={`${mediaItems.length} / ${maxVideos} videos in your playlist`}
      backAction={{
        content: "Dashboard",
        url: "/app",
      }}
    >
      <Layout>
        {atLimit && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={`You've reached the ${maxVideos} video limit`}
            >
              Delete a video before adding another one.
            </Banner>
          </Layout.Section>
        )}

        {/* Playlist overview */}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingSm" as="h2">
                Playlist overview
              </Text>

              <InlineStack gap="300" wrap>
                <SummaryCard
                  label="Total"
                  value={mediaItems.length}
                />

                <SummaryCard
                  label="Active"
                  value={
                    mediaItems.filter(
                      (item) => item.isActive
                    ).length
                  }
                  tone="success"
                />

                <SummaryCard
                  label="Videos"
                  value={
                    mediaItems.filter(
                      (item) => item.mediaType === "video"
                    ).length
                  }
                  tone="info"
                />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Video library */}

        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <InlineStack
                align="space-between"
                blockAlign="center"
                gap="300"
                wrap
              >
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h2">
                    Video library
                  </Text>

                  <Text
                    variant="bodySm"
                    tone="subdued"
                  >
                    Manage videos shown in your storefront player.
                  </Text>
                </BlockStack>

                <InlineStack
                  gap="200"
                  blockAlign="center"
                >
                  <Badge tone="info">
                    {mediaItems.length} / {maxVideos}
                  </Badge>

                  <Button
                    variant="primary"
                    disabled={atLimit || isMutating}
                    onClick={openCreate}
                  >
                    Add video
                  </Button>
                </InlineStack>
              </InlineStack>
            </Box>

            {mediaItems.length === 0 ? (
              <Box padding="400">
                <EmptyState
                  heading="Your playlist is empty"
                  image={FALLBACK_THUMB}
                >
                  Upload an MP4 file to Shopify Files or paste a direct video URL.
                </EmptyState>
              </Box>
            ) : (
              <IndexTable
                resourceName={{
                  singular: "video",
                  plural: "videos",
                }}
                itemCount={mediaItems.length}
                selectedItemsCount={
                  allResourcesSelected
                    ? "All"
                    : selectedResources.length
                }
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
                    selected={selectedResources.includes(
                      String(item.id)
                    )}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <Thumbnail
                        source={
                          item.thumbnailUrl ||
                          FALLBACK_THUMB
                        }
                        alt={item.title}
                        size="medium"
                      />
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        <Text
                          variant="bodyMd"
                          fontWeight="semibold"
                        >
                          {item.title}
                        </Text>

                        <Text
                          variant="bodySm"
                          tone="subdued"
                        >
                          {item.sourceUrl.length > 50
                            ? `${item.sourceUrl.slice(0, 50)}…`
                            : item.sourceUrl}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Badge
                        tone={
                          item.isActive
                            ? "success"
                            : "critical"
                        }
                      >
                        {item.isActive
                          ? "Active"
                          : "Inactive"}
                      </Badge>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <ButtonGroup variant="segmented">
                        <Button
                          size="micro"
                          disabled={
                            index === 0 || isMutating
                          }
                          onClick={() =>
                            handleMove(index, "up")
                          }
                          accessibilityLabel="Move up"
                        >
                          ↑
                        </Button>

                        <Button
                          size="micro"
                          disabled={
                            index === mediaItems.length - 1 ||
                            isMutating
                          }
                          onClick={() =>
                            handleMove(index, "down")
                          }
                          accessibilityLabel="Move down"
                        >
                          ↓
                        </Button>
                      </ButtonGroup>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <InlineStack gap="200" wrap>
                        <Button
                          size="micro"
                          disabled={isMutating}
                          onClick={() =>
                            handleToggleActive(item.id)
                          }
                        >
                          {item.isActive
                            ? "Disable"
                            : "Enable"}
                        </Button>

                        <Button
                          size="micro"
                          disabled={isMutating}
                          onClick={() => openEdit(item)}
                        >
                          Edit
                        </Button>

                        <Button
                          size="micro"
                          tone="critical"
                          disabled={isMutating}
                          onClick={() => {
                            setPendingDeleteId(item.id);
                            setDeleteModalOpen(true);
                          }}
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

        {/* Supported formats */}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingSm">
                Supported video formats
              </Text>

              <Divider />

              <InlineStack gap="200" wrap>
                {[".mp4", ".mov", ".webm"].map(
                  (extension) => (
                    <Badge key={extension}>
                      {extension}
                    </Badge>
                  )
                )}
              </InlineStack>

              <Text
                variant="bodySm"
                tone="subdued"
              >
                Videos appear in the storefront widget in the order listed above.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* ============================================
          ADD / EDIT MODAL
      ============================================ */}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={
          editingItem ? "Edit video" : "Add video"
        }
        primaryAction={{
          content: "Save",
          onAction: handleSubmit,
          disabled: !canSave,
          loading: isMutating,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: closeModal,
          },
        ]}
        size="large"
      >
        {/* Title */}

        <Modal.Section>
          <FormLayout>
            <TextField
              label="Title"
              value={form.title}
              onChange={(value) =>
                setForm((previous) => ({
                  ...previous,
                  title: value,
                }))
              }
              autoComplete="off"
              placeholder="Product Demo Video"
              requiredIndicator
            />
          </FormLayout>
        </Modal.Section>

        {/* Source tabs */}

        <Modal.Section>
          <Tabs
            tabs={sourceTabs}
            selected={sourceTab}
            onSelect={(index) => {
              setSourceTab(index);
              setDroppedFile(null);

              setForm((previous) => ({
                ...previous,
                sourceUrl: "",
              }));
            }}
          />
        </Modal.Section>

        {/* Video source */}

        <Modal.Section>
          {sourceTab === 0 ? (
            <FormLayout>
              <TextField
                label="Source URL"
                value={form.sourceUrl}
                onChange={(value) =>
                  setForm((previous) => ({
                    ...previous,
                    sourceUrl: value,
                  }))
                }
                autoComplete="off"
                placeholder="https://example.com/video.mp4"
                requiredIndicator
                helpText="Enter a direct video URL."
              />
            </FormLayout>
          ) : (
            <BlockStack gap="400">
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
                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="400"
                >
                  <BlockStack gap="300">
                    <InlineStack
                      gap="300"
                      blockAlign="center"
                    >
                      <Icon source={UploadIcon} />

                      <BlockStack gap="100">
                        <Text
                          variant="bodyMd"
                          fontWeight="semibold"
                        >
                          {droppedFile.name}
                        </Text>

                        <Text
                          variant="bodySm"
                          tone="subdued"
                        >
                          {(
                            droppedFile.size /
                            1024 /
                            1024
                          ).toFixed(2)}{" "}
                          MB
                        </Text>
                      </BlockStack>

                      <Button
                        disabled={isUploading}
                        onClick={() => {
                          setDroppedFile(null);

                          setForm((previous) => ({
                            ...previous,
                            sourceUrl: "",
                          }));
                        }}
                      >
                        Remove
                      </Button>
                    </InlineStack>

                    {!isUploading && !uploadDone && (
                      <Button
                        variant="primary"
                        onClick={handleUploadFile}
                      >
                        Upload to Shopify Files
                      </Button>
                    )}

                    {isUploading && (
                      <BlockStack gap="200">
                        <InlineStack
                          gap="200"
                          blockAlign="center"
                        >
                          <Spinner size="small" />

                          <Text variant="bodySm">
                            Uploading and processing video…
                          </Text>
                        </InlineStack>

                        <ProgressBar
                          progress={50}
                          size="small"
                        />

                        <Text
                          variant="bodySm"
                          tone="subdued"
                        >
                          Processing may take up to 90 seconds.
                        </Text>
                      </BlockStack>
                    )}

                    {uploadDone && (
                      <Banner tone="success">
                        Video uploaded successfully. Click Save to add it to your playlist.
                      </Banner>
                    )}

                    {uploadError && (
                      <Banner tone="critical">
                        <BlockStack gap="200">
                          <Text variant="bodySm">
                            {uploadData?.error ||
                              "Video upload failed."}
                          </Text>

                          <Button
                            onClick={handleUploadFile}
                          >
                            Try again
                          </Button>
                        </BlockStack>
                      </Banner>
                    )}

                    {uploadData?.limitReached && (
                      <Banner tone="warning">
                        Video limit reached. Delete an existing video first.
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
            <Text variant="headingSm">
              Thumbnail (optional)
            </Text>

            {!thumbnailFile ? (
              <DropZone
                accept="image/jpeg,image/png,image/webp,image/gif"
                type="file"
                onDrop={handleThumbnailDrop}
                variableHeight
              >
                <DropZone.FileUpload
                  actionTitle="Choose thumbnail image"
                  actionHint="Accepted: JPEG, PNG, WebP, GIF"
                />
              </DropZone>
            ) : (
              <Box
                background="bg-surface-secondary"
                borderRadius="200"
                padding="400"
              >
                <BlockStack gap="300">
                  <InlineStack
                    gap="300"
                    blockAlign="center"
                  >
                    <Icon source={UploadIcon} />

                    <BlockStack gap="100">
                      <Text
                        variant="bodyMd"
                        fontWeight="semibold"
                      >
                        {thumbnailFile.name}
                      </Text>

                      <Text
                        variant="bodySm"
                        tone="subdued"
                      >
                        {(
                          thumbnailFile.size /
                          1024 /
                          1024
                        ).toFixed(2)}{" "}
                        MB
                      </Text>
                    </BlockStack>

                    <Button
                      disabled={isThumbnailUploading}
                      onClick={() =>
                        setThumbnailFile(null)
                      }
                    >
                      Remove
                    </Button>
                  </InlineStack>

                  {!isThumbnailUploading && (
                    <Button
                      onClick={handleUploadThumbnail}
                    >
                      Upload thumbnail
                    </Button>
                  )}

                  {isThumbnailUploading && (
                    <InlineStack
                      gap="200"
                      blockAlign="center"
                    >
                      <Spinner size="small" />

                      <Text variant="bodySm">
                        Uploading thumbnail…
                      </Text>
                    </InlineStack>
                  )}

                  {thumbnailUploadFetcher.data?.success && (
                    <Banner tone="success">
                      Thumbnail uploaded successfully.
                    </Banner>
                  )}

                  {thumbnailUploadFetcher.data?.success ===
                    false && (
                    <Banner tone="critical">
                      {thumbnailUploadFetcher.data?.error ||
                        "Thumbnail upload failed."}
                    </Banner>
                  )}
                </BlockStack>
              </Box>
            )}

            {form.thumbnailUrl && (
              <InlineStack
                gap="300"
                blockAlign="center"
              >
                <Thumbnail
                  source={form.thumbnailUrl}
                  alt="Selected video thumbnail"
                  size="large"
                />

                <Text
                  variant="bodySm"
                  tone="success"
                >
                  Thumbnail selected
                </Text>
              </InlineStack>
            )}
          </BlockStack>
        </Modal.Section>

        {/* Active status */}

        <Modal.Section>
          <Checkbox
            label="Active"
            checked={form.isActive}
            onChange={(checked) =>
              setForm((previous) => ({
                ...previous,
                isActive: checked,
              }))
            }
            helpText="Only active videos appear in the storefront widget."
          />
        </Modal.Section>
      </Modal>

      {/* ============================================
          DELETE CONFIRMATION
      ============================================ */}

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
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setDeleteModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            Are you sure you want to delete this video? This action cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>

      {/* Toast */}

      {toastActive && (
        <Toast
          content={toastMessage}
          error={toastError}
          onDismiss={() => setToastActive(false)}
        />
      )}
    </Page>
  );
}

// ==================================================
// ROUTE ERROR BOUNDARY
// ==================================================

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};