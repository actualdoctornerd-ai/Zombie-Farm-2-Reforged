# Tutorial: original Zombie Farm 2 lines, by beat

Every quoted line below is **verbatim** from the original game, with `\n` shown as a line break.
Use them as-is, trim them, or splice them into the lines in `src/tutorial/steps.ts`.

**Where they came from**

- `ZF2R_extracted/data/original-plists/localization/English.lproj/Localizable.strings` — the
  English source table (2,860 entries; a binary plist). Almost every line here is a key in it.
- `ZF2R_extracted/app-internals/executable/ZF2R` — the game binary. Only the Welcome line lives
  here (UTF-16, with curly apostrophes), plus the beat event ids (`zf2_tut1_1` … `zf2_tut1_20`).
  The binary has no text for the later beats' own farewell lines; the ids exist
  (`tut1_14_extrazombies`, `tut1_19_nicejob`, `tut1_20_endtutorial`) but their strings are not
  recoverable, so a couple of the lines below are my best match by context and say so.

**How Tim talks:** folksy and short. `ya`, `yer`, `o'`, `'em`, `outta`, `gonna`, `somethin'`,
`darned`. Two or three short sentences, often one per line. CAPS on the one word to land
(`HARVEST`, `ZOMBIE INVASION`). Exclamation on the opener and the payoff. He explains what
a thing is *for* in half a sentence ("Plowing will prepare the patch of soil for re-planting").

---

## Beat by beat

### 1. Welcome  (current line is already verbatim)
> Welcome!
> I'm Tim Buckwheat, I'll be teachin' ya some Zombie Farming.

### 2. Plant a zombie  (current: "Got four plots all ready for ya! Tap the glowing soil, then pick the Zombie.")
- `Tap on the Soil`  *(the original arrow label)*
- `Tap on the freshly plowed soil to open the Market.\nThe Market is where you'll be able to select stuff to plant.\nYou can plant crops for money, or zombies to build yer army.`
- `Tap on the plowed land to open the Store. You can find Zombies under the Crops section.`
- After planting: `You just planted yer first crop, %@%@ will soon germinate!\n\nBe watchful, ya gotta harvest yer crops when they're ready or they'll wither away (Zombies too!).`

### 3. Plant a carrot beside it  (no original beat; current: "Now plant a Carrot in the plot right beside it. Crops growin' next to a zombie rub off on it!")
Closest originals about mutation:
- `(Harvest zombies next to food crops for a possible mutation)`  *(the market hint)*
- `Mutate by planting zombies next to certain crops.`  *(help text)*
- `WOAH! That's one bizarre zombie!\nThanks to all that Life Force, your zombie got some traits from the plants next to him. Some mutations increase speed, others increase power or defense. Visit the market to unlock more mutations.`  *(a good fit for AFTER the harvest)*

### 4. Speed it up  (current line is already verbatim)
> Growing zombies takes time.
> Let's speed it up!

Related originals, from the boost steps (the original made the player buy and use it themselves):
- `Open the Market`
- `Choose %i crops or zombies to grow instantly.`
- `Great! Now select the boost and use it!`
- `When you need your zombies and crops right now. One insta grow is good for 10 crops/zombies.`

### 5. Harvest  (current: "It's risen! Tap the zombie to harvest it.")
- `Yer Zombie is now ready.\nTime to HARVEST it!`   *(+ the arrow label `Tap to harvest`)*
- `Harvesting crops gains you gold. Harvesting zombies increases yer zombie army.\nTap on the half buried zombie with the thumbs-up there to harvest him.\nHe's just dying to get outta the ground!`
- After it's out: `This is yer basic home grown zombie.\nAlthough he's happy to be alive, he seems lonely. Plant more zombies to give him buddies! In the meantime, he's gonna wander around yer farm.`
- `Yer very own Zombie!`

### 6. Invade  (current: "Look at that, the carrot rubbed off on him! Now it's time to start a ZOMBIE INVASION. Tap Invade and send him into Old McDonnell's Farm.")
- `Now that you've got a zombie, it's time to start a\nZOMBIE INVASION!`   *(verbatim; ours splits it)*
- The raid's own intro (already shown on the raid card): `That darned farmer Old McDonnell has been givin ya the stink eye lately... Why don't ya show him who's boss!\n\nTap on "Invade" when yer ready to raid his barn.`

### 7. Before the fight: bubble + abilities  (current: "Here's how a fight goes. When a thought bubble pops up over yer zombie, tap it to send him out swingin'! Any special moves…")
- `He's ready for battle! Tap to send him off.`   *(the bubble's own caption)*
- `Zombies get distracted. Tap to keep them focused!`
- `Do you want to use Concentration to keep your zombies focused?`  *(only if you mention Concentration)*
- No original line about activated-ability buttons exists; that part stays ours.

### 8. After the win  (current: "Nice work, and ya earned a brain! When ya want more soil, open the tools down here and plow it up yerself.")
- `Zombies get stronger with each invasion. All zombies have been promoted to "Veteran".`   *(popup title: `Zombie Veterans`)*
- `Congratulations on conquering %@!\nYou earned %ixp for beating this enemy for the first time.`   *(title: `Enemy Conquered!`)*
- Brains: `Brains are great!\n\nNot only are they cuddly, pink and squishy, but you can trade them at the market for super cool stuff...`
- `Brains can be traded for gold too, so you can buy more stuff or plant more zombies.`

### 9. Plowing tip  (current line above)
- `Now that yer zombie is out and about, use the Plow Tool to cover up that unsightly hole he came from.\nYou can also plow it with the Multi Tool just by tapping it.\nPlowing will prepare the patch of soil for re-planting.`
- `Tap on the Multi-Tool and select the Plow Tool.`   *(the arrow label)*
- `Plowing costs no gold. Additional +1xp for planting.`  *(note: not true in this build; plowing costs gold)*

### 10. Market / buy a Daisy  (current: "Time for some shoppin'! Open the Market and grab a Daisy. It's cheap.")
No original shopping beat for decor. Nearest voice:
- `Tap on the plowed land to open the Store.`  *(an original arrow label)*
- `Looks like someone forgot to decorate this one.`  *(the original line on an undecorated farm; fits well here)*

### 11. Life Force  (current: "That's yer LIFE FORCE! It comes from decor, not zombies. The more ya have, …")
Life Force was in the original at one point; the table also contains `Life Force has been removed…` for the later build. The Life Force lines:
- `Now would be a good time to buy a tree if you dont have one. All decorative items give Life Force, but trees give the most. Life Force is important for preventing lifeless zombies and good for zombie mutations.`
- `Oh no! This %@ didn't come to life! It happens from time to time.\nTo prevent this, make sure you have enough "Life Force" by decorating yer farm a bit.\nTrees give the most Life Force.`
- `Without Life Force, what will stop my zombies from being Lifeless?`  *(help question)*

### 12. Side-button tour  (current: one line per button)
- **Zombies:** `Ya got no zombies yet.\n\nYou need at least one zombie to access the Zombie Menu.` *(the locked state)*. For the Almanac: `New mutation collection menu for you to keep record of your zombie-plant mutations. Can you unlock all 28 mutations?` and `You can find these in the Mutation section of Crops in the store.`
- **Boosts:** `When you need your zombies and crops right now. One insta grow is good for 10 crops/zombies.` and `Boosts taking too much of your storage space? Boosts are now grouped separately which gives you more room to store your stuff!`
- **Storage:** `Storage is Here!` / `Farm feeling a little cramp? Keep it nice n' tidy with storage buildings! Store away old stale items, and spice up yer farm with new stuff.` / `You can now store yer items!` / `Gosh! Yer storage is full!`
- **Market:** `The Market is where you'll be able to select stuff to plant.` / `Earn gold by farming or invading.`
- **Social:** `Welcome to the Social Menu! You can play with your friends from here.` *(the original social tutorial's first line)*
- **Guide / Help:** `Plant crops and harvest them. Winning invasions is also a great way to earn money. You can also sell zombies if you need quick cash.`

### 13. Farewell
No original text survives. Closest Tim-style closers from the social tutorial:
- `Have fun, and be sure to invite all of your friends!`
- `Yee-Haw!`  /  `Howdy Farmer!`  *(stock Tim exclamations)*

---

## Other Tim-voice lines worth mining for tone

- `Yer army of zombies is full. Time to invade!`   *(likely the original `tut1_14_extrazombies` beat)*
- `Are ya ready to send yer zombie army to invade?`
- `Looks like ya finally have enough zombies to start an invasion.\nThough you can start an invasion now, it's usually best to fight with a full army of 16 zombies. If you win, you just might get a brain from the enemy.`
- `Hold yer horses, your zombies aren't quite hungry yet.`
- `Yer very own Garden Zombie! If you're lucky, he'll fertilize your crops.`
- `Would ya like to combine two o' yer Zombies?`   *(Zombie Pot; for the later pot notice)*
- `Farm feeling a little cramp? Keep it nice n' tidy with storage buildings!`
- `Them brainless robots have been reduced to nuts and bolts! Looks like yer jobs are safe once again.\nFor now...`
- `Yee-Haw!!\n\nYou have received a %@!\n\nCheck yer storage!`
