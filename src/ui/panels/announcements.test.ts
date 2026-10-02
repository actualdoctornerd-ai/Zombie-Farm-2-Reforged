import { describe, expect, it } from "vitest";
import { announcementBlocks } from "./announcements";

describe("announcementBlocks", () => {
  it("turns blank lines into paragraphs and joins wrapped lines", () => {
    expect(announcementBlocks("First line\ncontinues here.\n\nSecond paragraph.")).toEqual([
      { kind: "p", text: "First line continues here." },
      { kind: "p", text: "Second paragraph." },
    ]);
  });

  it("groups consecutive dash or star lines into one bullet list", () => {
    expect(announcementBlocks("What changed:\n- Life Force\n- Dr. Zombie nerf\n* Text fits\n\nThanks!")).toEqual([
      { kind: "p", text: "What changed:" },
      { kind: "ul", items: ["Life Force", "Dr. Zombie nerf", "Text fits"] },
      { kind: "p", text: "Thanks!" },
    ]);
  });

  it("handles Windows line endings and an empty body", () => {
    expect(announcementBlocks("a\r\n\r\nb")).toEqual([{ kind: "p", text: "a" }, { kind: "p", text: "b" }]);
    expect(announcementBlocks("  \n ")).toEqual([]);
  });

  it("never interprets markup: it is plain text that the panel renders with textContent", () => {
    expect(announcementBlocks("<b>hi</b> <script>x()</script>")).toEqual([
      { kind: "p", text: "<b>hi</b> <script>x()</script>" },
    ]);
  });
});
