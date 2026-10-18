# Putting this online

The site is `web/` — static files, no build step, ~17 MB (101 funds). Any free static
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

---

## Making the Synchronize button work in production

The dashboard is static, so nothing on the deployed site can run the retriever
— it takes minutes and writes thousands of files. The work therefore happens on
a GitHub Actions runner, and the button only has to *start* it.

That also fixes the throttling problem: the price feed rate-limits by IP, and a
developer machine that has been blocked stays blocked for hours. A runner gets a
fresh address every time.

```
  System page  ──POST /api/sync──▶  Vercel function  ──workflow_dispatch──▶  GitHub Actions
       ▲                              (holds the token)                          │
       │                                                                  runs the retriever,
       └──────── GET /api/sync-status ◀── run status ◀────────────────── commits web/data
                                                                                  │
                                              push to main ──▶ Vercel redeploys ──┘
```

### 1. Allow the workflow to push

GitHub → repository **Settings → Actions → General → Workflow permissions** →
**Read and write permissions** → Save. Without this the retrieval succeeds and
the commit step fails.

### 2. Create a token for the button

<https://github.com/settings/personal-access-tokens/new> — a **fine-grained**
token:

| Field | Value |
|---|---|
| Resource owner | your account |
| Repository access | **Only select repositories** → `ETF-Terminal` |
| Permissions → **Actions** | **Read and write** |
| Permissions → **Metadata** | Read-only (added automatically) |
| Expiration | your call — the button stops working when it lapses |

Copy the token once; GitHub will not show it again.

### 3. Give it to Vercel

Vercel → project → **Settings → Environment Variables**:

| Name | Value | Required |
|---|---|---|
| `GH_DISPATCH_TOKEN` | the token from step 2 | yes |
| `GH_REPO` | `MertGoker/ETF-Terminal` | only if auto-detection fails |
| `GH_REF` | branch to run on (default `main`) | no |
| `GH_WORKFLOW` | workflow file (default `sync.yml`) | no |

Add them to **Production** (and Preview if you want the button there), then
**Deployments → ⋯ → Redeploy** so the new variables are picked up.

The token never reaches the browser: the page calls your own `/api/sync`, and
the function calls GitHub.

### 4. Check it

Open the deployed site's **System** page and press **Run health check**. The
Control plane banner should read **Dispatch ready** and name the repository and
workflow. Press **Synchronize** — an *Open run on GitHub* link appears, and the
banner tracks the run to completion.

### Schedule

`.github/workflows/sync.yml` runs **weekly, Saturdays at 23:10 UTC**. That
default is deliberate: this repository is private, so Actions minutes come out
of the account quota and a full pass over ~7,800 funds is not quick. The
weekday line is one comment away in the file if the quota allows it.

### A note on repository size

Every run rewrites the data files, so the history grows by roughly the size of
whatever changed. The repository already carries ~150 MB of prices. If it
becomes unwieldy, the fix is to stop versioning the data: publish `web/data` to
object storage (Cloudflare R2, a GitHub Release asset) and have the page fetch
it from there. Nothing in the dashboard depends on the data being in git.
