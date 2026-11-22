const MAX_LENGTH = 2_048;
export const MAX_THREAD_LINKS = 10;
const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i;
const GITLAB_MR = /^https?:\/\/[^/]+\/.+\/-\/merge_requests\/(\d+)(?:[/?#]|$)/i;
const CHANGE_REQUEST = /https?:\/\/(?:(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+(?::\d+)?\/[\w./-]+?\/-\/merge_requests\/\d+)(?![\w-])/gi;

export function threadLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.href.length <= MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

export function threadLinkLabel(url: string): string | null {
  const github = GITHUB.exec(url);
  if (github) return `#${github[1]}`;
  const mergeRequest = GITLAB_MR.exec(url);
  return mergeRequest ? `!${mergeRequest[1]}` : null;
}

export function threadLinkUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_THREAD_LINKS) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const url = threadLinkUrl(entry);
    if (!url) return null;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function threadLinksOf(task: { link?: string; links?: readonly string[] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };
  add(task.link);
  for (const entry of task.links ?? []) add(entry);
  return out;
}

export function threadLinkDisplayLabel(url: string): string {
  const short = threadLinkLabel(url);
  if (short) return short;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function lastChangeRequestUrl(text: string): string | null {
  const match = [...text.matchAll(CHANGE_REQUEST)].at(-1)?.[0];
  return match ? threadLinkUrl(match) : null;
}
