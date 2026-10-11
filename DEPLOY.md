# Putting this online

The site is `web/` — static files, no build step, ~2.6 MB. Any free static
host serves it as-is.

Pick **one** of the routes below. Route A is the easiest if you already use
GitHub Desktop; Route B is the fastest if you are comfortable in a terminal.

---

## Route A — GitHub Desktop → Vercel (recommended)

No access tokens, and every future push redeploys the site automatically.

### 1. Publish the repository

The repository at `~/Documents/etf-terminal` is already initialised and
committed, so there is nothing to commit — you only need to publish it.

1. Open **GitHub Desktop** → *File* → **Add Local Repository…**
2. Choose `~/Documents/etf-terminal` → *Add Repository*.
   It should show **No local changes** — that is correct, the work is already
   committed on the `main` branch.
3. Click **Publish repository** in the top bar.
   - Name: `etf-terminal`
   - *Keep this code private* — your choice. Vercel deploys fine from a private
     repository; untick it only if your class wants to read the source.
4. *Publish Repository*.

### 2. Import it into Vercel

1. Go to <https://vercel.com> and **Sign up / Log in with GitHub**.
2. **Add New…** → **Project**.
3. Find `etf-terminal` and click **Import**. If it is not listed, click
   *Adjust GitHub App Permissions* and grant Vercel access to that repository.
4. **Leave every setting at its default and click Deploy.** There is no build
   step, and the committed `vercel.json` already tells Vercel to serve the
   `web/` folder.
5. After about a minute you get a URL like
   `https://etf-terminal.vercel.app`. That is your submission link.

> **If the deployed page 404s**, the output directory was not picked up: in
> Vercel go to *Settings → Build and Deployment → Root Directory*, set it to
> `web`, save, then *Deployments → ⋯ → Redeploy*.

### 3. Updating it later

Re-run the retriever, then in GitHub Desktop commit the changed files and press
**Push origin**. Vercel rebuilds and republishes on its own — no further steps.

---

## Route B — Vercel CLI (~2 minutes)

```bash
cd ~/Documents/etf-terminal/web
npx vercel --prod
```

The first run walks you through it:

| Prompt | Answer |
|---|---|
| `Log in to Vercel` | pick **Continue with GitHub** (or Email) and finish in the browser |
| `Set up and deploy "~/Documents/etf-terminal/web"?` | **Y** |
| `Which scope...?` | your own account |
| `Link to existing project?` | **N** |
| `What's your project's name?` | `etf-terminal` |
| `In which directory is your code located?` | `./` |
| `Want to modify these settings?` | **N** — there is no build step |

It prints a **Production** URL like `https://etf-terminal.vercel.app`. That is
the link you submit.

To redeploy after changing data or code, run the same command again.

> Deploying from inside `web/` means Vercel treats it as the site root, which
> needs no configuration at all. If you prefer to deploy from the project root,
> run `npx vercel --prod` there instead — `vercel.json` already sets
> `outputDirectory` to `web`.

---

## Route C — Netlify Drop (no terminal at all)

1. Open <https://app.netlify.com/drop>
2. Drag the **`web`** folder — `~/Documents/etf-terminal/web` — onto the page.
3. You get a URL immediately, e.g. `https://random-name-123.netlify.app`.
4. Sign in (free) to claim the site so it stays up, and rename it under
   *Site configuration → Change site name*.

Drag the folder itself, not the files inside it, and not the project root.

---

## Route D — GitHub Pages (if you want GitHub to host it too)

The repository is already committed, so this publishes both the code and the
site.

**1. Create an empty repository** at <https://github.com/new> — name it
`etf-terminal`, **Public**, and do **not** add a README, .gitignore or licence.

**2. Connect and push** (replace `YOUR-USERNAME`):

```bash
cd ~/Documents/etf-terminal
git remote add origin https://github.com/YOUR-USERNAME/etf-terminal.git
git branch -M main
git push -u origin main
```

GitHub will ask for a username and password. The password is **not** your
account password — create a token at
<https://github.com/settings/tokens> → *Generate new token (classic)* → tick
**repo** → copy it and paste it as the password.

**3. Publish `web/` as the site root:**

```bash
git subtree push --prefix web origin gh-pages
```

**4. Turn Pages on:** repository → *Settings* → *Pages* → under *Build and
deployment*, Source = **Deploy from a branch**, Branch = **gh-pages**, folder
**/ (root)** → *Save*.

After a minute or two the site is at:

```
https://YOUR-USERNAME.github.io/etf-terminal/
```

To update it later: commit your changes, `git push`, then run the
`git subtree push` line again.

---

## After deploying — check these three things

1. **Open the URL in a private/incognito window.** If it loads there, it is
   genuinely public.
2. **Click a Turkish fund** (e.g. ZPX30). This confirms the `data/tr/*.json`
   files uploaded, not just the page.
3. **Press "Download Excel (.xlsx)".** On a real host this is an ordinary
   browser download. Open the file — it should have *Prices* and *Summary*
   sheets.

---

## Troubleshooting

**Page loads but says "Market data not found"** — the `data/` folder did not
upload. On Vercel, make sure you ran the command from inside `web/`. On
Netlify, make sure you dragged the `web` folder itself.

**Chart area is blank** — the chart library is loaded from jsDelivr; check the
browser console for a blocked request, and make sure you are on `https`.

**Turkish fund shows "No data"** — that fund's JSON is missing from
`web/data/tr/`. Re-run the retriever for it:
`python3 retriever/fetch_etfs.py --only ZPX30`

**`npx vercel` says command not found** — install Node.js from
<https://nodejs.org>, reopen the terminal, and try again.
