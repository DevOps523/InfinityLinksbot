# Public Search Bot

Standalone VPS app for the public InfinityLinks Telegram search bot. This app runs only the public bot and sync API. The private InfinityLinks admin app stays on your local machine.

The public bot uses Telegram long polling, so you do not need to configure a Telegram webhook. The VPS only needs to expose the HTTP API used by the local admin app for catalog sync and status checks.

## Requirements

- Ubuntu or another Linux VPS with SSH access
- Node.js 22.x and npm
- Nginx or another reverse proxy
- HTTPS certificate for the public VPS domain
- A public Telegram bot token for search
- A subscription Telegram bot token for alerts and overdue removals
- The public bot and subscription bot added as admins in `@infinitylinks69`
- A Google Cloud service account JSON key with access to the subscription workbook

Deploy with Node 22.x, not Node 24. This package requires Node `>=22 <24`, and `better-sqlite3` is a native dependency.

## Environment Variables

Create `apps/public-search-bot/.env` on the VPS from `.env.example`:

```env
PUBLIC_BOT_TOKEN=replace_with_public_search_bot_token
PUBLIC_SEARCH_SYNC_TOKEN=replace_with_secret_sync_token
PUBLIC_SEARCH_STATUS_TOKEN=replace_with_read_only_status_token
PUBLIC_SEARCH_GROUP_HANDLE=@infinitylinks69
PUBLIC_SEARCH_DATABASE_PATH=./data/public-search.sqlite
PUBLIC_SEARCH_HOST=127.0.0.1
PUBLIC_SEARCH_PORT=3001
SUBSCRIPTION_BOT_TOKEN=replace_with_subscription_bot_token
SUBSCRIPTION_GROUP_CHAT_ID=-1003963665033
SUBSCRIPTION_ALERT_THREAD_ID=46
SUBSCRIPTION_ADMIN_CONTACT=@seinen_illuminatiks
SUBSCRIPTION_TRIAL_HOURS=24
SUBSCRIPTION_PERIOD_DAYS=31
SUBSCRIPTION_OVERDUE_GRACE_DAYS=1
SUBSCRIPTION_ADMIN_TOKEN=replace_with_subscription_admin_secret
GOOGLE_SHEETS_SPREADSHEET_ID=replace_with_google_sheet_id
GOOGLE_SHEETS_USERS_RANGE=Users!A:G
GOOGLE_SHEETS_HISTORY_RANGE=History!A:G
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/opt/infinitylinks-public-search-bot/google-service-account.json
```

`PUBLIC_BOT_TOKEN` is the Telegram bot token for the public search bot.
`PUBLIC_SEARCH_SYNC_TOKEN` authorizes local admin app writes to `/api/sync`.
`PUBLIC_SEARCH_STATUS_TOKEN` is read-only and is used by `/api/status`.
`PUBLIC_SEARCH_GROUP_HANDLE` is the public group/channel handle used by the admin sync metadata and subscription checks.
`SUBSCRIPTION_BOT_TOKEN` is the separate Telegram bot token used for subscription alerts and overdue removals.
`SUBSCRIPTION_ADMIN_TOKEN` authorizes `/api/subscriptions/update` and `/api/subscriptions/send-alert`.
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE` points to the Google Cloud service account JSON key on the VPS.

Use different long random values for `PUBLIC_SEARCH_SYNC_TOKEN`, `PUBLIC_SEARCH_STATUS_TOKEN`, and `SUBSCRIPTION_ADMIN_TOKEN`.

## Subscription Access

The standalone service now runs two Telegram bot tokens:

- `PUBLIC_BOT_TOKEN` handles `/start`, `/search`, and search result callbacks.
- `SUBSCRIPTION_BOT_TOKEN` posts subscription alerts and removes overdue users from the group.

Public search access is backed by the standalone SQLite subscription database. A user's first search starts a 1-day trial. Paid access lasts 31 days from the current subscription start date. Users whose subscription is expired, unpaid, kicked, or otherwise inactive are blocked from download links.

Create a Google Sheets workbook with these tabs and headers:

```text
Users: User ID | Username | Start Date | End Date | Days Remaining | Status | Last Updated
History: User ID | Username | Last Status | Kicked At | Last Start Date | Last End Date | Notes
```

The `Users` tab is the current operating view. The `History` tab records previous status and kick activity so operators can audit what changed. Share the workbook with the Google Cloud service account email from the JSON key, then copy that JSON key to the VPS path configured in `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`.

Copy `apps/public-search-bot/google-apps-script/Code.gs` into the workbook's Apps Script project. In Apps Script, set Script Properties:

```text
SUBSCRIPTION_API_BASE_URL=https://your-vps.example.com
SUBSCRIPTION_ADMIN_TOKEN=same value as VPS SUBSCRIPTION_ADMIN_TOKEN
```

Reload the spreadsheet. The `Subscriptions` menu will include `Update Subscription` and `Send Alert`:

- `Update Subscription` POSTs to `/api/subscriptions/update`, synchronizing the sheet and subscription database.
- `Send Alert` POSTs to `/api/subscriptions/send-alert`, refreshing the alert message in the configured Telegram topic.

Operational notes:

- Keep the public search bot token and subscription bot token separate. Both bots need the Telegram permissions required for their jobs in `@infinitylinks69`.
- Run `Update Subscription` after manually changing subscription rows so the VPS database is refreshed from the sheet.
- Use `Send Alert` after updates when you want the alert topic to reflect current subscription state immediately.
- The default trial is 1 day, the default paid period is 31 days, and overdue users have a 1-day grace period before removal jobs are queued.
- Overdue kicks are performed by the subscription bot from persisted jobs with retry/backoff. Check systemd logs before manually intervening.

## Step By Step VPS Deployment

These steps assume the VPS path is `/opt/infinitylinks-public-search-bot`, the app listens on `127.0.0.1:3001`, and Nginx exposes it through `https://your-vps.example.com`.

### 1. Prepare Telegram Bots And Group Permissions

Create or confirm these two Telegram bots in BotFather:

```text
Public search bot: handles /start, /search, and result buttons
Subscription bot: handles alerts, bans overdue users, and unbans paid users
```

Add both bots to the private group. The subscription bot must be an admin with permission to ban users. The public search bot needs to read/respond to user messages where it will receive `/search`.

Record these values before continuing:

```text
PUBLIC_BOT_TOKEN
SUBSCRIPTION_BOT_TOKEN
SUBSCRIPTION_GROUP_CHAT_ID
SUBSCRIPTION_ALERT_THREAD_ID
SUBSCRIPTION_ADMIN_CONTACT
```

For the current setup, the alert topic is configured as:

```text
SUBSCRIPTION_GROUP_CHAT_ID=-1003963665033
SUBSCRIPTION_ALERT_THREAD_ID=46
```

### 2. Prepare The Google Sheet

Create a Google Sheet with these exact tabs and headers:

```text
Users: User ID | Username | Start Date | End Date | Days Remaining | Status | Last Updated
History: User ID | Username | Last Status | Kicked At | Last Start Date | Last End Date | Notes
```

Copy the spreadsheet ID from the sheet URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

Keep that value for `GOOGLE_SHEETS_SPREADSHEET_ID`.

### 3. Create The Google Service Account JSON

In Google Cloud:

1. Create or open the project used for this bot.
2. Enable the Google Sheets API.
3. Create a service account.
4. Create a JSON key for that service account.
5. Download the JSON file.

Open the JSON file and copy the `client_email` value. Share the Google Sheet with that service account email as an editor.

On the VPS, place the JSON key here:

```text
/opt/infinitylinks-public-search-bot/google-service-account.json
```

The `.env` value must point to that same file:

```env
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/opt/infinitylinks-public-search-bot/google-service-account.json
```

Do not commit this JSON file. It is a secret.

### 4. Upload The Public Bot App To The VPS

Deploy only this folder from the full InfinityLinks repo:

```text
apps/public-search-bot/
```

Example from your PC:

```bash
rsync -av --delete \
  --include '.env.example' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'google-service-account.json' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude 'node_modules/' \
  apps/public-search-bot/ root@your-vps-ip:/opt/infinitylinks-public-search-bot/
```

Create the production `.env` and Google service account JSON directly on the VPS; do not copy local secrets or local databases.

Or upload the folder with SFTP. On the VPS, the folder should contain:

```text
/opt/infinitylinks-public-search-bot/
  package.json
  package-lock.json
  .env.example
  src/
  deploy/
  google-apps-script/
```

The VPS does not need the root admin app.

### 5. Install Node.js 22, Nginx, And Build Tools

Use Node 22.x, not Node 24. This app uses `better-sqlite3`, which is native and must match the Node version.

On Ubuntu:

```bash
sudo apt update
sudo apt install -y nginx build-essential python3
```

Install Node 22 using NodeSource, nvm, or your preferred provider. Then verify:

```bash
node -v
npm -v
```

Expected:

```text
node v22.x.x
```

If you previously installed dependencies with a different Node version, reinstall them after switching back to Node 22.

### 6. Install App Dependencies

```bash
cd /opt/infinitylinks-public-search-bot
npm ci
```

If `better-sqlite3` complains about a wrong `NODE_MODULE_VERSION`, remove `node_modules` and reinstall with Node 22:

```bash
rm -rf node_modules
npm ci
```

Prefer `npm ci` when `package-lock.json` is already correct.

### 7. Create The VPS `.env`

```bash
cd /opt/infinitylinks-public-search-bot
cp .env.example .env
nano .env
```

Fill in every value:

```env
PUBLIC_BOT_TOKEN=replace_with_public_search_bot_token
PUBLIC_SEARCH_SYNC_TOKEN=replace_with_long_random_sync_secret
PUBLIC_SEARCH_STATUS_TOKEN=replace_with_long_random_status_secret
PUBLIC_SEARCH_GROUP_HANDLE=@infinitylinks69
PUBLIC_SEARCH_DATABASE_PATH=./data/public-search.sqlite
PUBLIC_SEARCH_HOST=127.0.0.1
PUBLIC_SEARCH_PORT=3001
SUBSCRIPTION_BOT_TOKEN=replace_with_subscription_bot_token
SUBSCRIPTION_GROUP_CHAT_ID=-1003963665033
SUBSCRIPTION_ALERT_THREAD_ID=46
SUBSCRIPTION_ADMIN_CONTACT=@seinen_illuminatiks
SUBSCRIPTION_TRIAL_HOURS=24
SUBSCRIPTION_PERIOD_DAYS=31
SUBSCRIPTION_OVERDUE_GRACE_DAYS=1
SUBSCRIPTION_ADMIN_TOKEN=replace_with_long_random_subscription_secret
GOOGLE_SHEETS_SPREADSHEET_ID=replace_with_google_sheet_id
GOOGLE_SHEETS_USERS_RANGE=Users!A:G
GOOGLE_SHEETS_HISTORY_RANGE=History!A:G
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/opt/infinitylinks-public-search-bot/google-service-account.json
```

Rules:

- Keep `PUBLIC_SEARCH_HOST=127.0.0.1`; Nginx is the public entry point.
- Use different secrets for `PUBLIC_SEARCH_SYNC_TOKEN`, `PUBLIC_SEARCH_STATUS_TOKEN`, and `SUBSCRIPTION_ADMIN_TOKEN`.
- `SUBSCRIPTION_ADMIN_TOKEN` must also be saved in Apps Script later.

### 8. Set File Permissions

Create the database folder and make it writable by the service user:

```bash
sudo install -d -o www-data -g www-data /opt/infinitylinks-public-search-bot/data
sudo chown -R www-data:www-data /opt/infinitylinks-public-search-bot/data
```

Protect secrets:

```bash
sudo chown root:www-data /opt/infinitylinks-public-search-bot/.env
sudo chmod 640 /opt/infinitylinks-public-search-bot/.env
sudo chown root:www-data /opt/infinitylinks-public-search-bot/google-service-account.json
sudo chmod 640 /opt/infinitylinks-public-search-bot/google-service-account.json
```

### 9. Build And Migrate The Database

```bash
cd /opt/infinitylinks-public-search-bot
set -a; . ./.env; set +a
npm run build
npm run db:migrate
sudo chown -R www-data:www-data /opt/infinitylinks-public-search-bot/data
```

The migration creates or updates:

```text
data/public-search.sqlite
```

### 10. Test The App Manually

Start the app in the SSH terminal:

```bash
cd /opt/infinitylinks-public-search-bot
npm start
```

Expected startup log:

```text
Public search sync API listening on http://127.0.0.1:3001
```

Open a second SSH terminal and test status:

```bash
cd /opt/infinitylinks-public-search-bot
set -a; . ./.env; set +a
curl -H "Authorization: Bearer $PUBLIC_SEARCH_STATUS_TOKEN" http://127.0.0.1:3001/api/status
```

Stop the manual app with `Ctrl+C` before setting up systemd.

### 11. Install The systemd Service

```bash
sudo cp /opt/infinitylinks-public-search-bot/deploy/public-search-bot.service.example /etc/systemd/system/public-search-bot.service
sudo nano /etc/systemd/system/public-search-bot.service
```

Confirm these values:

```ini
WorkingDirectory=/opt/infinitylinks-public-search-bot
EnvironmentFile=/opt/infinitylinks-public-search-bot/.env
ExecStart=/usr/bin/npm start
User=www-data
Group=www-data
```

The example service uses `ProtectSystem=strict`, so only the SQLite data directory is writable by the app. If you place the database somewhere else, update `ReadWritePaths` to match.

If `npm` is not at `/usr/bin/npm`, find it:

```bash
which npm
```

Then update `ExecStart` with the correct path.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable public-search-bot
sudo systemctl start public-search-bot
sudo systemctl status public-search-bot
```

Logs:

```bash
sudo journalctl -u public-search-bot -n 100 --no-pager
sudo journalctl -u public-search-bot -f
```

### 12. Configure Nginx And HTTPS

Copy the example config:

```bash
sudo cp /opt/infinitylinks-public-search-bot/deploy/nginx.conf.example /etc/nginx/sites-available/public-search-bot
sudo nano /etc/nginx/sites-available/public-search-bot
```

Replace every `your-vps.example.com` with your real domain. Keep this proxy target:

```nginx
proxy_pass http://127.0.0.1:3001;
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/public-search-bot /etc/nginx/sites-enabled/public-search-bot
sudo nginx -t
sudo systemctl reload nginx
```

Install HTTPS with Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-vps.example.com
```

Do not expose `/api/sync` or `/api/subscriptions/update` over plain HTTP. They use bearer tokens.

### 13. Test The Public VPS API

From the VPS:

```bash
cd /opt/infinitylinks-public-search-bot
set -a; . ./.env; set +a
curl -H "Authorization: Bearer $PUBLIC_SEARCH_STATUS_TOKEN" http://127.0.0.1:3001/api/status
```

From your PC:

```bash
curl -H "Authorization: Bearer replace_with_status_token" https://your-vps.example.com/api/status
```

Expected: JSON with bot status. If this works, the local admin app and Google Apps Script can reach the VPS.

### 14. Configure Google Apps Script

Open the Google Sheet, then open `Extensions > Apps Script`.

Copy this file into Apps Script:

```text
apps/public-search-bot/google-apps-script/Code.gs
```

In Apps Script, open `Project Settings > Script Properties` and add:

```text
SUBSCRIPTION_API_BASE_URL=https://your-vps.example.com
SUBSCRIPTION_ADMIN_TOKEN=same value as VPS SUBSCRIPTION_ADMIN_TOKEN
```

Save, reload the spreadsheet, then check for the `Subscriptions` menu.

Use:

- `Subscriptions > Update Subscription` after you add or change a user's `Start Date`.
- `Subscriptions > Send Alert` when you want the alert topic updated immediately.

The bot also refreshes the sheet after trial/search activity through queued jobs, so accidental deleted user rows should be restored from the database on refresh.

### 15. Configure The Local Admin App On Your PC

In the root InfinityLinks `.env` on your PC, set:

```env
PUBLIC_SEARCH_SYNC_URL=https://your-vps.example.com/api/sync
PUBLIC_SEARCH_SYNC_TOKEN=replace_with_the_same_sync_token_from_the_vps
PUBLIC_SEARCH_STATUS_URL=https://your-vps.example.com/api/status
PUBLIC_SEARCH_STATUS_TOKEN=replace_with_the_same_status_token_from_the_vps
PUBLIC_SEARCH_GROUP_HANDLE=@infinitylinks69
```

The local admin app stays on your PC. It only pushes the public catalog and checks bot status.

### 16. Sync The Public Catalog

On your PC:

1. Start the local InfinityLinks admin app.
2. Open `Public Search`.
3. Click `Sync Public Search`.
4. Confirm the sync succeeds.
5. Click `Check Bot Status`.

The VPS database starts empty. The public bot will not return movie or TV results until this sync succeeds.

### 17. Test In Telegram

1. Open the public search bot.
2. Send `/start`.
3. Send `/search <movie or tv show name>`.
4. Confirm a new trial user appears in the `Users` sheet after the delayed refresh job.
5. Add a `Start Date` for a paid user in the sheet.
6. Run `Subscriptions > Update Subscription`.
7. Confirm `End Date`, `Days Remaining`, and `Status` are recalculated by the bot and written back to the sheet.

Expected subscription behavior:

- First search starts a 1-day trial.
- Paid access is 31 days from `Start Date`.
- At 1 day remaining, status becomes `Needs Attention`.
- At 0 days remaining, status becomes `Unpaid`.
- After the grace period, the subscription bot bans the unpaid user from the group.
- If a banned user pays, update `Start Date` and run `Update Subscription`; the bot unbans them and refreshes the sheet.

## Updating The VPS Bot Later

When code changes are ready:

```bash
cd /opt/infinitylinks-public-search-bot
sudo systemctl stop public-search-bot
# upload or replace the app files with the new apps/public-search-bot contents
npm ci
set -a; . ./.env; set +a
npm run build
npm run db:migrate
sudo chown -R www-data:www-data /opt/infinitylinks-public-search-bot/data
sudo systemctl start public-search-bot
sudo journalctl -u public-search-bot -n 100 --no-pager
```

After restarting, run a public status check and sync the catalog again from the local admin app if catalog behavior changed.

## Useful Commands

```bash
cd /opt/infinitylinks-public-search-bot
npm run build
npm run db:migrate
npm start
npm test
sudo systemctl status public-search-bot
sudo journalctl -u public-search-bot -f
```

## Troubleshooting

If `npm ci` or `npm start` fails with `better-sqlite3` native binding errors, confirm the VPS is using Node 22.x, then reinstall dependencies with the same Node version.

If the service starts but Telegram commands do not respond, check:

```bash
sudo journalctl -u public-search-bot -n 100 --no-pager
```

If `/api/status` returns unauthorized, confirm the bearer token matches `PUBLIC_SEARCH_STATUS_TOKEN`.

If `Sync Public Search` fails from the local admin app, confirm:

- `PUBLIC_SEARCH_SYNC_URL` points to `https://your-vps.example.com/api/sync`
- the local sync token matches the VPS `PUBLIC_SEARCH_SYNC_TOKEN`
- Nginx is forwarding to `127.0.0.1:3001`
- `sudo systemctl status public-search-bot` shows the service running

If `Update Subscription` fails from Google Sheets, confirm:

- `SUBSCRIPTION_API_BASE_URL` has the public HTTPS VPS URL, not `localhost`
- `SUBSCRIPTION_ADMIN_TOKEN` matches the VPS `.env`
- `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` exists on the VPS
- the Google Sheet is shared with the service account `client_email`
- the `Users` and `History` headers match exactly

If users are always blocked from search, confirm:

- The public bot is receiving `/search`.
- The subscription database exists at `PUBLIC_SEARCH_DATABASE_PATH`.
- The user has an active trial or paid subscription row.
- The systemd logs do not show Google Sheets or Telegram API errors.
