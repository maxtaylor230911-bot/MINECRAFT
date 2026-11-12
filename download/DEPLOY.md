# Deploy Voxelcraft to Vercel — Step-by-Step

Put the game on your own free URL (like `voxelcraft-yourname.vercel.app`),
playable on any iPad, iPhone, or computer. No z.ai involved.

---

## What you need

- A computer (any browser) — you only do this setup ONCE
- ~15 minutes
- Nothing to install: everything happens in the browser

---

## Step 1 — Unzip this package

Extract `voxelcraft-deploy.zip` somewhere you can find, e.g. your Desktop.
You should see a folder `voxelcraft` containing `src`, `public`,
`package.json` and more.

> Important: do NOT delete anything inside, and don't rename files.

## Step 2 — Create a GitHub account (skip if you have one)

1. Go to **https://github.com** → **Sign up**
2. Verify your email.

## Step 3 — Create a repository and upload the game

1. Go to **https://github.com/new**
2. Repository name: `voxelcraft` (or anything you like)
3. Keep it **Public** (required for free Vercel hosting)
4. Click **Create repository**
5. On the next page, click the link **"uploading an existing file"**
6. Open your extracted `voxelcraft` folder, select **EVERYTHING INSIDE it**
   (all files and folders — but not the folder itself) and drag it into the
   browser drop zone.
   - Watch that sub-folders like `src/app` appear with arrows in the file
     list — that means folder structure was preserved.
   - The upload may take a minute or two.
7. Click **Commit changes** and wait for the upload to finish.

## Step 4 — Deploy on Vercel

1. Go to **https://vercel.com** → **Sign Up** → choose **Continue with GitHub**
   (this connects the two accounts).
2. Click **Add New... → Project**
3. Find your `voxelcraft` repository in the list → click **Import**
4. Change nothing — Vercel auto-detects Next.js. Just click **Deploy**.
5. Wait ~2 minutes. You'll get a 🎉 screen with your URL, e.g.
   `voxelcraft-abc123.vercel.app`

**That URL is your game. It works forever, free.**

## Step 5 — Play on your iPad

1. Open the URL in **Safari** on the iPad
2. Tap **Share** → **Add to Home Screen** → Add
3. Launch it from the Home Screen — fullscreen, like a native app
4. In-game: Singleplayer → Create New World. Worlds save on the device.
5. Tip: for the smoothest framerate, set Options → Video Settings →
   Render Distance to 4–8 chunks.

---

## Updating the game later

- Go to your repo on github.com, open any file, click the pencil icon to
  edit and commit — Vercel redeploys automatically.
- Or upload replaced files the same way as in Step 3.

## Custom name (optional)

In Vercel: Project → Settings → Domains → you can rename to
`voxelcraft-yourname.vercel.app` (if free) — or buy a real domain.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| GitHub upload loses folders | Don't drag a zip; drag the actual extracted folders (use Chrome/Edge on a computer) |
| Vercel build fails | Make sure `package.json`, `next.config.ts` and the whole `src/` folder were uploaded (check them on github.com) |
| Game won't open on iPad | Use Safari (not Chrome), iOS 16+; WebGL must be enabled (default on) |
| Works but laggy | Lower Render Distance, set Graphics to Fast, Clouds Off |
