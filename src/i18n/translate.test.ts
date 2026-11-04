import { afterEach, describe, expect, it } from "vitest";
import { html, matchesLocalizedText, message, msg, printfAliases, t, useMessages } from "./translate";
import original from "./locales/zh-CN.json";
import extra from "./locales/zh-CN-extra.json";

afterEach(() => useMessages("en", {}));

describe("translation at the display boundary", () => {
  it("uses original IPA wording and falls back on missing or empty translations", () => {
    useMessages("zh-CN", { ...original, Empty: "", "Empty {0}": "" });
    expect(t("Brains")).toBe("脑子");
    expect(t("Zombie Pot")).toBe("僵尸花盆");
    expect(t("New feature")).toBe("New feature");
    expect(t("Empty")).toBe("Empty");
    expect(t("Empty 12")).toBe("Empty 12");
    expect(t(undefined)).toBeUndefined();
    expect(t("toString")).toBe("toString");
  });

  it("reorders arguments without translating user names or replacing inserted braces", () => {
    useMessages("zh-CN", { "{0} sent you {1}!": "你收到{0}送来的{1}！", Market: "市场" });
    expect(msg`${"Market"} sent you ${"{0}"}!`).toBe("你收到Market送来的{0}！");
    expect(message("{0} sent you {1}!", "Market", "a gift")).toBe("你收到Market送来的a gift！");
  });

  it("localizes legacy generated quests without changing the source model", () => {
    useMessages("zh-CN", { ...original, ...extra });
    const quest = { text: "Harvest 15 Carrots", notificationObject: "Carrots" };
    expect(t(quest.text)).toBe("收获15份胡萝卜");
    expect(quest).toEqual({ text: "Harvest 15 Carrots", notificationObject: "Carrots" });
    expect(t("Level 12 required")).toBe("需要12级");
  });

  it("translates HTML source text and accessibility labels while preserving classes and arguments", () => {
    useMessages("zh-CN", { Market: "市场", selected: "已选择", "Buy {0}": "购买{0}" });
    expect(html`<button class="selected" title="Market">Buy ${"Market"}</button>`)
      .toBe('<button class="selected" title="市场">购买Market</button>');
    expect(html`<b>${"Market"}</b>`).toBe("<b>Market</b>");
  });

  it("treats translated markup characters as text and retains the existing argument escaping contract", () => {
    useMessages("zh-CN", { Market: '<img src=x onerror="alert(1)">' });
    expect(html`<b>Market</b>`).toBe('<b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>');
    expect(html`<b>${"&lt;player&gt;"}</b>`).toBe("<b>&lt;player&gt;</b>");
  });

  it("keeps dollar signs literal in padded legacy text and formats brain rewards", () => {
    useMessages("zh-CN", { ...original, ...extra, "Hello {0}": "你好，{0}" });
    expect(t(" Hello $& ")).toBe(" 你好，$& ");
    expect(t("+1 Brain")).toBe("+1脑子");
    expect(msg`☄ INCOMING · ${2} cancel${"s"} left`).toBe("☄即将到来·还可取消2次");
  });

  it("clears formatted-message caches when changing language", () => {
    useMessages("zh-CN", { "Level {0}": "{0}级" });
    expect(t("Level 8")).toBe("8级");
    useMessages("de", { "Level {0}": "Stufe {0}" });
    expect(t("Level 8")).toBe("Stufe 8");
  });

  it("adapts original positional printf placeholders and full-width Chinese percent signs", () => {
    expect(printfAliases({ "You earned %1$d %2$@": "%2$@：%1$d", "Veteran %i": "老兵 ％i" }))
      .toEqual({ "You earned {0} {1}": "{1}：{0}", "Veteran {0}": "老兵 {0}" });
    useMessages("zh-CN", { ...original, ...extra });
    expect(t("Requires level 12")).toBe("需要12级");
  });

  it("omits English plural suffixes in Chinese without altering a player's name", () => {
    useMessages("zh-CN", { ...original, ...extra });
    expect(msg`Sent ${3} gift${"s"}!`).toBe("送出了3份礼物！");
    expect(msg`${"s"} sent you ${"脑子"}!`).toBe("s送给你脑子！");
    expect(t("Win 3 invasions")).toBe("赢得3次入侵");
    expect(t(" · 36% with a Brain Ticket")).toBe(" ·使用脑子门票时为36%");
  });

  it("searches both canonical English names and the player's displayed language", () => {
    useMessages("zh-CN", { ...original, ...extra });
    expect(matchesLocalizedText("Carrots", "胡萝卜")).toBe(true);
    expect(matchesLocalizedText("Carrots", " ＣＡＲＲＯＴ ")).toBe(true);
    expect(matchesLocalizedText("Carrots", "番茄")).toBe(false);
    expect(t("2h 15m")).toBe("2小时 15分钟");
  });
});
