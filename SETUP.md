# Minecraft Builder Crew — 5 Bots (names: 1, 2, 3, 4, 5)

Five Minecraft bots that stay together as a group and continuously build a **modern city, park, and fun rides** (ferris wheel, roller coaster, fountain, bridge, skyscrapers, houses, roads) on your server. One bot (bot `1`, the "foreman") plans and assigns work; the other four build alongside it. If bot `1` disconnects, the next alive bot automatically takes over.

Dashboard (web panel) shows each bot's status, coordinates, current task, blocks placed, and build progress.

---

## ⚠️ IMPORTANT — about the single-digit bot names

The bots are named **`1`, `2`, `3`, `4`, `5`** (single digits, no "Worker" prefix), as requested.

**Caveat:** Minecraft Java Edition usernames are normally **3–16 characters**. A single-character name is accepted by many servers, but **some servers kick it with an error like "Illegal name" / "Invalid name" / "Bad login"**. If any bot gets kicked for that reason, the fix is a one-line change: open `settings.json` and edit the `bots` usernames to 3+ characters, for example:

```json
"bots": [ {"username":"Bot1"}, {"username":"Bot2"}, {"username":"Bot3"}, {"username":"Bot4"}, {"username":"Bot5"} ]
```
or `W_1` … `W_5`. Usernames may contain only letters, numbers, and `_` (max 16 chars, **no spaces**). Then restart.

---

## 1. What you need

- Node.js 18 or newer (works on Replit / Render / any free Node host, and on your own PC).
- A Minecraft Java Edition server (your Aternos server is already pre-filled).
- **The 5 bot accounts must be in Creative mode (or OP)** — without blocks in survival, they cannot build. See step 4.

---

## 2. Install

```bash
npm install
npm start
```

Then open the dashboard at `http://localhost:5000` (or your Replit/Render web URL). Use the **Start Crew** / **Stop Crew** buttons. Bots connect one-by-one (6 seconds apart) so the server doesn't kick them for joining too fast.

---

## 3. Configure `settings.json` (already pre-filled for your Aternos server)

```json
{
  "server": { "host": "ENDERLORD121.aternos.me", "port": 47235, "version": "" },
  "auth": { "enabled": false, "registerPassword": "", "loginPassword": "" },
  "bots": [ {"username":"1"}, {"username":"2"}, {"username":"3"}, {"username":"4"}, {"username":"5"} ],
  "build": { "enabled": true, "origin": {"x":0,"y":100,"z":0}, "plotSize": 40, "allowCreativeCommands": false, ... },
  "ai": { "enabled": false, "provider": "gemini", "apiKey": "", "model": "gemini-2.5-flash" },
  "dashboard": { "port": 5000 }
}
```

- **`server.version`**: leave `""` (empty) = auto-detect. If bots fail to join with a version error, set your server's exact version, e.g. `"1.20.1"` or `"1.21.4"`.
- **`auth`**: default OFF. Only set `"enabled": true` and fill the passwords **if** your Aternos server uses an auth plugin (AuthMe / LoginSecurity / nLogin). A normal vanilla Aternos server does NOT need it — leaving it off prevents the bots from spamming `/register` `/login` in chat.
- **`bots`**: usernames `1`…`5`. See the ⚠️ caveat above about single-character names.
- **`build.origin`**: **IMPORTANT** — set `x, y, z` to the spot where you want the city to start (ground level). Stand there in-game and press F3 to see your coordinates. `y` should be the ground height.
- **`build.allowCreativeCommands`**: set `true` **only if** the bots have OP (`/op 1` etc.) — they will then run `/gamemode creative` automatically. Otherwise give them Creative manually (see step 4) and leave this `false`.

---

## 4. CRITICAL — do this on your server first (otherwise nothing builds)

1. **Start your Aternos server from the Aternos panel.** Free Aternos servers sleep when empty — the bots will keep reconnecting automatically while it's offline, but they can only build once it is online. The Express self-ping cannot wake an Aternos server.
2. **Give the 5 bots Creative mode** (required to place any block). Do ONE of:
   - Easiest: in console run `/op 1`, `/op 2`, … `/op 5`, then set `"allowCreativeCommands": true` in settings.json. Bots will switch themselves to Creative.
   - Or, after they join, run `/gamemode creative 1` … `/gamemode creative 5`.
   - Survival without blocks = bots will log "missing block" and skip. They will NOT mine blocks (out of scope).
3. If your server has a **whitelist**, add `1`…`5`.
4. If you see a kick like *"too many connections from this IP"*, raise `max-connections-per-ip` (or equivalent) in your server settings. The bots already stagger their joins by 6 seconds.

---

## 5. Optional — AI (Gemini / OpenAI)

Without an API key the bots still work perfectly: they cycle through all blueprints on a grid (round-robin). With a key, the AI only (a) chooses *which* structure to build next and *where*, and (b) replies in chat when a player talks to them.

Set in `settings.json`:
```json
"ai": { "enabled": true, "provider": "gemini", "apiKey": "PASTE_YOUR_KEY_HERE", "model": "gemini-2.5-flash" }
```
- Gemini key: get from https://aistudio.google.com/ (free tier available). `gemini-2.5-flash` is the recommended stable model.
- Or use OpenAI: `"provider": "openai"` with an OpenAI key.
- If the AI call fails for any reason, the bots silently fall back to round-robin grid building — building never stops.

---

## 6. How building works (and resuming)

- The foreman picks a blueprint (modern house, skyscraper, road grid, park, ferris wheel, roller coaster, bridge, fountain, apartment block, lamp posts, benches), places it on a grid, and splits its blocks into slices — one slice per alive worker.
- Each worker walks near its target, takes the right block (Creative: sets its own hotbar; Survival: uses whatever is in inventory), and places blocks from the bottom up. Already-built blocks are skipped.
- Progress is saved in `build_state.json` (auto-created, gitignored). If you restart, the crew resumes instead of rebuilding over existing blocks.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| Bot kicked for "Illegal name" / "Invalid name" | Single-digit name rejected — rename in `settings.json` to 3+ chars like `Bot1`…`Bot5` (see ⚠️ above). |
| Bots join but place nothing | They are not in Creative / have no blocks. See step 4. |
| Bots can't join / version error | Set exact `server.version` in settings.json. |
| Bots spam /register in chat | Your server has no auth plugin — keep `auth.enabled: false`. |
| Kicked for too many connections | Raise max-connections-per-IP on the server. |
| City builds in wrong place | Change `build.origin` to your desired coordinates (F3 in-game). |
| Dashboard not reachable | Open port 5000 (or your host's assigned port); check logs at `/logs`. |

---

# বাংলা সারাংশ (Bengali Summary)

**কী বানাবে:** ৫টা বট (নাম: `১`, `২`, `৩`, `৪`, `৫` — অর্থাৎ `1` থেকে `5`) একসাথে গ্রুপে থাকবে এবং আপনার সার্ভারে ধারাবাহিকভাবে আধুনিক শহর, পার্ক, ফেরিস হুইল, রোলার কোস্টার, ফোয়ারা, স্কাইস্ক্রেপার, রাস্তা ইত্যাদি বানাবে। বট `1` হলো foreman (প্রধান) — কাজ বান্টে দেয়; বাকি ৪জন সাথে সাথে বানায়। বট `1` disconnect হলে পরের বটটা নিজে প্রধান হয়ে যাবে।

**⚠️ নাম সমস্যার কথা:** Minecraft-এ সাধারণত username ৩–১৬ অক্ষরের হয়। এক অক্ষরের নাম (`1`, `2` ইত্যাদি) অনেক সার্ভারে চললেও কিছু সার্ভার "Illegal name"/"Invalid name" দিয়ে kick করে দিতে পারে। তাহলে শুধু `settings.json`-এ গিয়ে নাম বদলে দিন `Bot1`…`Bot5` বা `W_1`…`W_5` (৩+ অক্ষর, স্পেস নেই)।

**চালানোর নিয়ম:**
1. `npm install` তারপর `npm start`। ড্যাশবোর্ড খুলবে `http://localhost:5000`-এ — ওখান থেকে Start/Stop Crew চাপুন। বটগুলো ৬ সেকেন্ড পরপর join করবে।
2. **আগে আপনার Aternos সার্ভারটা Aternos প্যানেল থেকে চালু করুন** — free Aternos server নিজে ঘুমিয়ে পড়ে; বটগুলো offline থাকলে নিজে নিজে আবার connect করার চেষ্টা করবে, কিন্তু সার্ভার অনলাইন না হলে বানাতে পারবে না।
3. **৫টা বটকে অবশ্যই Creative mode দিন** (নাহলে ব্লক পাবে না, কিছুই বানাবে না): সবচেয়ে সহজ — console-এ `/op 1` … `/op 5` দিন, তারপর settings.json-এ `"allowCreativeCommands": true` করুন। অথবা বট join করার পর `/gamemode creative 1` … দিন।
4. `settings.json`-এ আপনার Aternos server আগে থেকেই ভরা আছে (`ENDERLORD121.aternos.me:47235`)। `server.version` খালি রাখলে auto-detect হবে; সমস্যা হলে ঠিক version লিখুন।
5. **`build.origin`**-এ `x,y,z` দিন যেখান থেকে শহরটা বানানো শুরু হবে (গেমে F3 চাপলে coordinate দেখা যায়)।
6. Auth (`/register` `/login`) ডিফল্টে বন্ধ আছে — AuthMe/LoginSecurity প্লাগিন থাকলেই `auth.enabled: true` করুন।
7. (ঐচ্ছিক) Gemini/OpenAI API key দিলে AI ভবিষ্যতের কাঠামো ও জায়গা বেছে দেবে এবং চ্যাটে reply করবে; key না দিলেও বটগুলো নিজে থেকেই সব কিছু বানাতে থাকবে।

কোনো সমস্যা হলে উপরের Troubleshooting টেবিল দেখুন, অথবা dashboard-এ `/logs` দেখুন।
