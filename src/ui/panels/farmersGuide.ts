import { html as trHtml, msg as trMsg, t as tr } from "../../i18n";
import { openModal } from "../Modal";

import { FARMERS_GUIDE_PAGES } from "../../content/farmersGuide";
export { FARMERS_GUIDE_PAGES } from "../../content/farmersGuide";
export type { GuidePage } from "../../content/farmersGuide";

const GITHUB_URL = "https://github.com/actualdoctornerd-ai/Zombie-Farm-2-Reforged";

function externalLink(label: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "guide-link";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = tr(label);
  return link;
}

export function openFarmersGuide(host: HTMLElement): void {
  const { panel } = openModal({
    host,
    bgClass: "guide-bg",
    panelClass: "guide-panel",
    replaceSelector: ".guide-bg",
  });

  const header = document.createElement("header");
  header.className = "guide-header";
  const mark = document.createElement("span");
  mark.className = "guide-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "📖";
  const heading = document.createElement("div");
  heading.innerHTML = trHtml`<h2>Farmer’s Guide</h2><p>Field notes for zombie farmers</p>`;
  header.append(mark, heading);

  const layout = document.createElement("div");
  layout.className = "guide-layout";
  const nav = document.createElement("nav");
  nav.className = "guide-nav";
  nav.setAttribute("aria-label", tr("Farmer’s Guide pages"));
  const article = document.createElement("article");
  article.className = "guide-article";
  article.setAttribute("aria-live", "polite");

  const footer = document.createElement("div");
  footer.className = "guide-footer";
  const position = document.createElement("span");
  position.className = "guide-position";
  const controls = document.createElement("div");
  controls.className = "guide-controls";
  const previous = document.createElement("button");
  previous.className = "guide-button";
  previous.textContent = tr("← Previous");
  const next = document.createElement("button");
  next.className = "guide-button guide-next";
  next.textContent = tr("Next →");
  controls.append(previous, next);
  footer.append(position, controls);

  let activeIndex = 0;
  const navButtons = FARMERS_GUIDE_PAGES.map((page, index) => {
    const button = document.createElement("button");
    button.className = "guide-nav-button";
    button.textContent = tr(page.label);
    button.onclick = () => render(index);
    nav.appendChild(button);
    return button;
  });

  const render = (index: number) => {
    activeIndex = index;
    const page = FARMERS_GUIDE_PAGES[index];
    article.replaceChildren();

    const title = document.createElement("h3");
    title.textContent = tr(page.title);
    const intro = document.createElement("p");
    intro.className = "guide-intro";
    intro.textContent = tr(page.intro);
    if (page.eyebrow) {
      const eyebrow = document.createElement("div");
      eyebrow.className = "guide-eyebrow";
      eyebrow.textContent = tr(page.eyebrow);
      article.appendChild(eyebrow);
    }
    article.append(title, intro);

    for (const section of page.sections) {
      const block = document.createElement("section");
      const sectionTitle = document.createElement("h4");
      sectionTitle.textContent = tr(section.title);
      const body = document.createElement("p");
      body.textContent = tr(section.body);
      block.append(sectionTitle, body);
      if (page.id === "project" && section.title === "GitHub")
        block.appendChild(externalLink("Open the GitHub repository ↗", GITHUB_URL));
      article.appendChild(block);
    }

    navButtons.forEach((button, buttonIndex) => {
      button.classList.toggle("active", buttonIndex === activeIndex);
      button.setAttribute("aria-current", buttonIndex === activeIndex ? "page" : "false");
    });
    position.textContent = trMsg`${activeIndex + 1} of ${FARMERS_GUIDE_PAGES.length}`;
    previous.disabled = activeIndex === 0;
    next.disabled = activeIndex === FARMERS_GUIDE_PAGES.length - 1;
  };

  previous.onclick = () => render(Math.max(0, activeIndex - 1));
  next.onclick = () => render(Math.min(FARMERS_GUIDE_PAGES.length - 1, activeIndex + 1));

  layout.append(nav, article);
  panel.append(header, layout, footer);
  render(0);
}
