# Public Search Bot Subscription Instructions

This guide explains the Google Sheet subscription flow in simple terms.

## What Controls Access

The bot uses two places:

- Google Sheet: easy admin view for payments and renewals.
- VPS database: the real memory of users, status, trials, kicks, and access.

If a user disappears from the active `Users` sheet, the bot may still remember them in the VPS database.

## Important Status Meanings

### Trial

The user can search using the free trial limit.

### Subscribe

The user has an active paid subscription and can search.

### Needs Attention

The user has 1 day remaining.

They can still search, but they should renew soon.

### Unpaid

The subscription has expired.

Important:

- The user is not immediately removed from the Telegram group.
- The user cannot use public search.
- The user appears in the subscription alert list.
- After the grace period, the bot can remove them from the Telegram group.

### Kicked

The user was removed from the Telegram group because the subscription stayed unpaid after the grace period.

When this happens:

- The user is removed from the active `Users` sheet.
- The user is added to the `History` sheet.
- The VPS database still remembers the user as `Kicked`.
- If the user tries to search again, the bot still blocks them.

So `Kicked` does not mean the bot forgot the user. It means the user is blocked until renewed.

## Can An Unpaid User Search?

No.

If the status is `Unpaid`, the public search bot should not return movies or TV series.

## Can A Kicked User Search?

No.

Even if the user is no longer visible in the active `Users` sheet, the VPS database still remembers that user as `Kicked`.

The bot will block the user until you renew them.

## How To Give A User Paid Access

Use this when a user pays for a subscription.

1. Open the Google Sheet.
2. Go to the `Users` sheet.
3. Find the user row.
4. Enter the `Start Date`.
5. Select the `Plan`.
6. Run `Subscriptions > Update Subscription`.

The bot will calculate:

- End Date
- Days Remaining
- Status
- Last Updated

Do not manually edit those calculated columns unless you know what you are doing.

## How To Renew A Kicked User

Use this when a removed user pays again.

1. Open the Google Sheet.
2. Go to the `History` sheet.
3. Find the kicked user.
4. Copy the `User ID` and `Username`.
5. Go to the `Users` sheet.
6. Add the user back as a row.
7. Fill in the new `Start Date`.
8. Select the `Plan`.
9. Run `Subscriptions > Update Subscription`.

If the new subscription is active, the bot can unban the user and allow public search again.

### Why Renew From History?

Kicked users no longer appear in the active `Users` sheet.

That is normal.

When a kicked user wants to pay again, do not look for them only in `Users`. Look for them in the `History` sheet instead.

The most important value is the `User ID`.

To renew them:

1. Copy the kicked user's `User ID` from `History`.
2. Add a new row in `Users`.
3. Paste the same `User ID`.
4. Add the username if available.
5. Enter the new `Start Date`.
6. Select the paid `Plan`.
7. Run `Subscriptions > Update Subscription`.

The bot uses the `User ID` to recognize the same person again.

Even if the user was removed from the active sheet, the VPS database still remembers them. When you add a valid paid subscription for the same `User ID`, the bot can restore access.

## What To Edit In The Users Sheet

You normally only edit:

- `Start Date`
- `Plan`

The bot should update these automatically:

- `End Date`
- `Days Remaining`
- `Status`
- `Last Updated`

## What Happens Every Day

The bot runs a daily subscription refresh.

During that refresh, it:

1. Recalculates each user's remaining days.
2. Changes expired users to `Unpaid`.
3. Sends or updates the subscription alert.
4. Queues removal for users who stayed unpaid past the grace period.
5. Refreshes the Google Sheet.

## Grace Period

The grace period is controlled by this VPS setting:

```env
SUBSCRIPTION_OVERDUE_GRACE_DAYS=1
```

Example:

- If it is `1`, a user is not kicked immediately when they become `Unpaid`.
- They must stay unpaid for at least 1 day before the bot removes them.

## Simple Rule

Use this as the main rule:

- `Subscribe` means allowed.
- `Needs Attention` means allowed but almost expired.
- `Trial` means allowed only within trial limit.
- `Unpaid` means blocked but not yet removed.
- `Kicked` means removed from group and blocked.
