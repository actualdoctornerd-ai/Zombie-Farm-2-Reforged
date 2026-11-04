# Localization

The client offers nine distinct languages from Zombie Farm 2 2.25: English,
German, Spanish, French, Italian, Japanese, Korean, Dutch and Simplified Chinese.
Only the main app's tables are imported; Facebook SDK strings are excluded.

## Resource provenance

`src/i18n/locales/{language}.json` preserves the original binary plist's strings
without machine translation or changes to wording. `src/i18n/source.json` records
the IPA checksum, bundle path, entry counts and the identical Chinese tables.
The original translations belong to their respective owners, alongside the
original game assets; they are excluded from the code's MIT license.

The IPA contains `zh`, `zh-Hans` and `zh-Hant`, but their contents are identical
Simplified Chinese. These tags resolve to `zh-CN`; the client does not advertise
a Traditional Chinese translation that the source does not actually contain.

`zh-CN-extra.json` contains separately authored Chinese for missing original text
and Reforged additions, plus explicit terminology corrections. It is loaded after
the original table. Original wording is otherwise retained; additions use terms such as 脑子,
僵尸花盆, 变种 and 老兵, with brief, friendly guidance in Tim's voice. Descriptions
must describe current gameplay, including features that differ from the IPA.
Third-party translation services are not used for this supplement.

The Chinese display overrides normalize `Carrots` from 红萝卜 to 胡萝卜,
including golden variants, mutations, quests and tutorial lines. They also change
the flower decoration `Daisy` from 黛西 to 雏菊, matching the original quest and
description wording. The extracted IPA tables remain unchanged for comparison.

### Naming review

A review of crop, decoration, zombie, pet, farmer and upgrade names found both
inherited mistranslations and mistakes in the authored supplement. Corrections
live in `zh-CN-extra.json`, alongside matching quest and tutorial terminology.
Catalog keys and the original tables are unchanged.

| Source | Previous display | Corrected display / reason |
| --- | --- | --- |
| Onions | 葱 | 洋葱; matches the existing onion mutant names |
| Turnips / Turnip Zombie | 萝卜 / 萝卜僵尸 | 芜菁 / 芜菁僵尸; matches golden turnips |
| Lima Beans / Lima Bean Zombie | 青豆 / 青豆僵尸 | 利马豆 / 利马豆僵尸; matches the named mutation |
| Broccoli Zombie | 花椰菜僵尸 | 西兰花僵尸; distinguish from cauliflower |
| Cauliflower harvest text | 菜花 | 花菜; match the crop card |
| Sun Glower | 太阳发光体 | 怒目向日葵; the sprite is a scowling sunflower |
| Poppy / Poppy Power | 罂粟 / 罂粟力量 | 波比 / 波比的力量; this is the named Tree World fairy, not a flower |
| Zombielocks | 锁僵尸 | 金发僵尸; the portrait has blonde curls |
| Imp Zombie | 顽童僵尸 | 小鬼僵尸; match its demonic portrait and combine hint |
| Zombricaun | 少年僵尸 | 爱尔兰小妖僵尸; the portrait has a shamrock hat and leprechaun costume |
| Reindeer Zombie | 麋鹿僵尸 | 驯鹿僵尸 |
| Pink / Yellow Peep | 粉红 / 黄色猫眼 | 粉色 / 黄色棉花糖小鸡; match the chick-shaped Easter decoration |
| Carecrow | 护理乌鸦 | 暖心稻草人; the friendly scarecrow holds flowers and wears a heart |
| Sham Rock | 摇滚三叶草 | 三叶草石; the asset is a clover-shaped rock |
| Toxic Drum | 毒鼓 | 有毒废料桶; the asset is a leaking hazard barrel |
| Giant Candy Cane | 巨型棒棒糖 | 巨型拐杖糖; distinguish from Giant Lollipop |
| Small / Large Cooler | 小 / 大冷却器 | 小型 / 大型保温箱; these are picnic coolers |
| Blue / Red Outhouse | 蓝色 / 红色外屋 | 蓝色 / 红色茅厕; match the base building |
| Stone Bend / Stone Crossing | 石弯 / 石渡 | 石路转角 / 石路交叉口; these are road pieces |
| Sand Dollar | 沙元 | 沙钱; the asset is the shell, not currency |
| Gazebo | 眺望台 | 凉亭; match the building sprite and guide |
| Evergreen Tree | 冬青树 | 常青树; the source does not specify holly |
| Snow Woman | 雪女人 | 女雪人 |
| Fence / Hedge variants | 栅栏、护栏、篱笆 mixed | 栅栏 / 树篱; keep the two object families distinct |
| Tiki Head variants | 蒂基 / 提基 mixed | 蒂基头像 for both sizes |
| Blue / Red Grave | 蓝墓 / 红墓地 | 蓝色 / 红色坟墓 |
| McDonnell's Barn | 麦克唐纳的谷仓 | 麦老爹的谷仓; match the established character name |
| Skeleton Female | 骨架女 | 骷髅女; match Skeleton Male |
| Tent / Blue Tent | 帐蓬 / 蓝色帐蓬 | 帐篷 / 蓝色帐篷 |

The supplement also consistently uses the original item names 即时生长 and
金色骰子, refers to Concentration as 集中 (集中加速器 in explanatory text), and
uses 即时犁地 for Insta-Plow. Zombee and Zombarian quest objectives now name the
same species as their cards instead of omitting or changing the species name.

Context matters: Heart Fountain really depicts an anatomical heart, so its
心脏喷泉 translation is retained. Egg Plant visibly grows eggs; it remains
彩蛋植物 rather than being changed to 茄子.

To reproduce or verify the original tables using your own local IPA:

```sh
python3 tools/extract_localizations.py Zombie_Farm_2_2.25.ipa
python3 tools/extract_localizations.py Zombie_Farm_2_2.25.ipa --check
```

The extractor reads ZIP members directly and does not unpack artwork, executable
files or SDK bundles. The IPA is ignored by Git. A regular checkout needs neither
Python nor the IPA to play, build or run the localization checks.

## Code boundaries

- `src/i18n/index.ts` owns browser language detection, the device preference,
  asynchronous resource loading and the root document's language. Language
  chunks are bundled by Vite, so relative project hosting and the PWA work without
  hardcoded asset URLs. A failed language load falls back to English.
- `src/i18n/translate.ts` contains translation and formatting, without DOM or
  storage dependencies. Original Objective-C `%@`, `%i` and positional printf
  strings get runtime aliases with numbered parameters; source tables stay intact.
- UI code translates at rendering. Catalog keys, quest notifications, commands,
  server economy values, saved zombie names and the save schema stay canonical.
  Authored content such as `src/content/farmersGuide.ts` stays separate from its
  renderer. The tutorial's menu anchors continue using their English identifiers.
  Pixi text also translates at rendering, including the farmer's plow, plant and
  harvest progress bars (fruit-tree harvesting uses the same label renderer).

Use `t("Settings")` for fixed labels and `msg` or `message` for complete sentences:

```ts
import { t, msg, message } from "./i18n";

const caption = msg`Buy ${t(item.name)}?`; // source key: Buy {0}?
const greeting = message("{0} sent you {1}!", friend.name, t(item.name));
```

Translate catalog names explicitly; leave player names literal. Parameters are
inserted once and can be reordered. Chinese suppresses an English plural `s`
only where the source explicitly places it after a known pluralized noun.

The `html` tagged template supports existing authored HTML: it translates source
text and accessibility labels before inserting arguments, preserving classes and
other attributes. Translated characters are HTML-escaped. Arguments retain the
existing caller's HTML-escaping contract; this helper is **not a sanitizer** and
does not make an unescaped player name safe. Use `textContent` for user content.
Never translate a rendered DOM tree or use translated captions as control IDs.

Some existing view models arrive as formatted English strings. A compatibility
lookup recognizes known message templates for these display values, with a bounded
cache. New UI should use complete `msg`/`message` calls instead of adding more
string concatenation. Generated periodic quest names use catalog translations;
their canonical subjects and progress tracking remain unchanged.

## Checks

```sh
npm run i18n:check
npm test
npm run build
```

The inventory reads explicit translation calls, UI content records, original
catalog display fields and boot-screen copy. It requires a nonempty Chinese
translation and validates numbered placeholders. It excludes protocol IDs,
filenames, CSS classes, source-code identifiers and user-authored text. Other
languages may fall back to English for Reforged additions.

This is a static coverage gate, not proof that every possible screen renders
correctly. Review new UI in Chinese, including hover text, empty states and
320/390-pixel layouts. Check language changes with a saved farm and ensure that
names entered by players remain unchanged. Logos, artwork text and live operator
announcements are outside the client message inventory.

The rendering audit also covers Pixi work bars, generated durations, mutation
lists/tooltips, Almanac acquisition hints, statistics values, Black Market
messages, layout result fragments and accessibility labels. Translate authored
catalog names and duration values **before** inserting them into a translated
template; `msg` and `html` deliberately keep arguments literal. Translate each
authored message before joining it with other messages. Translating only the
final combined string cannot reliably handle lists or optional sentences.
`displayBoundaries.test.ts` exercises actual work-bar creation and serialized
job kinds, statistics with a player name matching a crop, and nested Almanac
and mutation descriptions to catch omissions that resource coverage misses.

All changes here are client-side. Publishing the updated client is sufficient;
no Worker deployment or database migration is required.
