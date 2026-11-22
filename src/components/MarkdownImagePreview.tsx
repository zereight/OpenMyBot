import { useEffect, useRef, useState } from "react";
import { ImageOff, RotateCcw } from "lucide-react";
import {
  AttachmentPreviewDialog,
  AttachmentThumbnail,
  canonicalDownloadFilename,
  isExternalImageSource,
  messageImagePreviewUrl,
  requestMessageFile,
  type MessageAttachmentContext,
  type PreviewImage,
} from "./AttachmentPreview";
import { ImageLoading } from "./ImageLoading";
import { t } from "@/lib/i18n";

export interface MarkdownFileContext {
  path: string;
  message: MessageAttachmentContext;
}

export interface MarkdownImagePreviewProps {
  src: string;
  name: string;
  openUrl?: string;
  message?: MessageAttachmentContext;
  markdownFile?: MarkdownFileContext;
  filePath?: string;
  sourceOffset?: number;
}

export function MarkdownImagePreviewView({
  src,
  name,
  openUrl,
  message,
  markdownFile,
  filePath,
  sourceOffset,
}: MarkdownImagePreviewProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const threadId = message?.threadId;
  const messageId = message?.messageId;
  const localSourceOffset = typeof sourceOffset === "number" && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0
    ? sourceOffset
    : null;
  const localMessageImage = Boolean(
    filePath && threadId && messageId && localSourceOffset !== null,
  );
  const markdownFileImage = Boolean(
    !localMessageImage && filePath && markdownFile && localSourceOffset !== null,
  );
  const localImageKey = localMessageImage
    ? `${threadId}\u0000${messageId}\u0000${localSourceOffset}`
    : markdownFileImage && markdownFile
      ? `${markdownFile.message.threadId}\u0000${markdownFile.message.messageId}\u0000${markdownFile.path}\u0000${localSourceOffset}`
      : null;
  const [visibleLocalImageKey, setVisibleLocalImageKey] = useState<string | null>(null);
  const [markdownAttempt, setMarkdownAttempt] = useState(0);
  const [markdownBlob, setMarkdownBlob] = useState<{ key: string; url: string; mime: string | null } | null>(null);
  const [markdownFetchError, setMarkdownFetchError] = useState<{ key: string; outsideWorkspace: boolean } | null>(null);
  const external = !filePath && isExternalImageSource(src);
  const [approvedExternalSource, setApprovedExternalSource] = useState<string | null>(null);

  useEffect(() => {
    if (!localImageKey) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisibleLocalImageKey(localImageKey);
      return;
    }
    setVisibleLocalImageKey(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisibleLocalImageKey(localImageKey);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [localImageKey]);

  const shouldLoadLocalImage = (localMessageImage || markdownFileImage) && (visibleLocalImageKey === localImageKey || open);
  useEffect(() => {
    if (!markdownFileImage || !shouldLoadLocalImage || !markdownFile || localSourceOffset === null || !localImageKey) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setMarkdownFetchError(null);
    void (async () => {
      try {
        const response = await requestMessageFile(markdownFile.path, markdownFile.message, controller.signal, { imageRef: localSourceOffset });
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setMarkdownBlob({ key: localImageKey, url: objectUrl, mime: blob.type || response.headers.get("content-type") });
      } catch (reason) {
        if (controller.signal.aborted) return;
        const code = (reason as { code?: unknown } | null)?.code;
        setMarkdownFetchError({ key: localImageKey, outsideWorkspace: code === "outside_workspace" });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [markdownFileImage, shouldLoadLocalImage, markdownFile?.path, markdownFile?.message.threadId, markdownFile?.message.messageId, localSourceOffset, localImageKey, markdownAttempt]);

  const activeMarkdownBlob = markdownFileImage && markdownBlob?.key === localImageKey ? markdownBlob : null;
  const activeMarkdownError = markdownFileImage && markdownFetchError?.key === localImageKey ? markdownFetchError : null;
  const externalAllowed = !external || approvedExternalSource === src;
  const visibleSource = externalAllowed
    ? localMessageImage
      ? shouldLoadLocalImage && filePath && threadId && messageId && localSourceOffset !== null
        ? messageImagePreviewUrl({ threadId, messageId }, localSourceOffset)
        : null
      : markdownFileImage
        ? activeMarkdownBlob?.url ?? null
        : src
    : null;
  const localResolvedImage = localMessageImage || markdownFileImage;
  const image: PreviewImage = {
    src: visibleSource ?? "",
    name,
    openUrl,
    downloadUrl: localResolvedImage ? visibleSource ?? undefined : undefined,
    downloadName: localResolvedImage
      ? canonicalDownloadFilename({ fallback: name, source: filePath, mime: activeMarkdownBlob?.mime })
      : undefined,
  };
  return (
    <>
      <span ref={containerRef} className="my-2 block w-[min(36rem,70vw)] max-w-full">
        {external && !externalAllowed ? (
          <span className="flex aspect-[4/3] max-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset px-4 text-center text-[12px] text-ink-secondary">
            <ImageOff size={20} />
            <span>{t("attach.externalHidden")}</span>
            <button type="button" className="rounded-md border border-hairline/50 bg-panel px-2.5 py-1 text-ink hover:bg-raised" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setApprovedExternalSource(src); }}>{t("attach.loadImage")}</button>
          </span>
        ) : filePath && !localResolvedImage ? (
          <span className="flex aspect-[4/3] max-h-96 items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset text-[12px] text-ink-secondary" role="alert">
            <ImageOff size={17} /> {t("attach.oldImage")}
          </span>
        ) : activeMarkdownError ? (
          <span className="flex aspect-[4/3] max-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-hairline/40 bg-inset px-3 text-center text-ink-secondary" role="alert">
            <ImageOff size={22} />
            {activeMarkdownError.outsideWorkspace ? (
              <span className="max-w-full text-[12px]">{t("attach.imageOutsideWorkspace")}</span>
            ) : (
              <>
                <span className="max-w-full truncate text-[12px]">{t("attach.imageUnavailable")}</span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMarkdownFetchError(null);
                    setMarkdownAttempt((value) => value + 1);
                  }}
                  className="flex items-center gap-1 rounded-md border border-hairline/50 bg-panel px-2 py-1 text-[11px] text-ink hover:bg-raised"
                  aria-label={t("attach.retryAria", { name })}
                >
                  <RotateCcw size={11} /> {t("chat.retry")}
                </button>
              </>
            )}
          </span>
        ) : visibleSource ? (
          <AttachmentThumbnail key={image.src} image={image} onPreview={() => setOpen(true)} className="max-h-96" eager explainRefusal={localMessageImage} />
        ) : (
          <ImageLoading name={name} className="aspect-[4/3] max-h-96 rounded-xl border border-hairline/40 bg-inset" />
        )}
        {openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-[11px] text-accent hover:underline">
            {t("attach.openOriginal")}
          </a>
        )}
      </span>
      {open && visibleSource && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </>
  );
}
