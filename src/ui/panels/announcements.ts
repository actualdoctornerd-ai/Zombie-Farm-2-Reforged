// In-game announcements: the dialog a player sees once after an update, and the list they can
// reopen from Settings. The messages are operator-authored (server/scripts/announce.mjs) and
// arrive over the network, so every character is rendered with textContent — never as HTML.
import { markPrimary, openModal } from "../Modal";
import type { Announcement } from "../../net/announcements";

/** A message body as display blocks. Plain text only: a blank line starts a new paragraph, and
 *  consecutive lines beginning "- " (or "* ") form one bullet list. Pure, so it is testable. */
export type AnnouncementBlock =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] };

export function announcementBlocks(body: string): AnnouncementBlock[] {
  const blocks: AnnouncementBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: "ul", items: list });
    list = null;
  };
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flushParagraph();
      flushList();
    } else if (bullet) {
      flushParagraph();
      (list ??= []).push(bullet[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

function renderBody(into: HTMLElement, body: string): void {
  for (const block of announcementBlocks(body)) {
    if (block.kind === "p") {
      const p = document.createElement("p");
      p.textContent = block.text;
      into.appendChild(p);
    } else {
      const ul = document.createElement("ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      into.appendChild(ul);
    }
  }
}

const dateOf = (ms: number): string => {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
};

/** Show one announcement. Resolves once the player has dismissed it by any route (the button,
 *  the corner close, or a tap outside), which is what marks it read. */
export function openAnnouncement(
  host: HTMLElement, announcement: Announcement, index = 0, total = 1,
): Promise<void> {
  return new Promise((resolve) => {
    const { panel, close } = openModal({
      host,
      bgClass: "ann-bg",
      panelClass: "ann-panel",
      title: announcement.title,
      replaceSelector: ".ann-bg",
      onClose: () => resolve(),
    });
    const date = document.createElement("div");
    date.className = "ann-date";
    date.textContent = dateOf(announcement.publishedAt);
    const body = document.createElement("div");
    body.className = "ann-body";
    renderBody(body, announcement.body);
    const done = document.createElement("button");
    done.className = "ann-go";
    const more = total - index - 1;
    done.textContent = more > 0 ? `Next (${index + 1} of ${total})` : "Got it";
    markPrimary(done); // Enter dismisses
    done.onclick = () => close();
    panel.append(date, body, done);
    requestAnimationFrame(() => panel.classList.add("in"));
  });
}

/** Every announcement the Worker currently publishes, newest first, so a player can reread one. */
export function openAnnouncementHistory(host: HTMLElement, list: readonly Announcement[]): void {
  const { panel } = openModal({
    host,
    bgClass: "ann-bg",
    panelClass: "ann-panel ann-history",
    title: "Announcements",
    replaceSelector: ".ann-bg",
  });
  if (!list.length) {
    const none = document.createElement("div");
    none.className = "ann-none";
    none.textContent = "No announcements right now.";
    panel.appendChild(none);
    return;
  }
  for (const item of [...list].sort((a, b) => b.publishedAt - a.publishedAt || b.id - a.id)) {
    const card = document.createElement("section");
    card.className = "ann-item";
    const head = document.createElement("h3");
    head.textContent = item.title;
    const date = document.createElement("div");
    date.className = "ann-date";
    date.textContent = dateOf(item.publishedAt);
    const body = document.createElement("div");
    body.className = "ann-body";
    renderBody(body, item.body);
    card.append(head, date, body);
    panel.appendChild(card);
  }
}
