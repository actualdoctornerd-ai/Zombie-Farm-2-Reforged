import { openModal } from "../Modal";

export interface GuidePage {
  id: string;
  label: string;
  eyebrow?: string;
  title: string;
  intro: string;
  sections: Array<{
    title: string;
    body: string;
  }>;
}

export const FARMERS_GUIDE_PAGES: GuidePage[] = [
  {
    id: "welcome",
    label: "Welcome",
    title: "Welcome to Zombie Farm Reforged",
    intro: "A field guide to for zombie farmers.",
    sections: [
      {
        title: "Zombie Farm Reforged",
        body: "Zombie Farm Reforged is a fan remake of the Zombie Farm games, which were removed from the App Store in 2017. This version incorporates elements from both Zombie Farm 1 and Zombie Farm 2 into a format that is playable on any device that can run a browser. The project is open source and nonprofit.",
      },
    ],
  },
  {
    id: "saves",
    label: "Your saves",
    title: "Local vs. Online Farms",
    intro: "Local Farm and Online Farm are deliberately separate. Progress never transfers or merges between them.",
    sections: [
      {
        title: "Local Farm",
        body: "Saved only in this browser. It works without an account or gameplay server, but clearing browser data or changing devices can remove access to the save. Use Settings to export a backup, which can be imported to any device. A local farm allows you to have full control of your own data and play the game without an internet connection.",
      },
      {
        title: "Online Farm",
        body: "Tied to your signed-in account and saved by the game server. You can continue on another device and use online features. Only one browser or device can control the farm at a time. This is the recommended way to play.",
      },
    ],
  },
  {
    id: "install",
    label: "Install",
    title: "Installing the App",
    intro: "Zombie Farm Reforged can be installed straight from your browser, no app store required.",
    sections: [
      {
        title: "Why Install",
        body: "Installing puts a Zombie Farm icon on your desktop, dock, or home screen, so the game opens in one tap instead of through a bookmark. It also runs in its own window with no address bar or browser tabs taking up space, which leaves more room for your farm. The game files are cached on your device after the first visit, so later launches start faster.",
      },
      {
        title: "On Desktop",
        body: "In Chrome or Edge, open the game and look for the install icon at the right-hand end of the address bar, or find Install in the browser menu. In Safari on macOS, choose File and then Add to Dock. Once installed, the game behaves like any other app and can be pinned, uninstalled, or launched normally.",
      },
      {
        title: "On Phones and Tablets",
        body: "In Safari on iPhone or iPad, tap the Share button and choose Add to Home Screen. In Chrome on Android, open the browser menu and choose Install app or Add to Home screen. The installed app runs fullscreen, which is the most comfortable way to play on a small display.",
      },
      {
        title: "Saves and Updates",
        body: "An installed app can keep its own separate browser storage, so a Local Farm played in a browser tab may not appear inside the installed app. Export a backup from Settings before installing, then import it once the app is open. A Local Farm can be played without an internet connection once its artwork has been cached, while an Online Farm always needs a connection. New versions arrive automatically: when one is ready, a small prompt appears so you can reload at a safe moment rather than in the middle of an invasion.",
      },
    ],
  },
  {
    id: "currency",
    label: "Currency",
    title: "Currency",
    intro: "Gold and Brains",
    sections: [
      {
        title: "Gold",
        body: "Gold is the base currency in this game. It is obtained primarily from harvesting crops and completing invasions.",
      },
      {
        title: "Brains",
        body: "Brains are highly valuable on a zombie farm and are used to purchase powerful functional items. Brains may be obtained through invasions and Epic Bosses or received as gifts. Brains are also the primary currency for the Black Market, where farmers may trade zombies. Because there are no in-app purchases, drop rates for brains across the board have been approximately doubled.",
      },
    ],
  },
  {
    id: "mutations",
    label: "Mutations",
    title: "Mutations",
    intro: "Zombies can mutate to take on the characteristics of various plants from your farm!",
    sections: [
      {
        title: "Obtaining Mutations",
        body: "Plant vegetables directly beside a zombie plot to give the harvested zombie a chance at developing the mutation associated with them. Any plot touching the zombie's counts — edge or corner — even if the two were plowed in different passes and don't line up. If you want to ensure that a specific mutation is obtained, then plant a mutated zombie directly instead.",
      },
      {
        title: "Headless Zombies",
        body: "A headless zombie has no head to mutate, so head and hair mutations never take on one — plant beside its arms, body and neck crops instead. Pumpking is the exception, and it runs the other way: the pumpkin becomes the head it never had, so only a headless zombie can grow one. Any zombie can wear one, mind — put a Pumpking-headed zombie in the Zombie Pot and the pumpkin passes to the result, whatever comes out.",
      },
      {
        title: "Zombie Pot",
        body: "The Zombie Pot can also combine two zombies and inherit compatible traits. It draws on your whole roster — a zombie resting in the Mausoleum can go straight in without being deployed first, and the finished zombie can be collected into the Mausoleum instead of onto the farm. The zombie you place in Slot 1 decides what type comes out — Slot 2 only donates its mutations, and where two mutations compete for the same body part the stronger one wins. Special zombies fit in Slot 1 only, and are always passed on. Combining two zombies of the same type breeds them up a colour: two Greens become the Blue of that type once you own the Blue Grave, two Blues become the Red once you own the Red Grave, and at higher levels two Reds become a Silver. Every eligible pairing also comes with a low chance of mutating into powerful special zombies instead.",
      },
    ],
  },
  {
    id: "combat",
    label: "Combat",
    title: "Invasions & Epic Bosses",
    intro: "Put your harvested zombies to work in live battles for loot, experience, gold, and brains.",
    sections: [
      {
        title: "Raids",
        body: "Choose an invasion and assemble an army for the fight. Tougher stages bring stronger enemies and better rewards. Fallen zombies are permanently lost, though they may be revived immediately after the battle for the cost of 1 brain.",
      },
      {
        title: "Epic Bosses",
        body: "Starting at level 24, you can begin limited 14-day boss events from Market → Epic Boss. Boss damage carries between attempts. Harvesting crops during an event provides fight tokens, which allow you to take another attempt at the boss. Defeating the boss provides escalating special rewards, including extremely powerful special zombies. Each boss also has a favourite crop, named on its card — see Favourite Crops below for what planting it does.",
      },
      {
        title: "Favourite Crops",
        body: "Every Epic Boss has one favourite crop it cannot leave alone. You can see which is which on the boss's card in Market → Epic Boss. A favourite crop does two things, and never both at once. While that boss's event is running, harvesting its favourite crop yields fight tokens more often than any other crop would — about a quarter more — so it is worth keeping some in the ground for the fortnight the event lasts. When no event is running at all, that same harvest instead has a very rare chance of luring its boss onto the farm and starting the event outright, for free, provided you have reached the level that boss unlocks at. Planting is the only thing that steers it: a crop can only ever call its own boss, and a boss you have not unlocked yet will not come. Treat it as a lucky accident rather than a plan — there is nothing to collect and nothing to claim if it does not happen, and the odds are long enough that the surest way to start an event is still to pay for it.",
      },
      {
        title: "Earned Zombies",
        body: "A zombie you win from a quest, an invasion, or a boss joins the farm right away when there is an open army slot. If your farm is full it waits in Storage → Received instead, and is never lost. Claiming it from there moves it into the Mausoleum, so you will need a Mausoleum with a free space before it can join your roster. The Mausoleum starts with 15 slots and can be upgraded four times — tap the building, or buy the next one from Market → Items → Functional — for five more slots each time.",
      },
    ],
  },
  {
    id: "social",
    label: "Social",
    title: "Friends & community",
    intro: "Online Farm adds ways to play alongside other farmers.",
    sections: [
      {
        title: "Friends",
        body: "Share your friend code with another player to become friends with them. Friends can visit each other’s farms and gift each other brains. A limit of two brains can be gifted per day at no cost to the sender.",
      },
      {
        title: "The Black Market",
        body: "The Black Market is a new feature in Zombie Farm Reforged, which allows farmers to trade zombies for brains. Farmers may request a specific zombie, or put one of their own zombies up for sale.",
      },
      {
        title: "Discord",
        body: "Join the community Discord, The Zombie Farm Archive, to ask for help, share feedback, and meet other farmers. This is also a good place to report bugs or request additional features.",
      },
    ],
  },
  {
    id: "privacy",
    label: "Privacy",
    title: "Your data",
    intro: "What this game knows about you, who can see it, and how to take it back. The short version: less than you would expect.",
    sections: [
      {
        title: "A Local Farm is completely private",
        body: "A Local Farm never contacts a server at all. There is no account, no sign-in, and no request of any kind leaves your device — the farm lives in your browser's own storage and nowhere else. Nobody, including us, can see it. The trade is that it is only as safe as the browser holding it, so use Settings to export a backup if it matters to you.",
      },
      {
        title: "Signing in tells us less than you would think",
        body: "When you sign in with Google, Google hands the game a token that contains an anonymous id number, your email address, and your Google display name. The game reads the id number and deliberately throws the other two away — your email address and your Google name are never stored, never sent anywhere, and never shown to anyone. The id number is meaningless outside this game; it exists only so that signing in again finds the same farm.",
      },
      {
        title: "What is actually on the server",
        body: "Your account row holds four things: that anonymous id, the name you chose for yourself, your friend code, and when you last played. Alongside it sits your farm — crops, zombies, buildings, quests, invasions, everything you have earned. There is also a list of your signed-in devices, each labelled roughly, like \"Chrome on Windows\", so you can spot a session you do not recognise and end it from the Account menu. No email addresses, no IP addresses, no location, and no real names are stored anywhere.",
      },
      {
        title: "What other farmers can see",
        body: "The name you choose is the only thing about you that other players see, and it appears in two places: to friends, and on any Black Market post you create, where every farmer browsing the market can read it. Choose it with that in mind. A friend visiting your farm gets a look-only copy that shows the farm, your buildings, your zombies and your Zombie Pot — your gold and brains read as zero, and your quests, invasions, storage and friend list are not sent at all. Nobody can change anything on your farm, ever. You can hand out a new friend code from the Account menu whenever you like, which retires the old one, and you can block another farmer to cut off contact entirely.",
      },
      {
        title: "No ads, no analytics, no tracking",
        body: "There is no advertising, no analytics, no third-party tracking of any kind, and nothing about you is sold, shared, or handed to anyone. This is not only a promise: the game ships with a browser security policy that permits it to talk to exactly two places — Google's sign-in page and this game's own server — so it could not quietly report to anywhere else even if something in it tried.",
      },
      {
        title: "Crash reports stay on your device",
        body: "If something goes wrong, the game keeps a short record of it in your browser so you can help us fix it. That record is never sent automatically and never leaves your device on its own. Settings has a Copy Diagnostics button that puts it on your clipboard, and it is entirely up to you whether to paste it into a bug report. It contains no personal information — just the game version, what failed, and what you were doing at the time.",
      },
      {
        title: "Taking your farm, or removing it",
        body: "Settings can export any farm to a file at any time, which you can keep as a backup or import into a Local Farm on another device. Nothing locks your progress in. If you would rather not be here at all, the Account menu has a Delete button: it asks you twice, and then removes your account and everything attached to it — the farm, the zombies, the friendships, the lot. It is immediate, it is permanent, and nothing is kept back or archived. Signing in afterwards simply starts you a brand-new farm, because there is nothing left to sign in to. A Local Farm has the same button and works the same way, on the save in this browser.",
      },
    ],
  },
  {
    id: "project",
    label: "Project",
    title: "Open source & credits",
    intro: "Zombie Farm 2 Reforged is a non-commercial, open-source fan reimplementation built for preservation.",
    sections: [
      {
        title: "GitHub",
        body: "Read the source, report bugs, browse current gaps, or contribute improvements on GitHub. Feel free to branch off of this repository to make your own version as well.",
      },
      {
        title: "Acknowledgements",
        body: "Created and maintained by DoctorNerd. Special thanks to Brain for starting and maintaining the Zombie Farm Archive, without which this project would never have existed. Thank you as well to our alpha testers—Dan, Biggoard, SuperKiwi, SpacePerson, and EnchantedKT—for their early feedback and testing.",
      },
    ],
  },
];

const GITHUB_URL = "https://github.com/actualdoctornerd-ai/Zombie-Farm-2-Reforged";

function externalLink(label: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "guide-link";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
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
  heading.innerHTML = "<h2>Farmer’s Guide</h2><p>Field notes for zombie farmers</p>";
  header.append(mark, heading);

  const layout = document.createElement("div");
  layout.className = "guide-layout";
  const nav = document.createElement("nav");
  nav.className = "guide-nav";
  nav.setAttribute("aria-label", "Farmer’s Guide pages");
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
  previous.textContent = "← Previous";
  const next = document.createElement("button");
  next.className = "guide-button guide-next";
  next.textContent = "Next →";
  controls.append(previous, next);
  footer.append(position, controls);

  let activeIndex = 0;
  const navButtons = FARMERS_GUIDE_PAGES.map((page, index) => {
    const button = document.createElement("button");
    button.className = "guide-nav-button";
    button.textContent = page.label;
    button.onclick = () => render(index);
    nav.appendChild(button);
    return button;
  });

  const render = (index: number) => {
    activeIndex = index;
    const page = FARMERS_GUIDE_PAGES[index];
    article.replaceChildren();

    const title = document.createElement("h3");
    title.textContent = page.title;
    const intro = document.createElement("p");
    intro.className = "guide-intro";
    intro.textContent = page.intro;
    if (page.eyebrow) {
      const eyebrow = document.createElement("div");
      eyebrow.className = "guide-eyebrow";
      eyebrow.textContent = page.eyebrow;
      article.appendChild(eyebrow);
    }
    article.append(title, intro);

    for (const section of page.sections) {
      const block = document.createElement("section");
      const sectionTitle = document.createElement("h4");
      sectionTitle.textContent = section.title;
      const body = document.createElement("p");
      body.textContent = section.body;
      block.append(sectionTitle, body);
      if (page.id === "project" && section.title === "GitHub")
        block.appendChild(externalLink("Open the GitHub repository ↗", GITHUB_URL));
      article.appendChild(block);
    }

    navButtons.forEach((button, buttonIndex) => {
      button.classList.toggle("active", buttonIndex === activeIndex);
      button.setAttribute("aria-current", buttonIndex === activeIndex ? "page" : "false");
    });
    position.textContent = `${activeIndex + 1} of ${FARMERS_GUIDE_PAGES.length}`;
    previous.disabled = activeIndex === 0;
    next.disabled = activeIndex === FARMERS_GUIDE_PAGES.length - 1;
  };

  previous.onclick = () => render(Math.max(0, activeIndex - 1));
  next.onclick = () => render(Math.min(FARMERS_GUIDE_PAGES.length - 1, activeIndex + 1));

  layout.append(nav, article);
  panel.append(header, layout, footer);
  render(0);
}
