# Getting Started with Finora

This guide walks you through installing Finora, bringing in your financial data,
and finding your way around the app. There's no Finora account to sign up for,
and your data stays on your own computer.

---

## 1. Install Finora

Download the version for your computer:

| Your computer | Download |
| --- | --- |
| 🍎 macOS (Apple Silicon — M1/M2/M3/M4) | [Download for Mac](https://github.com/liar1974/finora/releases/latest/download/Finora-macOS-AppleSilicon.dmg) |
| 🍎 macOS (Intel) | [Download for Mac (Intel)](https://github.com/liar1974/finora/releases/latest/download/Finora-macOS-Intel.dmg) |
| 🪟 Windows | [Download for Windows](https://github.com/liar1974/finora/releases/latest/download/Finora-Windows-Setup.exe) |
| 🐧 Linux | [Download for Linux](https://github.com/liar1974/finora/releases/latest/download/Finora-Linux-x86_64.AppImage) |

Then open the downloaded file and follow the prompts:

- **macOS:** open the `.dmg` and drag **Finora** into your Applications folder.
- **Windows:** run the installer and click through it.
- **Linux:** make the `.AppImage` file executable, then double-click it.

### Let the app run the first time

These builds aren't signed with a paid developer certificate yet, so your system
blocks them on the first launch. This is expected — here's how to allow it:

- **macOS (important):** the first time you open Finora you'll likely see a
  message that it "cannot be opened." To allow it:
  1. Try to open Finora once (double-click it) and dismiss the warning.
  2. Open  → **System Settings → Privacy & Security**.
  3. Scroll down to the **Security** section. You'll see a line about Finora
     being blocked — click **Open Anyway**.
  4. Confirm with **Open** (and your password/Touch ID if asked).

  Without this step macOS will not let Finora run. You only need to do it once.

- **Windows:** if a blue **SmartScreen** box appears, click **More info → Run
  anyway**.

## 2. First launch

When Finora opens, you're ready to go — there's no account to create. The menu
down the left side is how you move around the app: **Insights**, **Banking**,
**Brokerage**, **Credit**, **Dashboards**, and **Settings**.

At the start these will be mostly empty, because Finora doesn't have any of your
information yet. The next step fixes that.

## 3. Bring in your data

Each type of data comes into Finora a different way: **banks and brokerages
connect through Plaid**, and **credit reports are added as a PDF**. Do only the
ones you care about — none are required.

### Connect a bank account (through Plaid)

Finora connects to banks through **Plaid**, the same secure service many finance
apps use to link accounts. There's a quick one-time setup the first time.

**One-time setup — add your Plaid keys**

1. Create a free account at the **Plaid Dashboard**
   (<https://dashboard.plaid.com>) and sign in.
2. Open **Team Settings → Keys** and copy your **Client ID** and a **Secret**.
   Use the **Sandbox** secret while you're testing.
3. In Finora, open **Settings → Bank/Brokerage**, paste the **Client ID** and
   **Secret**, and click **Save**. (Finora shows the same steps on that screen.)

![Adding your Plaid keys in Settings → Bank/Brokerage](media/screenshots/plaid-keys.png)

> **Heads up — Plaid's free tier is limited.** The free plan allows a running
> total of **10 connected financial institutions** across the life of your Plaid
> account; once you've used them up, adding more requires a paid Plaid plan. So
> connect the accounts that matter most and use them wisely. Check your current
> usage and the exact limits in your **Plaid Dashboard**.

**Connect the bank**

1. Go to **Banking** and click **Add bank account**.
2. A **Plaid Link** window opens. Choose your bank and sign in **inside that
   window** — your bank username and password go straight to Plaid, never to
   Finora.
3. Pick which accounts to include and finish.
4. Finora pulls in those accounts and their transactions. They now show up under
   **Banking**.

![The Banking screen before you connect — click Add bank account](media/screenshots/connect-bank.png)

To change or disconnect accounts later, use **Manage accounts** (top-right of
Banking) — it reopens Plaid so the two stay in sync.

### Connect a brokerage account (through Plaid)

Investments connect the same way. If you already added your Plaid keys above, you
can skip straight to connecting.

1. Go to **Brokerage** and click **Add brokerage account**.
2. In the **Plaid Link** window, choose your brokerage and sign in there.
3. Finora imports your investment accounts and holdings, and they appear under
   **Brokerage**.

![The Brokerage screen before you connect — click Add brokerage account](media/screenshots/brokerage.png)

> Connecting a brokerage counts toward the same 10-institution Plaid free-tier
> total as banks.

### Add a credit report (PDF)

Credit reports come in as a PDF that **you** download — Finora never fetches your
report for you.

1. Go to **[AnnualCreditReport.com](https://www.annualcreditreport.com)** (the
   free, official U.S. site) and download your report as a **PDF**. Choose the
   downloadable/printable PDF, not a scan or screenshot, so the text is readable.
2. In Finora, open **Credit** and click **Manage reports**.
3. **Drop the PDF** onto the upload box, or click it to choose the file.
4. Finora reads the report on your computer and shows your open accounts,
   balances, credit-card usage, and inquiries — nothing is sent anywhere.

![Credit → Manage reports, where you upload the PDF](media/screenshots/credit-import.png)

## 4. Find your way around

Here's what each area is for.

### Banking — your accounts and spending

Your day-to-day money. See balances, income vs. spending, where your money goes
by category, and your top merchants.

![Banking overview](media/screenshots/banking.png)

Once you've connected a bank, your transactions show up here — grouped by
category and merchant so you can see your spending at a glance.

![Spending by merchant](media/screenshots/activity.png)

### Insights — what needs your attention

Finora looks over your accounts and points out things worth a glance — unusual
spending, high credit-card usage, cash sitting idle, or accounts that look out
of date. It's a quick way to spot problems without digging.

![Insights](media/screenshots/insights.png)

### Dashboards — charts from your data

Turn your numbers into simple charts, like monthly cash flow and spending by
category. You can add or hide charts without deleting any of your data.

![Dashboards](media/screenshots/dashboards.png)

### Credit — review your credit report at home

After you add a report PDF (see above), this is where you review it. Finora
highlights your open accounts, credit-card usage, inquiries, and anything that
may be worth a second look.

![Credit report review](media/screenshots/credit.png)

### Brokerage — your investments

Once connected, your holdings and balances appear here alongside your banking, so
you see everything together. Until then, this is where you start a connection.

![Brokerage](media/screenshots/brokerage.png)

### Settings — connections and alerts

Add your Plaid keys and manage connected accounts under **Bank/Brokerage**,
choose how you'd like to be notified under **Delivery**, and create alert rules
under **Rules & Insights**.

![Settings](media/screenshots/settings.png)

---

*Building Finora from source or contributing code? See
[CONTRIBUTING.md](../CONTRIBUTING.md).*
